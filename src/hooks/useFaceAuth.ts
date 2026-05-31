/**
 * Authentication orchestration hook (SPEC §11, ARCHITECTURE §3.2).
 *
 * Drives the per-session state machine:
 *
 *   IDLE → DETECTING → LIVENESS → GESTURE → RECOGNISING → SUCCESS | FAIL
 *
 * Frame handling (SPEC §6.4):
 *  - {@link processDetection} consumes the gated ML Kit face stream
 *    (already sampled every 5th frame in `CameraView`).
 *  - A face must be present on 3 consecutive sampled frames to "lock in"; the
 *    hook then captures one still (`capture()`) and runs the full
 *    detect → liveness → gesture → recognition pipeline once on that still.
 *
 * Recognition thresholds (SPEC §11, on-device calibrated):
 *  - score > 0.40            → SUCCESS, write `attendance_log`.
 *  - 0.25 ≤ score ≤ 0.40     → UNCERTAIN, retry (max 3).
 *  - score < 0.25 | liveness → REJECTED.
 *
 * Rate limiting (SPEC §12): after 5 consecutive failed sessions the screen is
 * locked for 30 s.
 *
 * @module hooks/useFaceAuth
 */

import { useCallback, useRef, useState } from 'react';

import { FaceEngine } from '../services/FaceEngine';
import type { BoundingBox } from '../services/FaceEngine';
import {
  passiveLivenessCheck,
  activeGestureCheck,
  pickGestureSequence,
} from '../services/LivenessService';
import type {
  Gesture,
  FaceDetectorStream,
  MLKitFaceFrame,
} from '../services/LivenessService';
import { EmbeddingStore } from '../services/EmbeddingStore';
import { findBestMatch } from '../utils/cosineDistance';
import { AttendanceStore } from '../services/AttendanceStore';
import type { AttendanceEventType } from '../db/schema';
import { logger } from '../utils/logger';

const TAG = 'FaceAuth';

/** Auth session states (SPEC §11). */
export type AuthStatus =
  | 'IDLE'
  | 'DETECTING'
  | 'LIVENESS'
  | 'GESTURE'
  | 'RECOGNISING'
  | 'SUCCESS'
  | 'FAIL'
  | 'LOCKED';

/** Process every Nth frame (SPEC §6.4). */
export const FRAME_GATE = 5;

/** Consecutive stable detections before locking in (SPEC §6.4). */
export const STABLE_LOCK_COUNT = 3;

/**
 * Recognition match threshold (SPEC §11). Calibrated against on-device
 * MobileFaceNet-INT8 readings: genuine matches cluster ~0.45–0.55 on real
 * faces, impostors ~0.0–0.3, so 0.40 accepts genuine users with a wide
 * impostor margin. (Pre-calibration default was 0.65, unreachable on-device.)
 */
export const MATCH_THRESHOLD = 0.4;

/** Lower bound of the "uncertain" band (SPEC §11). */
export const UNCERTAIN_THRESHOLD = 0.25;

/** Max uncertain retries within a session (SPEC §11). */
export const MAX_UNCERTAIN_RETRIES = 3;

/** Consecutive session failures before lockout (SPEC §12). */
export const MAX_CONSECUTIVE_FAILS = 5;

/** Lockout duration after too many failures (SPEC §12). */
export const LOCKOUT_MS = 30_000;

/** Matched employee identity surfaced on SUCCESS. */
export interface MatchedEmployee {
  employeeId: string;
  name: string;
  score: number;
}

/** Inputs for a single processed detection. */
export interface DetectionInput {
  /** Current ML Kit face for this sampled frame, or null if none present. */
  face: MLKitFaceFrame | null;
  /** Capture a base64 still on lock-in (e.g. `CameraView.capture`). */
  capture: () => Promise<string>;
  /** ML Kit face-frame stream used for the gesture step. */
  faceDetectorStream: FaceDetectorStream;
  /** Device identifier for the attendance record. */
  deviceId: string;
  /** Optional GPS latitude. */
  locationLat?: number | null;
  /** Optional GPS longitude. */
  locationLon?: number | null;
  /** Attendance event type on success (default `'check_in'`). */
  eventType?: AttendanceEventType;
}

/** Public hook surface. */
export interface UseFaceAuth {
  /** Current state-machine status. */
  status: AuthStatus;
  /** Identity matched on SUCCESS, else null. */
  matchedEmployee: MatchedEmployee | null;
  /** Latest passive liveness score, or null. */
  livenessScore: number | null;
  /** The gesture currently prompted, or null. */
  currentGesture: Gesture | null;
  /** Feed one sampled ML Kit detection; captures + runs pipeline on lock-in. */
  processDetection: (input: DetectionInput) => Promise<void>;
  /** Begin a session (IDLE → DETECTING). No-op while LOCKED. */
  startSession: () => void;
  /** Reset to IDLE and clear per-session counters (not the lockout). */
  resetSession: () => void;
}

/**
 * Auth orchestration hook. UI feeds frames via {@link processFrame}; the hook
 * advances the state machine and writes the attendance record on success.
 */
export function useFaceAuth(): UseFaceAuth {
  const [status, setStatus] = useState<AuthStatus>('IDLE');
  const [matchedEmployee, setMatchedEmployee] =
    useState<MatchedEmployee | null>(null);
  const [livenessScore, setLivenessScore] = useState<number | null>(null);
  const [currentGesture, setCurrentGesture] = useState<Gesture | null>(null);

  // Refs (mutable, not render-driving).
  const stableCount = useRef(0);
  const busy = useRef(false); // pipeline in flight — drop incoming frames
  const uncertainRetries = useRef(0);
  const consecutiveFails = useRef(0);
  const lockUntil = useRef(0);
  const statusRef = useRef<AuthStatus>('IDLE');

  /** Set both the state and the synchronous ref mirror. */
  const setPhase = useCallback((next: AuthStatus): void => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const startSession = useCallback((): void => {
    if (Date.now() < lockUntil.current) {
      setPhase('LOCKED');
      return;
    }
    stableCount.current = 0;
    busy.current = false;
    uncertainRetries.current = 0;
    setMatchedEmployee(null);
    setLivenessScore(null);
    setCurrentGesture(null);
    setPhase('DETECTING');
  }, [setPhase]);

  const resetSession = useCallback((): void => {
    stableCount.current = 0;
    busy.current = false;
    uncertainRetries.current = 0;
    setMatchedEmployee(null);
    setLivenessScore(null);
    setCurrentGesture(null);
    setPhase(Date.now() < lockUntil.current ? 'LOCKED' : 'IDLE');
  }, [setPhase]);

  /** Record a session failure and enforce the rate-limit lockout. */
  const registerFail = useCallback((): void => {
    consecutiveFails.current += 1;
    if (consecutiveFails.current >= MAX_CONSECUTIVE_FAILS) {
      lockUntil.current = Date.now() + LOCKOUT_MS;
      consecutiveFails.current = 0;
      logger.warn(TAG, `locked for ${LOCKOUT_MS}ms (rate limit)`);
      setPhase('LOCKED');
    } else {
      setPhase('FAIL');
    }
  }, [setPhase]);

  /** Write a failed-attempt audit row (SPEC §11). */
  const logFailedAttempt = useCallback(
    async (input: DetectionInput, liveness: number | null): Promise<void> => {
      try {
        await AttendanceStore.logEvent({
          employee_id: 'unknown',
          event_type: 'failed_attempt',
          timestamp: Date.now(),
          device_id: input.deviceId,
          location_lat: input.locationLat ?? null,
          location_lon: input.locationLon ?? null,
          confidence: null,
          liveness_score: liveness,
        });
      } catch (err) {
        logger.error(TAG, 'logFailedAttempt failed', err);
      }
    },
    [],
  );

  /**
   * Run liveness → gesture → recognition once a face is locked in. Owns all
   * phase transitions from LIVENESS onward.
   */
  const runPipeline = useCallback(
    async (
      input: DetectionInput,
      base64Frame: string,
      bbox: BoundingBox,
      landmarks: [number, number][],
    ): Promise<void> => {
      // --- Passive liveness (SPEC §9.1) ---
      setPhase('LIVENESS');
      const passive = await passiveLivenessCheck(base64Frame, bbox);
      setLivenessScore(passive.score);
      if (!passive.isLive) {
        logger.info(TAG, 'liveness reject');
        await logFailedAttempt(input, passive.score);
        registerFail();
        return;
      }

      // --- Active gesture sequence (SPEC §9.2, anti-replay) ---
      // An ordered sequence of distinct gestures: a pre-recorded replay only
      // passes if its performed order matches this runtime-random order, and
      // each step requires an active neutral→gesture transition.
      setPhase('GESTURE');
      const sequence = pickGestureSequence();
      for (const gesture of sequence) {
        setCurrentGesture(gesture);
        // Fewer retries per step keeps a 2-gesture challenge responsive.
        const gestureResult = await activeGestureCheck(
          gesture,
          input.faceDetectorStream,
          2,
        );
        if (!gestureResult.passed) {
          logger.info(TAG, `gesture reject (${gesture})`);
          await logFailedAttempt(input, passive.score);
          registerFail();
          return;
        }
      }

      // --- Recognition (SPEC §11) ---
      setPhase('RECOGNISING');
      const { embedding } = await FaceEngine.getEmbedding(
        base64Frame,
        landmarks,
      );
      const query = Float32Array.from(embedding);
      const enrolled = await EmbeddingStore.getAllEmbeddings();

      // Best similarity regardless of threshold (for the uncertain band).
      const best = findBestMatch(query, enrolled, -Infinity);
      const score = best?.score ?? -Infinity;

      if (score > MATCH_THRESHOLD && best) {
        const person = enrolled.find((e) => e.employeeId === best.employeeId);
        await AttendanceStore.logEvent({
          employee_id: best.employeeId,
          event_type: input.eventType ?? 'check_in',
          timestamp: Date.now(),
          device_id: input.deviceId,
          location_lat: input.locationLat ?? null,
          location_lon: input.locationLon ?? null,
          confidence: score,
          liveness_score: passive.score,
        });
        consecutiveFails.current = 0;
        uncertainRetries.current = 0;
        setMatchedEmployee({
          employeeId: best.employeeId,
          name: person?.name ?? best.employeeId,
          score,
        });
        logger.info(TAG, `SUCCESS ${best.employeeId} score=${score.toFixed(3)}`);
        setPhase('SUCCESS');
        return;
      }

      if (score >= UNCERTAIN_THRESHOLD) {
        uncertainRetries.current += 1;
        logger.info(
          TAG,
          `uncertain score=${score.toFixed(3)} retry=${uncertainRetries.current}`,
        );
        if (uncertainRetries.current < MAX_UNCERTAIN_RETRIES) {
          // Re-arm detection for another attempt within the same session.
          stableCount.current = 0;
          setPhase('DETECTING');
          return;
        }
      }

      // score < 0.45, or uncertain retries exhausted → reject.
      await logFailedAttempt(input, passive.score);
      registerFail();
    },
    [logFailedAttempt, registerFail, setPhase],
  );

  const processDetection = useCallback(
    async (input: DetectionInput): Promise<void> => {
      // Lockout gate (SPEC §12).
      if (Date.now() < lockUntil.current) {
        if (statusRef.current !== 'LOCKED') setPhase('LOCKED');
        return;
      }

      // Only act while actively detecting; ignore frames mid-pipeline / terminal.
      if (statusRef.current !== 'DETECTING' || busy.current) return;

      // The ML Kit stream is already gated to every 5th frame in CameraView.
      // Require a face present on STABLE_LOCK_COUNT consecutive samples.
      if (input.face == null) {
        stableCount.current = 0;
        return;
      }
      stableCount.current += 1;
      if (stableCount.current < STABLE_LOCK_COUNT) return;

      // Lock in: capture one still, then run the full ONNX pipeline once.
      busy.current = true;
      try {
        let base64Frame: string;
        try {
          base64Frame = await input.capture();
        } catch (captureErr) {
          // Camera not ready (e.g. transitioning) — re-arm without penalty.
          logger.debug(TAG, 'capture failed, re-arming', captureErr);
          stableCount.current = 0;
          return;
        }

        // Native SCRFD gives the precise bbox + 5 landmarks on the still.
        const detection = await FaceEngine.detectFace(base64Frame);
        if (!detection.found || !detection.bbox || !detection.landmarks) {
          // Face lost between stream and still — re-arm without penalty.
          logger.debug(TAG, 'no face on captured still; re-arming');
          stableCount.current = 0;
          return;
        }

        await runPipeline(
          input,
          base64Frame,
          detection.bbox,
          detection.landmarks,
        );
      } catch (err) {
        logger.error(TAG, 'pipeline error', err);
        await logFailedAttempt(input, null);
        registerFail();
      } finally {
        busy.current = false;
      }
    },
    [logFailedAttempt, registerFail, runPipeline, setPhase],
  );

  return {
    status,
    matchedEmployee,
    livenessScore,
    currentGesture,
    processDetection,
    startSession,
    resetSession,
  };
}

export default useFaceAuth;
