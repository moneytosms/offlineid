/**
 * Authentication screen — drives {@link useFaceAuth} (SPEC §11, ARCHITECTURE §3.2).
 *
 * Responsibilities:
 *  - Stream camera frames into {@link useFaceAuth.processFrame} (gated to every
 *    5th frame inside the hook).
 *  - Surface phase-appropriate UI:
 *      LIVENESS    → "Hold still…"
 *      GESTURE     → animated {@link LivenessPrompt}
 *      SUCCESS     → green overlay with matched employee name
 *      FAIL        → "Not recognised" with retry
 *      LOCKED      → rejection + 30 s lock countdown (SPEC §12)
 *  - Provide the ML Kit `faceDetectorStream` the gesture step consumes.
 *
 * @module screens/AuthScreen
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { Frame } from 'react-native-vision-camera';

import { CameraView } from '../components/CameraView';
import { LivenessPrompt } from '../components/LivenessPrompt';
import { useFaceAuth } from '../hooks/useFaceAuth';
import type {
  FaceDetectorStream,
  MLKitFaceFrame,
} from '../services/LivenessService';
import { LOCKOUT_MS } from '../hooks/useFaceAuth';
import { logger } from '../utils/logger';

const TAG = 'Auth';

/**
 * Convert a VisionCamera frame to a base64 still (see {@link EnrollScreen}).
 */
function toBase64Frame(frame: Frame): string {
  return (frame as unknown as { toBase64: () => string }).toBase64();
}

/**
 * Extract an ML Kit face shape from a frame, if a face-detector frame-processor
 * plugin has attached one. Returns null when unavailable.
 */
function extractMLKitFace(frame: Frame): MLKitFaceFrame | null {
  const faces = (frame as unknown as { faces?: MLKitFaceFrame[] }).faces;
  return faces && faces.length > 0 ? faces[0] : null;
}

/** {@link AuthScreen} props. */
export interface AuthScreenProps {
  /** Device identifier written into attendance records. */
  deviceId: string;
  /** Optional GPS latitude for the attendance record. */
  locationLat?: number | null;
  /** Optional GPS longitude for the attendance record. */
  locationLon?: number | null;
}

/**
 * Live authentication screen. Auto-starts a session on mount and re-arms after
 * terminal states.
 */
export function AuthScreen({
  deviceId,
  locationLat = null,
  locationLon = null,
}: AuthScreenProps): React.JSX.Element {
  const {
    status,
    matchedEmployee,
    currentGesture,
    processFrame,
    startSession,
    resetSession,
  } = useFaceAuth();

  const [lockRemaining, setLockRemaining] = useState(0);

  // Fan-out registry for ML Kit faces → gesture stream listeners.
  const listeners = useRef(new Set<(f: MLKitFaceFrame) => void>());

  /** A {@link FaceDetectorStream} the hook's gesture step subscribes to. */
  const faceDetectorStream = useRef<FaceDetectorStream>(
    (listener: (face: MLKitFaceFrame) => void) => {
      listeners.current.add(listener);
      return () => {
        listeners.current.delete(listener);
      };
    },
  ).current;

  // Start a session on mount.
  useEffect(() => {
    startSession();
  }, [startSession]);

  // Lock countdown (SPEC §12).
  useEffect(() => {
    if (status !== 'LOCKED') {
      setLockRemaining(0);
      return;
    }
    const end = Date.now() + LOCKOUT_MS;
    setLockRemaining(Math.ceil(LOCKOUT_MS / 1000));
    const handle = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLockRemaining(remaining);
      if (remaining <= 0) {
        clearInterval(handle);
        resetSession();
        startSession();
      }
    }, 500);
    return () => clearInterval(handle);
  }, [status, resetSession, startSession]);

  const onFrame = useCallback(
    (frame: Frame): void => {
      // Push any ML Kit face to gesture listeners (active liveness).
      const face = extractMLKitFace(frame);
      if (face) {
        for (const l of listeners.current) l(face);
      }

      // Feed the orchestration hook (it internally gates + ignores when busy).
      let b64: string;
      try {
        b64 = toBase64Frame(frame);
      } catch (err) {
        logger.warn(TAG, 'frame→base64 failed', err);
        return;
      }
      void processFrame({
        base64Frame: b64,
        faceDetectorStream,
        deviceId,
        locationLat,
        locationLon,
        eventType: 'check_in',
      });
    },
    [processFrame, faceDetectorStream, deviceId, locationLat, locationLon],
  );

  const retry = useCallback((): void => {
    resetSession();
    startSession();
  }, [resetSession, startSession]);

  const isActive = status !== 'SUCCESS' && status !== 'LOCKED';

  return (
    <View style={styles.fill}>
      <CameraView onFrame={onFrame} isActive={isActive} />

      <View style={styles.overlay} pointerEvents="box-none">
        {status === 'DETECTING' && (
          <Banner text="Position your face in the frame" />
        )}

        {status === 'LIVENESS' && <Banner text="Hold still…" />}

        {status === 'RECOGNISING' && <Banner text="Recognising…" />}

        {status === 'GESTURE' && currentGesture != null && (
          <LivenessPrompt gesture={currentGesture} />
        )}

        {status === 'SUCCESS' && matchedEmployee != null && (
          <View style={[styles.card, styles.successCard]}>
            <Text style={styles.successTitle} accessibilityLiveRegion="assertive">
              ✓ Welcome, {matchedEmployee.name}
            </Text>
            <Text style={styles.successSub}>
              Match {(matchedEmployee.score * 100).toFixed(0)}%
            </Text>
            <ActionButton label="Next person" onPress={retry} />
          </View>
        )}

        {status === 'FAIL' && (
          <View style={[styles.card, styles.failCard]}>
            <Text style={styles.failTitle} accessibilityLiveRegion="assertive">
              Not recognised
            </Text>
            <ActionButton label="Try again" onPress={retry} />
          </View>
        )}

        {status === 'LOCKED' && (
          <View style={[styles.card, styles.failCard]}>
            <Text style={styles.failTitle} accessibilityLiveRegion="assertive">
              Too many attempts
            </Text>
            <Text style={styles.failSub}>
              Locked for {lockRemaining}s
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

/** Small translucent status banner. */
function Banner({ text }: { text: string }): React.JSX.Element {
  return (
    <View style={styles.banner} accessibilityLiveRegion="polite">
      <Text style={styles.bannerText}>{text}</Text>
    </View>
  );
}

/** Primary action button. */
function ActionButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.button}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 48,
  },
  banner: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 24,
  },
  bannerText: { color: '#FFF', fontSize: 18, fontWeight: '600' },
  card: {
    alignItems: 'center',
    padding: 24,
    borderRadius: 16,
    width: '88%',
  },
  successCard: { backgroundColor: 'rgba(46,125,50,0.92)' },
  failCard: { backgroundColor: 'rgba(198,40,40,0.92)' },
  successTitle: { color: '#FFF', fontSize: 24, fontWeight: '700' },
  successSub: { color: '#E8F5E9', fontSize: 14, marginTop: 4 },
  failTitle: { color: '#FFF', fontSize: 22, fontWeight: '700' },
  failSub: { color: '#FFEBEE', fontSize: 16, marginTop: 6 },
  button: {
    marginTop: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  buttonText: { color: '#111', fontSize: 16, fontWeight: '700' },
});

export default AuthScreen;
