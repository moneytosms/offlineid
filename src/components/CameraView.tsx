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
 * How many consecutive no-face gated frames before the parent should consider
 * the scene dark (export so screens can use the same constant).
 * At FRAME_GATE=5 and ~30fps camera: 30 processed frames ≈ 5 seconds.
 */
export const NO_FACE_LOW_LIGHT_FRAMES = 30;

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
  /** Camera zoom level (default 1.0). */
  zoom?: number;
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
    zoom = 1.0,
  }: CameraViewProps,
  ref: React.Ref<CameraViewHandle>,
): React.JSX.Element {
  const device = useCameraDevice(front ? 'front' : 'back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const camera = useRef<Camera>(null);

  // Frame counter lives on the worklet thread so the gate is allocation-free.
  const frameCount = useSharedValue(0);

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

  // Stable mutable ref — updated every render, never triggers worklet rebuild.
  const onFacesRef = useRef<(faces: DetectedFace[]) => void>(noopFaces);
  onFacesRef.current = onFaces ?? noopFaces;

  // Stable JS-thread dispatcher — [] deps so it never recreates.
  // Mapping happens here (JS thread), keeping the worklet allocation-free.
  const stableDispatch = useCallback((rawFaces: any[]) => {
    const out: DetectedFace[] = [];
    for (let i = 0; i < rawFaces.length; i++) {
      const f = rawFaces[i];
      out.push({
        leftEyeOpenProbability: f.leftEyeOpenProbability,
        rightEyeOpenProbability: f.rightEyeOpenProbability,
        headEulerAngleY: f.yawAngle,
        smilingProbability: f.smilingProbability,
        bounds: { x: f.bounds.x, y: f.bounds.y, w: f.bounds.width, h: f.bounds.height },
      });
    }
    onFacesRef.current(out);
  }, []); // intentionally []

  // `runOnJS` wrapper — stable because stableDispatch never changes.
  const onFacesJS = useMemo(
    () => Worklets.createRunOnJS(stableDispatch),
    [stableDispatch],
  );

  useEffect(() => {
    if (!hasPermission) {
      void requestPermission();
    }
  }, [hasPermission, requestPermission]);

  // Minimal worklet: detect + dispatch only, no object creation.
  // Both deps are stable so this worklet is never torn down mid-stream.
  const frameProcessor = useFrameProcessor(
    (frame: Frame) => {
      'worklet';
      frameCount.value += 1;
      if (frameCount.value % FRAME_GATE !== 0) return;
      onFacesJS(detectFaces(frame));
    },
    [onFacesJS, detectFaces],
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
        zoom={zoom}
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
