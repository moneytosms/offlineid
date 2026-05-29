/**
 * Authentication orchestration hook (SPEC §11, ARCHITECTURE §3.2).
 *
 * Drives the per-session state machine:
 *
 *   IDLE → DETECTING → LIVENESS → GESTURE → RECOGNISING → SUCCESS | FAIL
 *
 * Frame handling (SPEC §6.4):
 *  - {@link processFrame} is gated to every 5th call.
 *  - A face must be detected on 3 consecutive sampled frames to "lock in",
 *    after which the full liveness → gesture → recognition pipeline runs once.
 *
 * Recognition thresholds (SPEC §11):
 *  - score > 0.65            → SUCCESS, write `attendance_log`.
 *  - 0.45 ≤ score ≤ 0.65     → UNCERTAIN, retry (max 3).
 *  - score < 0.45 | liveness → REJECTED.
 *
 * Rate limiting (SPEC §12): after 5 consecutive failed sessions the screen is
 * locked for 30 s.
 *
 * @module hooks/useFaceAuth
 */

import { useCallback, useRef, useState } from 'react';

import { FaceEngine } from '../services/FaceEngine';
import type { BoundingBox, DetectionResult } from '../services/FaceEngine';
import {
  passiveLivenessCheck,
  activeGestureCheck,
  pickRandomGesture,
} from '../services/LivenessService';
import type { Gesture, FaceDetectorStream } from '../services/LivenessService';
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

/** Recognition match threshold (SPEC §11). */
export const MATCH_THRESHOLD = 0.65;

/** Lower bound of the "uncertain" band (SPEC §11). */
export const UNCERTAIN_THRESHOLD = 0.45;

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

/** Inputs for a single processed frame. */
export interface FrameInput {
  /** Base64-encoded camera frame. */
  base64Frame: string;
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
  /** Feed a camera frame (gated to every 5th internally). */
  processFrame: (input: FrameInput) => Promise<void>;
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
  const frameCounter = useRef(0);
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
    frameCounter.current = 0;
    stableCount.current = 0;
    busy.current = false;
    uncertainRetries.current = 0;
    setMatchedEmployee(null);
    setLivenessScore(null);
    setCurrentGesture(null);
    setPhase('DETECTING');
  }, [setPhase]);

  const resetSession = useCallback((): void => {
    frameCounter.current = 0;
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
    async (input: FrameInput, liveness: number | null): Promise<void> => {
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
      input: FrameInput,
      bbox: BoundingBox,
      landmarks: [number, number][],
    ): Promise<void> => {
      // --- Passive liveness (SPEC §9.1) ---
      setPhase('LIVENESS');
      const passive = await passiveLivenessCheck(input.base64Frame, bbox);
      setLivenessScore(passive.score);
      if (!passive.isLive) {
        logger.info(TAG, 'liveness reject');
        await logFailedAttempt(input, passive.score);
        registerFail();
        return;
      }

      // --- Active gesture (SPEC §9.2) ---
      setPhase('GESTURE');
      const gesture = pickRandomGesture();
      setCurrentGesture(gesture);
      const gestureResult = await activeGestureCheck(
        gesture,
        input.faceDetectorStream,
      );
      if (!gestureResult.passed) {
        logger.info(TAG, 'gesture reject');
        await logFailedAttempt(input, passive.score);
        registerFail();
        return;
      }

      // --- Recognition (SPEC §11) ---
      setPhase('RECOGNISING');
      const { embedding } = await FaceEngine.getEmbedding(
        input.base64Frame,
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

  const processFrame = useCallback(
    async (input: FrameInput): Promise<void> => {
      // Lockout gate (SPEC §12).
      if (Date.now() < lockUntil.current) {
        if (statusRef.current !== 'LOCKED') setPhase('LOCKED');
        return;
      }

      // Only act while actively detecting; ignore frames mid-pipeline / terminal.
      if (statusRef.current !== 'DETECTING' || busy.current) return;

      // Frame gate: every 5th frame (SPEC §6.4).
      frameCounter.current += 1;
      if (frameCounter.current % FRAME_GATE !== 0) return;

      let detection: DetectionResult;
      try {
        detection = await FaceEngine.detectFace(input.base64Frame);
      } catch (err) {
        logger.error(TAG, 'detectFace failed', err);
        return;
      }

      if (!detection.found || !detection.bbox || !detection.landmarks) {
        stableCount.current = 0;
        return;
      }

      // Require STABLE_LOCK_COUNT consecutive stable detections.
      stableCount.current += 1;
      if (stableCount.current < STABLE_LOCK_COUNT) return;

      // Lock in and run the full pipeline exactly once.
      busy.current = true;
      try {
        await runPipeline(input, detection.bbox, detection.landmarks);
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
    processFrame,
    startSession,
    resetSession,
  };
}

export default useFaceAuth;
