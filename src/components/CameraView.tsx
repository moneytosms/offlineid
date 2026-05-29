/**
 * VisionCamera v4 wrapper with a frame gate and green bbox overlay
 * (SPEC §6.4, ARCHITECTURE §3.1/§3.2).
 *
 * Renders a back-or-front `Camera` and installs a `useFrameProcessor`
 * (`react-native-worklets-core`) that forwards every {@link FRAME_GATE}th frame
 * to the JS `onFrame` callback via `runOnJS`. When a `bbox` prop is supplied a
 * green (or `overlayColor`) rectangle is drawn over the live preview to signal a
 * stable detection.
 *
 * @module components/CameraView
 */

import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
  type Frame,
} from 'react-native-vision-camera';
import { useSharedValue, Worklets } from 'react-native-worklets-core';

import type { BoundingBox } from '../services/FaceEngine';

/** Process every Nth frame (SPEC §6.4). */
export const FRAME_GATE = 5;

/** Default bbox overlay colour. */
const DEFAULT_OVERLAY_COLOR = '#00E676';

/** {@link CameraView} props. */
export interface CameraViewProps {
  /** Called with each gated (every 5th) camera frame for analysis. */
  onFrame: (frame: Frame) => void;
  /** Detected face box to outline; omit/null to hide the overlay. */
  bbox?: BoundingBox | null;
  /** Overlay rectangle colour (default green `#00E676`). */
  overlayColor?: string;
  /** Use the front camera (default true — face auth/enrol). */
  front?: boolean;
  /** Whether the camera is actively streaming (default true). */
  isActive?: boolean;
}

/**
 * Live camera preview that gates frames to `onFrame` and overlays a face box.
 *
 * Renders a permission/no-device placeholder when the camera is unavailable.
 */
export function CameraView({
  onFrame,
  bbox,
  overlayColor = DEFAULT_OVERLAY_COLOR,
  front = true,
  isActive = true,
}: CameraViewProps): React.JSX.Element {
  const device = useCameraDevice(front ? 'front' : 'back');
  const { hasPermission } = useCameraPermission();

  // Frame counter lives on the worklet thread so the gate is allocation-free.
  const frameCount = useSharedValue(0);

  // `runOnJS` returns a JS-thread-callable proxy for the worklet (v1 API).
  const onFrameJS = useMemo(() => Worklets.createRunOnJS(onFrame), [onFrame]);

  const frameProcessor = useFrameProcessor(
    (frame: Frame) => {
      'worklet';
      // Frame gate: forward only every Nth frame to JS (SPEC §6.4).
      frameCount.value += 1;
      if (frameCount.value % FRAME_GATE !== 0) return;
      onFrameJS(frame);
    },
    [onFrameJS],
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
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={isActive}
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
