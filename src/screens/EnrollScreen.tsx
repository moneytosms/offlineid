/**
 * Enrollment screen — 3-capture face registration (SPEC §10, ARCHITECTURE §3.1).
 *
 * Flow:
 *  1. Operator enters employeeId / name / department.
 *  2. Camera streams; every 5th frame runs SCRFD detection to drive a green
 *     bbox. When a face is stable, the capture button enables.
 *  3. Three captures (frontal / slight-left / slight-right). Each capture runs
 *     {@link FaceEngine.detectFace} → {@link FaceEngine.getEmbedding}.
 *  4. The 3 embeddings are averaged and L2-normalised → enrolment vector.
 *  5. {@link EmbeddingStore.enrol} persists it; success state shown.
 *
 * Frame → base64: the live preview frame processor only yields the bbox; the
 * actual embedding captures use {@link toBase64Frame} on the gated frame so we
 * feed the native engine a full still.
 *
 * @module screens/EnrollScreen
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { Frame } from 'react-native-vision-camera';

import { CameraView } from '../components/CameraView';
import { FaceEngine } from '../services/FaceEngine';
import type { BoundingBox } from '../services/FaceEngine';
import { EmbeddingStore } from '../services/EmbeddingStore';
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

/**
 * Convert a VisionCamera frame to a base64 still for the native engine.
 *
 * VisionCamera does not expose JPEG/base64 directly on the JS frame object; in
 * this build the companion frame-processor plugin attaches `.toBase64()`. The
 * cast keeps the screen decoupled from the plugin's ambient typings.
 */
function toBase64Frame(frame: Frame): string {
  return (frame as unknown as { toBase64: () => string }).toBase64();
}

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

  const stableCount = useRef(0);
  const busy = useRef(false);
  const embeddings = useRef<Float32Array[]>([]);
  const lastFrame = useRef<Frame | null>(null);

  const formValid = employeeId.trim() !== '' && name.trim() !== '';

  /** Gated live frame: detect face, update bbox + stability. */
  const onFrame = useCallback(async (frame: Frame): Promise<void> => {
    lastFrame.current = frame;
    if (busy.current) return;
    busy.current = true;
    try {
      const det = await FaceEngine.detectFace(toBase64Frame(frame));
      if (det.found && det.bbox) {
        setBbox(det.bbox);
        stableCount.current += 1;
        setStable(stableCount.current >= STABLE_LOCK_COUNT);
      } else {
        setBbox(null);
        stableCount.current = 0;
        setStable(false);
      }
    } catch (err) {
      logger.warn(TAG, 'detectFace failed', err);
    } finally {
      busy.current = false;
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

  /** Capture one embedding from the current stable frame. */
  const onCapture = useCallback(async (): Promise<void> => {
    const frame = lastFrame.current;
    if (!frame || !stable) return;
    setError(null);
    try {
      const b64 = toBase64Frame(frame);
      const det = await FaceEngine.detectFace(b64);
      if (!det.found || !det.landmarks) {
        setError('Face lost — hold still and retry.');
        return;
      }
      const { embedding } = await FaceEngine.getEmbedding(b64, det.landmarks);
      embeddings.current.push(Float32Array.from(embedding));
      const next = embeddings.current.length;
      setCaptureIndex(next);
      stableCount.current = 0;
      setStable(false);
      logger.info(TAG, `capture ${next}/${REQUIRED_CAPTURES}`);

      if (next >= REQUIRED_CAPTURES) {
        await finishEnrol();
      }
    } catch (err) {
      logger.error(TAG, 'capture failed', err);
      setError('Capture failed. Please try again.');
    }
  }, [stable, finishEnrol]);

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
      <ScrollView contentContainerStyle={styles.formContainer}>
        <Text style={styles.heading}>Enrol Employee</Text>
        <Field
          label="Employee ID"
          value={employeeId}
          onChangeText={setEmployeeId}
          autoCapitalize="characters"
        />
        <Field label="Name" value={name} onChangeText={setName} />
        <Field
          label="Department"
          value={department}
          onChangeText={setDepartment}
        />
        <TouchableOpacity
          style={[styles.button, !formValid && styles.buttonDisabled]}
          disabled={!formValid}
          onPress={startCapture}
          accessibilityRole="button"
          accessibilityLabel="Begin face capture"
          accessibilityState={{ disabled: !formValid }}
        >
          <Text style={styles.buttonText}>Begin Capture</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (phase === 'done') {
    return (
      <View style={styles.center}>
        <Text style={styles.success} accessibilityLiveRegion="assertive">
          ✓ Enrolled {name.trim()}
        </Text>
        <TouchableOpacity
          style={styles.button}
          onPress={reset}
          accessibilityRole="button"
          accessibilityLabel="Enrol another employee"
        >
          <Text style={styles.buttonText}>Enrol Another</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // capturing / saving
  return (
    <View style={styles.fill}>
      <CameraView onFrame={onFrame} bbox={bbox} isActive={phase === 'capturing'} />

      <View style={styles.overlay} pointerEvents="box-none">
        <Text style={styles.captureCounter} accessibilityLiveRegion="polite">
          {captureIndex}/{REQUIRED_CAPTURES} captured
        </Text>
        <Text style={styles.captureHint}>{currentLabel}</Text>
        {error != null && <Text style={styles.error}>{error}</Text>}

        {phase === 'saving' ? (
          <ActivityIndicator size="large" color="#FFFFFF" />
        ) : (
          <TouchableOpacity
            style={[styles.button, !stable && styles.buttonDisabled]}
            disabled={!stable}
            onPress={onCapture}
            accessibilityRole="button"
            accessibilityLabel={`Capture ${captureIndex + 1} of ${REQUIRED_CAPTURES}`}
            accessibilityState={{ disabled: !stable }}
          >
            <Text style={styles.buttonText}>
              {stable ? 'Capture' : 'Hold still…'}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

/** Labelled text input row. */
function Field({
  label,
  value,
  onChangeText,
  autoCapitalize = 'sentences',
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        autoCapitalize={autoCapitalize}
        accessibilityLabel={label}
        placeholderTextColor="#9E9E9E"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#FFF',
  },
  formContainer: { padding: 24, backgroundColor: '#FFF', flexGrow: 1 },
  heading: { fontSize: 24, fontWeight: '700', marginBottom: 24, color: '#111' },
  field: { marginBottom: 16 },
  fieldLabel: { fontSize: 14, color: '#555', marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#CCC',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#111',
  },
  button: {
    backgroundColor: '#1565C0',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginTop: 16,
  },
  buttonDisabled: { backgroundColor: '#90A4AE' },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: '600' },
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 24,
    alignItems: 'center',
  },
  captureCounter: { color: '#FFF', fontSize: 18, fontWeight: '700' },
  captureHint: { color: '#E0E0E0', fontSize: 16, marginTop: 4 },
  success: { fontSize: 22, fontWeight: '700', color: '#2E7D32', marginBottom: 24 },
  error: { color: '#FF8A80', fontSize: 14, marginTop: 8, textAlign: 'center' },
});

export default EnrollScreen;
