/**
 * Enrollment screen — 3-capture face registration (SPEC §10, ARCHITECTURE §3.1).
 *
 * Flow:
 *  1. Operator enters employeeId / name / department.
 *  2. Camera streams the ML Kit face detector to drive a green bbox. When a
 *     face is stable, the capture button enables.
 *  3. Three captures (frontal / slight-left / slight-right). Each capture takes
 *     a still via {@link CameraViewHandle.capture}, then runs
 *     {@link FaceEngine.detectFace} → {@link FaceEngine.getEmbedding}.
 *  4. The 3 embeddings are averaged and L2-normalised → enrolment vector.
 *  5. {@link EmbeddingStore.enrol} persists it; success state shown.
 *
 * @module screens/EnrollScreen
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  Vibration,
  View,
} from 'react-native';

import { CameraView } from '../components/CameraView';
import type {
  CameraViewHandle,
  DetectedFace,
} from '../components/CameraView';
import { FillLightOverlay } from '../components/FillLightOverlay';
import { FaceEngine } from '../services/FaceEngine';
import { ScreenBrightness, LUX_DIM_THRESHOLD } from '../services/ScreenBrightness';
import { PrefsStore, PREF_FILL_LIGHT_LUX, PREF_FILL_BRIGHTNESS, PREF_KEEP_AWAKE, PREF_ENROLL_VIBRATE, PREF_CAMERA_ZOOM } from '../services/PrefsStore';
import type { BoundingBox } from '../services/FaceEngine';
import { EmbeddingStore } from '../services/EmbeddingStore';
import { Button, Field, Tag } from '../ui/components';
import { colors, MONO, space, type as typo } from '../ui/theme';
import { logger } from '../utils/logger';

const TAG = 'Enroll';

/** Number of captures required (SPEC §10). */
export const REQUIRED_CAPTURES = 3;

/** Consecutive stable detections before the face is considered steady. */
const STABLE_LOCK_COUNT = 3;

/** Embedding dimensionality (MobileFaceNet, SPEC §4.2). */
const EMBEDDING_DIM = 512;

/** Per-capture human label (SPEC §10). */
const CAPTURE_LABELS = ['Look straight', 'Turn slightly left', 'Turn slightly right'];

/** L2-normalise a vector in place and return it. */
function l2Normalise(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** {@link EnrollScreen} props. */
export interface EnrollScreenProps {
  /** Called after a successful enrolment. */
  onEnrolled?: (employeeId: string) => void;
}

type Phase = 'form' | 'capturing' | 'saving' | 'done';

/**
 * Three-capture enrolment screen. Self-contained: collects identity fields,
 * captures three embeddings, averages + L2-normalises, and enrols.
 */
export function EnrollScreen({
  onEnrolled,
}: EnrollScreenProps): React.JSX.Element {
  const [employeeId, setEmployeeId] = useState('');
  const [name, setName] = useState('');
  const [department, setDepartment] = useState('');

  const [phase, setPhase] = useState<Phase>('form');
  const [bbox, setBbox] = useState<BoundingBox | null>(null);
  const [stable, setStable] = useState(false);
  const [captureIndex, setCaptureIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [lowLight, setLowLight] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const lowLightActive = useRef(false);
  const stableCount = useRef(0);
  const embeddings = useRef<Float32Array[]>([]);
  const cameraRef = useRef<CameraViewHandle>(null);

  // Prefs refs.
  const luxThreshRef = useRef(LUX_DIM_THRESHOLD);
  const brightRef = useRef(1.0);
  const enrollVibrateRef = useRef(true);
  const zoomRef = useRef(1.0);

  // Load prefs on mount.
  useEffect(() => {
    Promise.all([
      PrefsStore.getNumber(PREF_FILL_LIGHT_LUX, LUX_DIM_THRESHOLD),
      PrefsStore.getNumber(PREF_FILL_BRIGHTNESS, 1.0),
      PrefsStore.getBool(PREF_ENROLL_VIBRATE, true),
      PrefsStore.getNumber(PREF_CAMERA_ZOOM, 1.0),
    ]).then(([lux, bright, evib, zoom]) => {
      luxThreshRef.current = lux;
      brightRef.current = bright;
      enrollVibrateRef.current = evib;
      zoomRef.current = zoom;
    });
  }, []);

  // Wake lock.
  useEffect(() => {
    PrefsStore.getBool(PREF_KEEP_AWAKE, true).then(on => {
      if (on) void ScreenBrightness.acquireWakeLock();
    });
    return () => { void ScreenBrightness.releaseWakeLock(); };
  }, []);

  // Lux polling — active only during capture phase; holds brightness until
  // ambient improves, session ends, or component unmounts.
  useEffect(() => {
    if (phase !== 'capturing') return;
    const check = async () => {
      const lux = await ScreenBrightness.getLux();
      if (lux < 0) return;
      if (lux < luxThreshRef.current && !lowLightActive.current) {
        lowLightActive.current = true;
        setLowLight(true);
        void ScreenBrightness.setBrightness(brightRef.current);
      } else if (lux >= (luxThreshRef.current + 13) && lowLightActive.current) {
        lowLightActive.current = false;
        setLowLight(false);
        void ScreenBrightness.restore();
      }
    };
    const init = setTimeout(() => { void check(); }, 800);
    const id = setInterval(() => { void check(); }, 2000);
    return () => {
      clearTimeout(init);
      clearInterval(id);
      lowLightActive.current = false;
      void ScreenBrightness.restore();
    };
  }, [phase]);

  const formValid = employeeId.trim() !== '' && name.trim() !== '';

  /** Gated ML Kit face stream: drive bbox overlay + stability gate. */
  const onFaces = useCallback((faces: DetectedFace[]): void => {
    if (faces.length > 0) {
      setBbox(faces[0].bounds);
      stableCount.current += 1;
      setStable(stableCount.current >= STABLE_LOCK_COUNT);
    } else {
      setBbox(null);
      stableCount.current = 0;
      setStable(false);
    }
  }, []);

  /** Average + L2-normalise the 3 embeddings and persist (SPEC §10 step 2–3). */
  const finishEnrol = useCallback(async (): Promise<void> => {
    setPhase('saving');
    try {
      const all = embeddings.current;
      const avg = new Float32Array(EMBEDDING_DIM);
      for (const e of all) {
        for (let i = 0; i < EMBEDDING_DIM; i++) avg[i] += e[i];
      }
      for (let i = 0; i < EMBEDDING_DIM; i++) avg[i] /= all.length;
      l2Normalise(avg);

      await EmbeddingStore.enrol(
        employeeId.trim(),
        name.trim(),
        department.trim() || null,
        avg,
      );
      setPhase('done');
      onEnrolled?.(employeeId.trim());
      logger.info(TAG, `enrolled ${employeeId.trim()}`);
    } catch (err) {
      logger.error(TAG, 'enrol failed', err);
      setError('Could not save enrolment. Please retry.');
      setPhase('capturing');
    }
  }, [employeeId, name, department, onEnrolled]);

  /** Capture one embedding from a freshly-taken still. */
  const onCapture = useCallback(async (): Promise<void> => {
    const cam = cameraRef.current;
    if (!cam || !stable || isBusy) return;
    setError(null);
    // Take photo while camera is still active, before isBusy closes it.
    let b64: string;
    try {
      b64 = await cam.capture();
    } catch (err) {
      logger.error(TAG, 'capture failed', err);
      setError('Capture failed. Please try again.');
      return;
    }
    setIsBusy(true);
    try {
      const det = await FaceEngine.detectFace(b64);
      if (!det.found || !det.landmarks) {
        setError('Face lost — hold still and retry.');
        return;
      }
      const { embedding } = await FaceEngine.getEmbedding(b64, det.landmarks);
      embeddings.current.push(Float32Array.from(embedding));
      const next = embeddings.current.length;
      setCaptureIndex(next);
      if (enrollVibrateRef.current) Vibration.vibrate(40);
      stableCount.current = 0;
      setStable(false);
      logger.info(TAG, `capture ${next}/${REQUIRED_CAPTURES}`);

      if (next >= REQUIRED_CAPTURES) {
        await finishEnrol();
      }
    } catch (err) {
      logger.error(TAG, 'capture failed', err);
      setError('Capture failed. Please try again.');
    } finally {
      setIsBusy(false);
    }
  }, [stable, isBusy, finishEnrol]);

  const startCapture = useCallback((): void => {
    embeddings.current = [];
    stableCount.current = 0;
    setCaptureIndex(0);
    setStable(false);
    setBbox(null);
    setError(null);
    setPhase('capturing');
  }, []);

  const reset = useCallback((): void => {
    embeddings.current = [];
    setEmployeeId('');
    setName('');
    setDepartment('');
    setCaptureIndex(0);
    setPhase('form');
  }, []);

  const currentLabel = useMemo(
    () => CAPTURE_LABELS[Math.min(captureIndex, CAPTURE_LABELS.length - 1)],
    [captureIndex],
  );

  if (phase === 'form') {
    return (
      <ScrollView
        style={styles.formScroll}
        contentContainerStyle={styles.formContainer}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={typo.title}>Enrol</Text>
        <View style={styles.titleRule} />
        <Text style={styles.formIntro}>
          Register a person’s faceprint with three captures.
        </Text>

        <Field
          label="Employee ID"
          value={employeeId}
          onChangeText={setEmployeeId}
          placeholder="e.g. NHAI-0481"
          autoCapitalize="characters"
        />
        <Field
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="Full name"
        />
        <Field
          label="Department"
          value={department}
          onChangeText={setDepartment}
          placeholder="Optional"
        />
        <Button
          label="Begin capture"
          onPress={startCapture}
          disabled={!formValid}
          style={styles.formBtn}
        />
      </ScrollView>
    );
  }

  if (phase === 'done') {
    return (
      <View style={styles.center}>
        <View style={styles.doneRing}>
          <Text style={styles.doneCheck}>✓</Text>
        </View>
        <Text style={styles.doneTitle} accessibilityLiveRegion="assertive">
          Enrolled
        </Text>
        <Text style={styles.doneName}>{name.trim()}</Text>
        <Button label="Enrol another" onPress={reset} style={styles.doneBtn} />
      </View>
    );
  }

  // capturing / saving
  return (
    <View style={styles.fill}>
      <CameraView
        ref={cameraRef}
        onFaces={onFaces}
        bbox={bbox}
        isActive={phase === 'capturing' && !isBusy}
        zoom={zoomRef.current}
      />

      {/* Fill-light overlay — white panels around the oval in low light. */}
      {lowLight && <FillLightOverlay />}

      {/* Scanner reticle. */}
      <View style={styles.reticleWrap} pointerEvents="none">
        <View style={[styles.reticle, stable && styles.reticleLocked]} />
      </View>

      <View style={styles.topBar} pointerEvents="none">
        <Tag tone={stable ? 'accent' : 'muted'}>
          {stable ? 'FACE LOCKED' : 'ALIGN FACE'}
        </Tag>
      </View>

      <View style={styles.overlay} pointerEvents="box-none">
        {/* Capture progress dots. */}
        <View style={styles.dots}>
          {Array.from({ length: REQUIRED_CAPTURES }).map((_, i) => (
            <View
              key={i}
              style={[styles.dot, i < captureIndex && styles.dotFilled]}
            />
          ))}
        </View>

        <Text style={styles.captureHint} accessibilityLiveRegion="polite">
          {currentLabel}
        </Text>
        <Text style={styles.captureCount}>
          {captureIndex}/{REQUIRED_CAPTURES} captured
        </Text>
        {error != null && <Text style={styles.error}>{error}</Text>}

        {phase === 'saving' ? (
          <View style={styles.savingRow}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.savingText}>SAVING FACEPRINT…</Text>
          </View>
        ) : (
          <Button
            label={stable ? `Capture ${captureIndex + 1}` : 'Hold still…'}
            onPress={onCapture}
            disabled={!stable}
            style={styles.captureBtn}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    backgroundColor: colors.bg,
  },
  formScroll: { flex: 1, backgroundColor: colors.bg },
  formContainer: { padding: space.xl, paddingBottom: space.xxxl, flexGrow: 1 },
  titleRule: {
    marginTop: space.md,
    height: 2,
    width: 40,
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
  formIntro: { ...typo.muted, marginTop: space.lg, marginBottom: space.xl },
  formBtn: { marginTop: space.md },

  // Done state.
  doneRing: {
    width: 92,
    height: 92,
    borderRadius: 46,
    borderWidth: 2,
    borderColor: colors.accent,
    backgroundColor: colors.accentGlow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneCheck: { color: colors.accent, fontSize: 48, fontWeight: '800' },
  doneTitle: {
    ...typo.label,
    color: colors.accent,
    marginTop: space.xl,
    fontSize: 13,
  },
  doneName: { ...typo.title, marginTop: space.xs },
  doneBtn: { marginTop: space.xxl, alignSelf: 'stretch' },

  // Capture overlay.
  reticleWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  reticle: {
    width: 240,
    height: 300,
    borderRadius: 140,
    borderWidth: 2,
    borderColor: 'rgba(141,163,155,0.5)',
    borderStyle: 'dashed',
  },
  reticleLocked: { borderColor: colors.accent, borderStyle: 'solid' },
  topBar: { position: 'absolute', top: space.xl, left: 0, right: 0, alignItems: 'center' },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.xl,
    paddingBottom: space.xxl,
    alignItems: 'center',
    backgroundColor: 'rgba(10,14,13,0.55)',
  },
  dots: { flexDirection: 'row', gap: space.sm, marginBottom: space.lg },
  dot: {
    width: 28,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.lineBright,
  },
  dotFilled: { backgroundColor: colors.accent },
  captureHint: { color: colors.text, fontSize: 18, fontWeight: '700' },
  captureCount: { color: colors.textDim, fontFamily: MONO, fontSize: 12, marginTop: 4 },
  error: { color: colors.danger, fontSize: 13, marginTop: space.sm, textAlign: 'center' },
  captureBtn: { marginTop: space.lg, alignSelf: 'stretch' },
  savingRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.lg },
  savingText: { color: colors.accent, fontFamily: MONO, fontSize: 12, letterSpacing: 1 },
});

export default EnrollScreen;
