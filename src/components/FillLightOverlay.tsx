/**
 * White fill-light panels rendered around the face oval when the scene is dark.
 *
 * Splits the container into four white rectangles that surround the face oval,
 * leaving the oval area transparent so the camera preview and reticle remain
 * visible. Uses `onLayout` to measure the actual container size (accounting for
 * header and tab bar) rather than the full window dimensions.
 *
 * @module components/FillLightOverlay
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';

const FILL = 'rgba(255,255,255,0.92)';

/** FillLightOverlay props. */
export interface FillLightOverlayProps {
  /** Width of the face oval reticle in the camera view (default 250). */
  ovalWidth?: number;
  /** Height of the face oval reticle in the camera view (default 310). */
  ovalHeight?: number;
}

/**
 * Four white panels that frame the center oval, maximising the lit area while
 * keeping the viewfinder and reticle unobstructed.
 *
 * Render this **above** the CameraView but **below** the reticle + UI overlays.
 * Oval dimensions default to the AuthScreen reticle (250 × 310); pass explicit
 * values for other camera views (e.g. EnrollScreen uses 240 × 300).
 */
export function FillLightOverlay({
  ovalWidth = 250,
  ovalHeight = 310,
}: FillLightOverlayProps): React.JSX.Element {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const onLayout = (e: LayoutChangeEvent): void => {
    const { width, height } = e.nativeEvent.layout;
    setSize({ width, height });
  };

  return (
    <View style={StyleSheet.absoluteFillObject} onLayout={onLayout} pointerEvents="none">
      {size != null && (() => {
        const cx = size.width / 2;
        const cy = size.height / 2;
        const halfW = ovalWidth / 2;
        const halfH = ovalHeight / 2;
        return (
          <>
            {/* Top panel */}
            <View
              style={{
                position: 'absolute',
                top: 0, left: 0, right: 0,
                height: Math.max(0, cy - halfH),
                backgroundColor: FILL,
              }}
            />
            {/* Bottom panel */}
            <View
              style={{
                position: 'absolute',
                top: cy + halfH, left: 0, right: 0, bottom: 0,
                backgroundColor: FILL,
              }}
            />
            {/* Left panel (middle row only, avoids double-covering corners) */}
            <View
              style={{
                position: 'absolute',
                top: cy - halfH, left: 0,
                width: Math.max(0, cx - halfW),
                height: halfH * 2,
                backgroundColor: FILL,
              }}
            />
            {/* Right panel */}
            <View
              style={{
                position: 'absolute',
                top: cy - halfH, right: 0,
                width: Math.max(0, cx - halfW),
                height: halfH * 2,
                backgroundColor: FILL,
              }}
            />
          </>
        );
      })()}
    </View>
  );
}

export default FillLightOverlay;
