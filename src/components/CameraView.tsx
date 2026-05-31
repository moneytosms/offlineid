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
import { logger } from '../utils/logger';

const TAG = 'CameraView';

/** Process every Nth frame (SPEC §6.4). */
export const FRAME_GATE = 5;

/**
 * How many consecutive no-face gated frames before signalling low light.
 * At FRAME_GATE=5 and ~30fps camera: 30 processed frames ≈ 5 seconds.
 */
const NO_FACE_LOW_LIGHT_FRAMES = 30;

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
   * Called when the low-light state changes. Fires with `true` after
   * {@link NO_FACE_LOW_LIGHT_FRAMES} consecutive empty-detection gated frames
   * (ML Kit can't find a face → likely too dark), and with `false` as soon as
   * a face is detected again. Parent should boost screen brightness and show a
   * fill-light overlay in response.
   */
  onLowLight?: (isLow: boolean) => void;
}

/** No-op face sink (default when no `onFaces` is supplied). */
function noopFaces(_faces: DetectedFace[]): void {}

/** No-op low-light sink. */
function noopLowLight(_isLow: boolean): void {}

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
    onLowLight,
  }: CameraViewProps,
  ref: React.Ref<CameraViewHandle>,
): React.JSX.Element {
  const device = useCameraDevice(front ? 'front' : 'back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const camera = useRef<Camera>(null);

  // Frame counter lives on the worklet thread so the gate is allocation-free.
  const frameCount = useSharedValue(0);

  // Consecutive gated frames with no face detected — used for low-light signal.
  const noFaceCount = useSharedValue(0);

  // Whether we have already fired onLowLight(true) — avoids repeated calls.
  const lowLightFired = useSharedValue(false);

  const onLowLightJS = useMemo(
    () => Worklets.createRunOnJS(onLowLight ?? noopLowLight),
    [onLowLight],
  );

  // When camera stops, reset low-light state so it re-arms on next session.
  useEffect(() => {
    if (!isActive) {
      noFaceCount.value = 0;
      if (lowLightFired.value) {
        lowLightFired.value = false;
        onLowLightJS(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

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

      // Frame gate: forward only every Nth frame to JS (SPEC §6.4).
      if (frameCount.value % FRAME_GATE !== 0) return;

      // Map detector faces inline.
      const faces = detectFaces(frame);
      const out: DetectedFace[] = [];
      for (let i = 0; i < faces.length; i++) {
        const f = faces[i];
        out.push({
          leftEyeOpenProbability: f.leftEyeOpenProbability,
          rightEyeOpenProbability: f.rightEyeOpenProbability,
          headEulerAngleY: f.yawAngle,
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

      // Low-light detection: if ML Kit can't find a face for enough consecutive
      // gated frames, assume the scene is too dark and signal the parent.
      if (faces.length === 0) {
        noFaceCount.value += 1;
        if (
          noFaceCount.value >= NO_FACE_LOW_LIGHT_FRAMES &&
          !lowLightFired.value
        ) {
          lowLightFired.value = true;
          onLowLightJS(true);
        }
      } else {
        if (lowLightFired.value) {
          // Face found — scene is bright enough; cancel the low-light boost.
          lowLightFired.value = false;
          onLowLightJS(false);
        }
        noFaceCount.value = 0;
      }
    },
    [onFacesJS, detectFaces, onLowLightJS],
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
