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
 *  - Provide the ML Kit `faceDetectorStream` the gesture step consumes from the
 *    {@link CameraView} face stream.
 *
 * @module screens/AuthScreen
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { CameraView } from '../components/CameraView';
import type {
  CameraViewHandle,
  DetectedFace,
} from '../components/CameraView';
import { LivenessPrompt } from '../components/LivenessPrompt';
import { useFaceAuth } from '../hooks/useFaceAuth';
import type {
  FaceDetectorStream,
  MLKitFaceFrame,
} from '../services/LivenessService';
import { LOCKOUT_MS } from '../hooks/useFaceAuth';
import { Button, Mono } from '../ui/components';
import { colors, MONO, radius, space } from '../ui/theme';

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
    processDetection,
    startSession,
    resetSession,
  } = useFaceAuth();

  const [lockRemaining, setLockRemaining] = useState(0);

  // Ref to the camera for on-demand still capture.
  const cameraRef = useRef<CameraViewHandle>(null);

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

  const onFaces = useCallback(
    (faces: DetectedFace[]): void => {
      const face: MLKitFaceFrame | null = faces.length > 0 ? faces[0] : null;

      // Push the current face to gesture listeners (active liveness).
      if (face) {
        for (const l of listeners.current) l(face);
      }

      // Feed the orchestration hook (it gates on stability + ignores when busy).
      void processDetection({
        face,
        capture: () => {
          const cam = cameraRef.current;
          if (cam == null) return Promise.reject(new Error('Camera not ready'));
          return cam.capture();
        },
        faceDetectorStream,
        deviceId,
        locationLat,
        locationLon,
        eventType: 'check_in',
      });
    },
    [processDetection, faceDetectorStream, deviceId, locationLat, locationLon],
  );

  const retry = useCallback((): void => {
    resetSession();
    startSession();
  }, [resetSession, startSession]);

  const isActive = status !== 'SUCCESS' && status !== 'LOCKED';

  // Reticle colour by phase.
  const reticleTone =
    status === 'SUCCESS'
      ? colors.accent
      : status === 'FAIL' || status === 'LOCKED'
      ? colors.danger
      : status === 'DETECTING'
      ? 'rgba(141,163,155,0.5)'
      : colors.accent;

  const scanLabel = SCAN_LABELS[status];

  return (
    <View style={styles.fill}>
      <CameraView ref={cameraRef} onFaces={onFaces} isActive={isActive} />

      {/* Scanner reticle. */}
      <View style={styles.reticleWrap} pointerEvents="none">
        <View style={[styles.reticle, { borderColor: reticleTone }]} />
      </View>

      {/* Top status readout. */}
      {scanLabel != null && (
        <View style={styles.topBar} pointerEvents="none">
          <View style={styles.statusChip}>
            <View style={[styles.statusDot, { backgroundColor: reticleTone }]} />
            <Mono style={styles.statusText}>{scanLabel}</Mono>
          </View>
        </View>
      )}

      <View style={styles.overlay} pointerEvents="box-none">
        {status === 'GESTURE' && currentGesture != null && (
          <LivenessPrompt gesture={currentGesture} />
        )}

        {status === 'SUCCESS' && matchedEmployee != null && (
          <View style={[styles.card, styles.successCard]}>
            <View style={styles.resultRing}>
              <Text style={styles.resultCheck}>✓</Text>
            </View>
            <Text style={styles.welcomeKicker}>ACCESS GRANTED</Text>
            <Text style={styles.successName} accessibilityLiveRegion="assertive">
              {matchedEmployee.name}
            </Text>
            <Mono style={styles.matchScore}>
              MATCH {(matchedEmployee.score * 100).toFixed(0)}%
            </Mono>
            <Button label="Next person" onPress={retry} style={styles.cardBtn} />
          </View>
        )}

        {status === 'FAIL' && (
          <View style={[styles.card, styles.failCard]}>
            <Text style={styles.failTitle} accessibilityLiveRegion="assertive">
              Not recognised
            </Text>
            <Text style={styles.failSub}>No enrolled match or liveness failed</Text>
            <Button
              label="Try again"
              variant="secondary"
              onPress={retry}
              style={styles.cardBtn}
            />
          </View>
        )}

        {status === 'LOCKED' && (
          <View style={[styles.card, styles.failCard]}>
            <Text style={styles.failTitle} accessibilityLiveRegion="assertive">
              Locked
            </Text>
            <Text style={styles.failSub}>Too many attempts</Text>
            <Mono style={styles.lockTimer}>{lockRemaining}s</Mono>
          </View>
        )}
      </View>
    </View>
  );
}

/** Per-phase status readout (null where a full card/prompt takes over). */
const SCAN_LABELS: Record<string, string | null> = {
  IDLE: 'STANDBY',
  DETECTING: 'ACQUIRING FACE',
  LIVENESS: 'VERIFYING LIVENESS',
  GESTURE: null,
  RECOGNISING: 'MATCHING IDENTITY',
  SUCCESS: null,
  FAIL: null,
  LOCKED: null,
};

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  reticleWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticle: {
    width: 250,
    height: 310,
    borderRadius: 150,
    borderWidth: 2,
  },
  topBar: { position: 'absolute', top: space.xl, left: 0, right: 0, alignItems: 'center' },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: 'rgba(10,14,13,0.8)',
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { color: colors.text, fontSize: 11, letterSpacing: 1.5 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: space.xxxl,
    paddingHorizontal: space.xl,
  },
  card: {
    alignItems: 'center',
    padding: space.xl,
    borderRadius: radius.lg,
    width: '100%',
    borderWidth: StyleSheet.hairlineWidth,
  },
  successCard: { backgroundColor: 'rgba(10,14,13,0.92)', borderColor: colors.accent },
  failCard: { backgroundColor: 'rgba(10,14,13,0.92)', borderColor: 'rgba(255,82,82,0.5)' },
  resultRing: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2,
    borderColor: colors.accent,
    backgroundColor: colors.accentGlow,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.md,
  },
  resultCheck: { color: colors.accent, fontSize: 34, fontWeight: '800' },
  welcomeKicker: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    fontFamily: MONO,
  },
  successName: { color: colors.text, fontSize: 24, fontWeight: '800', marginTop: space.xs },
  matchScore: { color: colors.textDim, fontSize: 12, marginTop: space.xs },
  failTitle: { color: colors.danger, fontSize: 22, fontWeight: '800' },
  failSub: { color: colors.textDim, fontSize: 14, marginTop: space.xs },
  lockTimer: { color: colors.danger, fontSize: 28, fontWeight: '800', marginTop: space.md },
  cardBtn: { marginTop: space.lg, alignSelf: 'stretch' },
});

export default AuthScreen;
