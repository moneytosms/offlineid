/**
 * Animated active-liveness instruction widget (SPEC §9.2).
 *
 * Given a {@link Gesture} it shows a short instruction plus an animated icon:
 *  - `BLINK`  — eye glyph fading in/out (simulated blink).
 *  - `TURN_LEFT` / `TURN_RIGHT` — arrow sliding to the indicated side.
 *  - `SMILE`  — smile glyph with a gentle pulse.
 *
 * Animations use the React Native `Animated` API (no native deps) and loop
 * until the prompt unmounts or `gesture` changes.
 *
 * @module components/LivenessPrompt
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import type { Gesture } from '../services/LivenessService';

/** {@link LivenessPrompt} props. */
export interface LivenessPromptProps {
  /** Gesture to instruct the user to perform. */
  gesture: Gesture;
}

/** Per-gesture copy + glyph. */
const GESTURE_UI: Record<Gesture, { text: string; glyph: string }> = {
  BLINK: { text: 'Blink your eyes', glyph: '\u{1F441}' }, // eye
  TURN_LEFT: { text: 'Turn your head left', glyph: '←' }, // ←
  TURN_RIGHT: { text: 'Turn your head right', glyph: '→' }, // →
  SMILE: { text: 'Please smile', glyph: '\u{1F642}' }, // slight smile
};

/**
 * Animated instruction for the prompted gesture. Accessible: announces the
 * instruction text via an `alert` live region.
 */
export function LivenessPrompt({
  gesture,
}: LivenessPromptProps): React.JSX.Element {
  const anim = useRef(new Animated.Value(0)).current;
  const ui = GESTURE_UI[gesture];

  useEffect(() => {
    anim.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: 0,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [anim, gesture]);

  // Map the 0..1 driver onto a per-gesture transform/opacity.
  const animatedStyle =
    gesture === 'BLINK'
      ? { opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.15] }) }
      : gesture === 'SMILE'
      ? {
          transform: [
            {
              scale: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [1, 1.25],
              }),
            },
          ],
        }
      : {
          // TURN_LEFT / TURN_RIGHT: slide the arrow toward its side.
          transform: [
            {
              translateX: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [0, gesture === 'TURN_LEFT' ? -16 : 16],
              }),
            },
          ],
        };

  return (
    <View
      style={styles.container}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={ui.text}
    >
      <Animated.Text
        style={[styles.glyph, animatedStyle]}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {ui.glyph}
      </Animated.Text>
      <Text style={styles.text}>{ui.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  glyph: {
    fontSize: 48,
    marginBottom: 8,
  },
  text: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '600',
    textAlign: 'center',
  },
});

export default LivenessPrompt;
