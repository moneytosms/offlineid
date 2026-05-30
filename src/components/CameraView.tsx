/**
 * VisionCamera v4 wrapper: continuous ML Kit face stream + on-demand still
 * capture (SPEC §6.4, ARCHITECTURE §3.1/§3.2).
 *
 * Two channels, by design (see {@link ../../ANDROID_PHONE_TESTING.md}):
 *  - **Cheap continuous stream** — a `react-native-vision-camera-face-detector`
 *    frame processor runs every {@link FRAME_GATE}th frame and forwards mapped
 *    {@link DetectedFace}s to `onFaces`. Drives the bbox overlay, the
 *    presence/stability gate, and active-liveness gestures. No base64, no ONNX.
 *  - **On-demand still** — `capture()` (exposed via ref) takes a JPEG photo and
 *    returns it base64-encoded for the native ONNX engine. Heavy work runs once
 *    per attempt, not per frame, keeping the recogniser within the latency
 *    budget on mid-range devices.
 *
 * @module components/CameraView
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
  type Frame,
} from 'react-native-vision-camera';
import {
  useFaceDetector,
  type FrameFaceDetectionOptions,
} from 'react-native-vision-camera-face-detector';
import { useSharedValue, Worklets } from 'react-native-worklets-core';
import RNFS from 'react-native-fs';

import type { BoundingBox } from '../services/FaceEngine';
import type { MLKitFaceFrame } from '../services/LivenessService';
import { ScreenBrightness } from '../services/ScreenBrightness';
import { logger } from '../utils/logger';

const TAG = 'CameraView';

/** Process every Nth frame (SPEC §6.4). */
export const FRAME_GATE = 5;

/**
 * Sample mean luminance every Nth frame for the low-light brightness boost.
 * Coarser than {@link FRAME_GATE}: reading the frame buffer is heavier than the
 * face stream, and ambient light changes slowly.
 */
const LUMA_GATE = 30;

/** Sample 1 of every N Y-plane bytes when averaging luminance (cheap estimate). */
const LUMA_STRIDE = 64;

/** Mean Y (0–255) below this = dark → boost screen to act as a fill light. */
const LUMA_LOW = 55;

/** Mean Y above this (hysteresis gap vs {@link LUMA_LOW}) = restore brightness. */
const LUMA_HIGH = 90;

/** Default bbox overlay colour. */
const DEFAULT_OVERLAY_COLOR = '#00E676';

/**
 * A face emitted to {@link CameraViewProps.onFaces}: the gesture fields the
 * {@link MLKitFaceFrame} consumes plus the on-screen `bounds` for the overlay.
 */
export interface DetectedFace extends MLKitFaceFrame {
  /** Face box in view coordinates (autoMode scales to the window). */
  bounds: BoundingBox;
}

/** Imperative handle exposed by {@link CameraView}. */
export interface CameraViewHandle {
  /**
   * Capture a still and return it base64-encoded (JPEG). Rejects if the camera
   * is not ready.
   */
  capture: () => Promise<string>;
}

/** {@link CameraView} props. */
export interface CameraViewProps {
  /** Called with the mapped faces of each gated (every 5th) frame. */
  onFaces?: (faces: DetectedFace[]) => void;
  /** Detected face box to outline; omit/null to hide the overlay. */
  bbox?: BoundingBox | null;
  /** Overlay rectangle colour (default green `#00E676`). */
  overlayColor?: string;
  /** Use the front camera (default true — face auth/enrol). */
  front?: boolean;
  /** Whether the camera is actively streaming (default true). */
  isActive?: boolean;
  /**
   * Auto-max screen brightness in low light so the display lights the subject's
   * face (default true). Restored when the scene brightens or the camera stops.
   */
  autoBrightness?: boolean;
}

/** No-op face sink (default when no `onFaces` is supplied). */
function noopFaces(_faces: DetectedFace[]): void {}

/**
 * Live camera preview that streams faces to `onFaces` and captures stills via
 * the `capture()` ref. Renders a permission/no-device placeholder when the
 * camera is unavailable.
 */
function CameraViewInner(
  {
    onFaces,
    bbox,
    overlayColor = DEFAULT_OVERLAY_COLOR,
    front = true,
    isActive = true,
    autoBrightness = true,
  }: CameraViewProps,
  ref: React.Ref<CameraViewHandle>,
): React.JSX.Element {
  const device = useCameraDevice(front ? 'front' : 'back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const camera = useRef<Camera>(null);

  // Frame counter lives on the worklet thread so the gate is allocation-free.
  const frameCount = useSharedValue(0);

  // Whether the screen is currently boosted for low light (JS thread).
  const boosted = useRef(false);

  /** Apply hysteresis on a luminance sample: boost when dark, restore when bright. */
  const onLuma = useCallback(
    (avgLuma: number): void => {
      if (!autoBrightness) return;
      if (!boosted.current && avgLuma < LUMA_LOW) {
        boosted.current = true;
        void ScreenBrightness.setBrightness(1);
        logger.debug(TAG, `low light (luma=${avgLuma.toFixed(0)}) → brightness max`);
      } else if (boosted.current && avgLuma > LUMA_HIGH) {
        boosted.current = false;
        void ScreenBrightness.restore();
        logger.debug(TAG, `light ok (luma=${avgLuma.toFixed(0)}) → brightness restored`);
      }
    },
    [autoBrightness],
  );

  const onLumaJS = useMemo(() => Worklets.createRunOnJS(onLuma), [onLuma]);

  // Restore brightness when the camera stops, auto-boost is disabled, or unmounts.
  useEffect(() => {
    if ((!isActive || !autoBrightness) && boosted.current) {
      boosted.current = false;
      void ScreenBrightness.restore();
    }
  }, [isActive, autoBrightness]);

  useEffect(
    () => () => {
      if (boosted.current) {
        boosted.current = false;
        void ScreenBrightness.restore();
      }
    },
    [],
  );

  // Detector options must be referentially stable (the hook memoises on them).
  const detectorOptions = useMemo<FrameFaceDetectionOptions>(
    () => ({
      performanceMode: 'fast',
      classificationMode: 'all', // smiling + eyes-open probabilities (gestures)
      contourMode: 'none',
      landmarkMode: 'none',
      cameraFacing: front ? 'front' : 'back',
      autoMode: true,
      windowWidth: Dimensions.get('window').width,
      windowHeight: Dimensions.get('window').height,
    }),
    [front],
  );
  const { detectFaces } = useFaceDetector(detectorOptions);

  // `runOnJS` returns a JS-thread-callable proxy for the worklet (v1 API).
  const onFacesJS = useMemo(
    () => Worklets.createRunOnJS(onFaces ?? noopFaces),
    [onFaces],
  );

  useEffect(() => {
    if (!hasPermission) {
      void requestPermission();
    }
  }, [hasPermission, requestPermission]);

  const frameProcessor = useFrameProcessor(
    (frame: Frame) => {
      'worklet';
      frameCount.value += 1;

      // Low-light sampling: average a sparse set of Y-plane (luminance) bytes
      // on a coarse cadence and hand the mean to JS, which decides whether to
      // boost the screen. Guarded by `autoBrightness`; reads the buffer only
      // every LUMA_GATE frames to keep the worklet cheap.
      if (autoBrightness && frameCount.value % LUMA_GATE === 0) {
        const buffer = frame.toArrayBuffer();
        const data = new Uint8Array(buffer);
        const ySize = Math.min(frame.width * frame.height, data.length);
        let sum = 0;
        let n = 0;
        for (let i = 0; i < ySize; i += LUMA_STRIDE) {
          sum += data[i];
          n += 1;
        }
        if (n > 0) onLumaJS(sum / n);
      }

      // Frame gate: forward only every Nth frame to JS (SPEC §6.4).
      if (frameCount.value % FRAME_GATE !== 0) return;

      // Map detector faces inline — referencing a separate worklet here makes
      // worklets-core emit malformed JS ("invalid empty parentheses").
      const faces = detectFaces(frame);
      const out: DetectedFace[] = [];
      for (let i = 0; i < faces.length; i++) {
        const f = faces[i];
        out.push({
          leftEyeOpenProbability: f.leftEyeOpenProbability,
          rightEyeOpenProbability: f.rightEyeOpenProbability,
          headEulerAngleY: f.yawAngle, // ML Kit yaw → gesture field
          smilingProbability: f.smilingProbability,
          bounds: {
            x: f.bounds.x,
            y: f.bounds.y,
            w: f.bounds.width,
            h: f.bounds.height,
          },
        });
      }
      onFacesJS(out);
    },
    [onFacesJS, detectFaces, onLumaJS, autoBrightness],
  );

  useImperativeHandle(
    ref,
    () => ({
      async capture(): Promise<string> {
        const cam = camera.current;
        if (cam == null) {
          throw new Error('Camera not ready');
        }
        const photo = await cam.takePhoto({
          flash: 'off',
          enableShutterSound: false,
        });
        try {
          return await RNFS.readFile(photo.path, 'base64');
        } finally {
          // Best-effort cleanup; a leaked temp file must not fail the capture.
          void RNFS.unlink(photo.path).catch((err) =>
            logger.debug(TAG, 'temp photo unlink failed', err),
          );
        }
      },
    }),
    [],
  );

  const overlayStyle = useMemo(
    () =>
      bbox
        ? {
            left: bbox.x,
            top: bbox.y,
            width: bbox.w,
            height: bbox.h,
            borderColor: overlayColor,
          }
        : null,
    [bbox, overlayColor],
  );

  if (!hasPermission || device == null) {
    return (
      <View
        style={[styles.fill, styles.placeholder]}
        accessibilityRole="image"
        accessibilityLabel={
          !hasPermission ? 'Camera permission required' : 'No camera available'
        }
      />
    );
  }

  return (
    <View style={styles.fill}>
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={isActive}
        photo={true}
        pixelFormat="yuv"
        frameProcessor={frameProcessor}
        accessibilityLabel="Camera preview"
      />
      {overlayStyle != null && (
        <View
          style={[styles.bbox, overlayStyle]}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      )}
    </View>
  );
}

/**
 * Live camera preview. Forward a {@link CameraViewHandle} ref to call
 * `capture()` for an on-demand base64 still.
 */
export const CameraView = forwardRef(CameraViewInner);

const styles = StyleSheet.create({
  fill: { flex: 1 },
  placeholder: { backgroundColor: '#000' },
  bbox: {
    position: 'absolute',
    borderWidth: 3,
    borderRadius: 8,
  },
});

export default CameraView;
