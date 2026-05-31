/**
 * White fill-light panels rendered around the face oval when the scene is dark.
 *
 * Splits the screen into four white rectangles that surround the 250×310
 * reticle oval, leaving the oval area transparent so the camera preview and
 * reticle remain visible. The phone display acting as a bright white ring-light
 * illuminates the subject's face without obscuring the viewfinder.
 *
 * @module components/FillLightOverlay
 */

import React from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';

/** Half-dimensions of the face oval used in AuthScreen / EnrollScreen. */
const OVAL_HALF_W = 125; // 250 / 2
const OVAL_HALF_H = 155; // 310 / 2

const { width: SW, height: SH } = Dimensions.get('window');
const CX = SW / 2;
const CY = SH / 2;

/**
 * Four white panels that frame the center oval, maximising the lit area while
 * keeping the viewfinder and reticle unobstructed.
 *
 * Render this **above** the CameraView but **below** the reticle + UI overlays.
 */
export function FillLightOverlay(): React.JSX.Element {
  return (
    <>
      {/* Top panel */}
      <View style={styles.top} pointerEvents="none" />
      {/* Bottom panel */}
      <View style={styles.bottom} pointerEvents="none" />
      {/* Left panel (middle row only, avoids double-covering corners) */}
      <View style={styles.left} pointerEvents="none" />
      {/* Right panel */}
      <View style={styles.right} pointerEvents="none" />
    </>
  );
}

const FILL = 'rgba(255,255,255,0.92)';

const styles = StyleSheet.create({
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: CY - OVAL_HALF_H,
    backgroundColor: FILL,
  },
  bottom: {
    position: 'absolute',
    top: CY + OVAL_HALF_H,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: FILL,
  },
  left: {
    position: 'absolute',
    top: CY - OVAL_HALF_H,
    left: 0,
    width: CX - OVAL_HALF_W,
    height: OVAL_HALF_H * 2,
    backgroundColor: FILL,
  },
  right: {
    position: 'absolute',
    top: CY - OVAL_HALF_H,
    right: 0,
    width: CX - OVAL_HALF_W,
    height: OVAL_HALF_H * 2,
    backgroundColor: FILL,
  },
});
