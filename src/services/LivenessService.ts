/**
 * Liveness orchestration (SPEC §9, ARCHITECTURE §3.2).
 *
 * Two layers:
 *  1. Passive — two-scale FASNet anti-spoof via {@link FaceEngine.checkLiveness},
 *     averaged and thresholded at 0.6 (SPEC §9.1).
 *  2. Active — a randomly-chosen gesture (blink / turn / smile) confirmed from a
 *     stream of ML Kit face frames within a 5 s window, up to 3 retries
 *     (SPEC §9.2).
 *
 * The native module performs the FASNet bbox crop/resize at scales 2.7 and 4.0
 * (MODEL_PIPELINE §3.4); this service only passes the bbox and averages scores.
 *
 * @module services/LivenessService
 */

import { FaceEngine } from './FaceEngine';
import type { BoundingBox } from './FaceEngine';
import { logger } from '../utils/logger';

const TAG = 'Liveness';

/** Passive FASNet acceptance threshold (SPEC §9.1). */
export const PASSIVE_LIVENESS_THRESHOLD = 0.6;

/** Gesture detection window before a retry (SPEC §9.2). */
export const GESTURE_TIMEOUT_MS = 5_000;

/** Maximum gesture retries before a hard fail (SPEC §9.2). */
export const GESTURE_MAX_RETRIES = 3;

/** ML Kit gesture thresholds (SPEC §9.2). */
export const GESTURE_THRESHOLDS = {
  /** Eye-open probability below this counts as closed. */
  EYE_OPEN_CLOSED: 0.2,
  /** `headEulerAngleY` magnitude (deg) for a confirmed head turn. */
  YAW_DEGREES: 20,
  /** Smiling probability above this counts as a smile. */
  SMILE: 0.7,
} as const;

/** Supported active-liveness gestures (SPEC §9.2). */
export const GESTURES = ['BLINK', 'TURN_LEFT', 'TURN_RIGHT', 'SMILE'] as const;

/** A single active-liveness gesture. */
export type Gesture = (typeof GESTURES)[number];

/** Result of {@link passiveLivenessCheck}. */
export interface PassiveLivenessResult {
  /** Averaged two-scale score in [0,1]. */
  score: number;
  /** Whether `score` exceeds {@link PASSIVE_LIVENESS_THRESHOLD}. */
  isLive: boolean;
}

/**
 * Minimal ML Kit face-frame fields used for gesture detection. A superset of
 * the `@react-native-ml-kit/face-detection` face shape; only these fields are
 * read here.
 */
export interface MLKitFaceFrame {
  /** Probability the left eye is open, in [0,1]. */
  leftEyeOpenProbability?: number | null;
  /** Probability the right eye is open, in [0,1]. */
  rightEyeOpenProbability?: number | null;
  /** Head yaw in degrees (+ve = turned to subject's left). */
  headEulerAngleY?: number | null;
  /** Probability the subject is smiling, in [0,1]. */
  smilingProbability?: number | null;
}

/**
 * A subscribable source of ML Kit face frames. Calls `listener` per detected
 * frame and returns an unsubscribe function.
 */
export type FaceDetectorStream = (
  listener: (face: MLKitFaceFrame) => void,
) => () => void;

/** Result of {@link activeGestureCheck}. */
export interface GestureCheckResult {
  /** Whether the gesture was confirmed within the allotted retries. */
  passed: boolean;
  /** The gesture that was prompted. */
  gesture: Gesture;
  /** Number of attempts consumed (1-based). */
  attempts: number;
}

/** Number of ordered gestures challenged per session (anti-replay). */
export const GESTURE_SEQUENCE_LENGTH = 2;

/** Pick a random gesture for the session (SPEC §9.2). */
export function pickRandomGesture(): Gesture {
  return GESTURES[Math.floor(Math.random() * GESTURES.length)];
}

/**
 * Pick an ordered sequence of `n` distinct random gestures (anti-replay,
 * SPEC §9.2). A pre-recorded video only passes if its performed gesture order
 * matches this runtime-random order, so a static replay of "all gestures" is
 * defeated unless it happens to match the prompted permutation.
 */
export function pickGestureSequence(n = GESTURE_SEQUENCE_LENGTH): Gesture[] {
  const pool: Gesture[] = [...GESTURES];
  const seq: Gesture[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    seq.push(pool.splice(idx, 1)[0]);
  }
  return seq;
}

/**
 * Run the two-scale passive FASNet liveness check (SPEC §9.1).
 *
 * Both scale calls are issued concurrently; the native module crops/resizes the
 * bbox at scale 2.7 and 4.0 internally (MODEL_PIPELINE §3.4). The two real-face
 * scores are averaged and thresholded.
 *
 * @param base64Frame - Base64-encoded source frame.
 * @param bbox - Detected face bounding box (source-frame pixels).
 * @returns Averaged score and live/spoof verdict.
 */
export async function passiveLivenessCheck(
  base64Frame: string,
  bbox: BoundingBox,
): Promise<PassiveLivenessResult> {
  const tuple: [number, number, number, number] = [
    bbox.x,
    bbox.y,
    bbox.w,
    bbox.h,
  ];

  // Two-scale check (Silent-Face-Anti-Spoofing): scale 2.7 (MiniFASNetV2) and
  // 4.0 (MiniFASNetV1SE). The scale selects the matching FASNet model natively.
  const [r1, r2] = await Promise.all([
    FaceEngine.checkLiveness(base64Frame, tuple, 2.7),
    FaceEngine.checkLiveness(base64Frame, tuple, 4.0),
  ]);

  const score = (r1.score + r2.score) / 2;
  const isLive = score > PASSIVE_LIVENESS_THRESHOLD;
  logger.debug(TAG, `passive score=${score.toFixed(3)} isLive=${isLive}`);
  return { score, isLive };
}

/** Whether a single ML Kit frame satisfies the given gesture. */
function frameSatisfiesGesture(face: MLKitFaceFrame, gesture: Gesture): boolean {
  switch (gesture) {
    case 'BLINK': {
      const left = face.leftEyeOpenProbability;
      const right = face.rightEyeOpenProbability;
      // Treat as a blink only when we actually have an estimate that is low.
      return (
        (left != null && left < GESTURE_THRESHOLDS.EYE_OPEN_CLOSED) ||
        (right != null && right < GESTURE_THRESHOLDS.EYE_OPEN_CLOSED)
      );
    }
    case 'TURN_LEFT':
      return (
        face.headEulerAngleY != null &&
        face.headEulerAngleY > GESTURE_THRESHOLDS.YAW_DEGREES
      );
    case 'TURN_RIGHT':
      return (
        face.headEulerAngleY != null &&
        face.headEulerAngleY < -GESTURE_THRESHOLDS.YAW_DEGREES
      );
    case 'SMILE':
      return (
        face.smilingProbability != null &&
        face.smilingProbability > GESTURE_THRESHOLDS.SMILE
      );
    default:
      return false;
  }
}

/**
 * Wait for a single gesture confirmation within {@link GESTURE_TIMEOUT_MS}.
 * BLINK requires the closed condition on 2 consecutive frames (SPEC §9.2);
 * other gestures confirm on first satisfying frame.
 *
 * Anti-replay: when `requireNeutralFirst` is set, the gesture is only accepted
 * after a non-satisfying ("neutral") frame is first seen — the user must
 * actively transition *into* the gesture during this window. This rejects a
 * face that is already mid-gesture when the prompt appears (e.g. a looping
 * replay video that happens to be smiling), and prevents one held expression
 * from satisfying consecutive steps of a gesture sequence.
 *
 * @param gesture - Gesture to confirm.
 * @param faceDetectorStream - Source of ML Kit face frames.
 * @param requireNeutralFirst - Require a neutral frame before accepting (default true).
 * @returns Resolves `true` on confirmation, `false` on timeout.
 */
function awaitGestureOnce(
  gesture: Gesture,
  faceDetectorStream: FaceDetectorStream,
  requireNeutralFirst = true,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let consecutiveBlink = 0;
    let sawNeutral = !requireNeutralFirst;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(ok);
    };

    const timer = setTimeout(() => finish(false), GESTURE_TIMEOUT_MS);

    const unsubscribe = faceDetectorStream((face) => {
      const hit = frameSatisfiesGesture(face, gesture);
      // Must observe a neutral (non-satisfying) frame before counting a hit.
      if (!hit) {
        sawNeutral = true;
        if (gesture === 'BLINK') consecutiveBlink = 0;
        return;
      }
      if (!sawNeutral) return;
      if (gesture === 'BLINK') {
        consecutiveBlink += 1;
        if (consecutiveBlink >= 2) finish(true);
      } else {
        finish(true);
      }
    });
  });
}

/**
 * Run the active gesture check with retry (SPEC §9.2). Retries the same gesture
 * up to `maxRetries` times, each with a fresh {@link GESTURE_TIMEOUT_MS} window.
 *
 * @param gesture - Gesture to prompt (use {@link pickRandomGesture}).
 * @param faceDetectorStream - Source of ML Kit face frames.
 * @param maxRetries - Windows allowed before failing (default {@link GESTURE_MAX_RETRIES}).
 * @returns Pass/fail with the attempt count consumed.
 */
export async function activeGestureCheck(
  gesture: Gesture,
  faceDetectorStream: FaceDetectorStream,
  maxRetries = GESTURE_MAX_RETRIES,
): Promise<GestureCheckResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logger.debug(TAG, `gesture=${gesture} attempt=${attempt}`);
    const passed = await awaitGestureOnce(gesture, faceDetectorStream);
    if (passed) {
      return { passed: true, gesture, attempts: attempt };
    }
  }
  logger.warn(TAG, `gesture=${gesture} failed after ${maxRetries}`);
  return { passed: false, gesture, attempts: maxRetries };
}

export const LivenessService = {
  passiveLivenessCheck,
  activeGestureCheck,
  pickRandomGesture,
  pickGestureSequence,
  GESTURES,
  GESTURE_SEQUENCE_LENGTH,
};

export default LivenessService;
