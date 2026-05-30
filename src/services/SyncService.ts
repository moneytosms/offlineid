/**
 * Offline queue → AWS S3 sync (SPEC §8, ARCHITECTURE §3.3).
 *
 * Flow per {@link syncPendingRecords}:
 *  1. `getPendingRecords(10)` — batch of 10 (SPEC §18: small batch avoids
 *     presigned-URL expiry mid-sync).
 *  2. `POST /sync/presigned-urls` — request a PUT URL per record.
 *  3. `PUT` each record's JSON to its URL, max 5 concurrent. On HTTP 403
 *     (expired URL) refresh the whole batch once and retry the failed PUTs.
 *  4. `POST /sync/confirm` with the successfully-uploaded ids.
 *  5. `markSynced(confirmedIds)` — purge confirmed rows locally.
 *
 * Network failures are retried with exponential backoff (1,2,4,8 … max 60 s).
 *
 * @module services/SyncService
 */

import axios, { AxiosError } from 'axios';

import { AttendanceStore } from './AttendanceStore';
import type { AttendanceLogRow } from '../db/schema';
import { SYNC_BASE_URL } from '../config';
import { logger } from '../utils/logger';

const TAG = 'Sync';

export { SYNC_BASE_URL };

/** Records pulled / uploaded per sync pass (SPEC §18 — keep small). */
export const SYNC_BATCH_SIZE = 10;

/** Max concurrent presigned PUT uploads (ARCHITECTURE §3.3). */
export const MAX_CONCURRENT_UPLOADS = 5;

/** Exponential backoff schedule in ms (ARCHITECTURE §7). */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

/** Per-request HTTP timeout. */
const REQUEST_TIMEOUT_MS = 30_000;

/** One presigned target returned by `POST /sync/presigned-urls`. */
export interface PresignedTarget {
  /** Attendance row id this URL is for. */
  id: string;
  /** Presigned URL to PUT the record JSON to. */
  url: string;
}

/** Outcome of a {@link syncPendingRecords} pass. */
export interface SyncResult {
  /** Records attempted in this pass. */
  attempted: number;
  /** Records confirmed in S3 and purged locally. */
  synced: number;
  /** Records that failed upload/confirm (left queued). */
  failed: number;
  /** Whether anything remained pending (caller may schedule another pass). */
  done: boolean;
  /** Set when the pass aborted early (network/server). */
  error?: string;
}

/** Aggregate sync queue stats (SPEC §8.2). */
export interface SyncStats {
  /** Count of unsynced records. */
  pending: number;
  /** Timestamp of last successful sync, or null. */
  lastSync: Date | null;
}

/** Tracks the last successful sync time in-module (ms epoch). */
let lastSyncTs: number | null = null;

/** Sleep helper. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map a DB row to the S3 JSON payload (SPEC §8.3 record). */
function toPayload(row: AttendanceLogRow): Record<string, unknown> {
  return {
    id: row.id,
    employee_id: row.employee_id,
    event_type: row.event_type,
    timestamp: row.timestamp,
    location_lat: row.location_lat,
    location_lon: row.location_lon,
    device_id: row.device_id,
    confidence: row.confidence,
    liveness_score: row.liveness_score,
    created_at: row.created_at,
  };
}

/**
 * Request presigned PUT URLs for a batch of records (SPEC §8.2 step 2).
 *
 * @param rows - Pending rows needing URLs.
 * @returns One {@link PresignedTarget} per row.
 */
async function requestPresignedUrls(
  rows: AttendanceLogRow[],
): Promise<PresignedTarget[]> {
  const deviceId = rows[0]?.device_id;
  const { data } = await axios.post<{ targets: PresignedTarget[] }>(
    `${SYNC_BASE_URL}/sync/presigned-urls`,
    { count: rows.length, device_id: deviceId, ids: rows.map((r) => r.id) },
    { timeout: REQUEST_TIMEOUT_MS },
  );
  return data.targets;
}

/**
 * PUT one record to its presigned URL.
 *
 * @returns `'ok'`, `'expired'` (HTTP 403 — refreshable), or `'error'`.
 */
async function putRecord(
  target: PresignedTarget,
  row: AttendanceLogRow,
): Promise<'ok' | 'expired' | 'error'> {
  try {
    await axios.put(target.url, JSON.stringify(toPayload(row)), {
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT_MS,
    });
    return 'ok';
  } catch (err) {
    const status = (err as AxiosError).response?.status;
    if (status === 403) return 'expired';
    logger.warn(TAG, `PUT failed id=${row.id} status=${status ?? 'n/a'}`);
    return 'error';
  }
}

/**
 * Upload rows against the given targets with bounded concurrency.
 *
 * @returns Confirmed ids and the rows whose URL expired (HTTP 403).
 */
async function uploadBatch(
  rows: AttendanceLogRow[],
  targets: PresignedTarget[],
): Promise<{ confirmed: string[]; expired: AttendanceLogRow[] }> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const confirmed: string[] = [];
  const expired: AttendanceLogRow[] = [];

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const target = targets[cursor++];
      const row = byId.get(target.id);
      if (!row) continue;
      const outcome = await putRecord(target, row);
      if (outcome === 'ok') confirmed.push(row.id);
      else if (outcome === 'expired') expired.push(row);
    }
  };

  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_UPLOADS, targets.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return { confirmed, expired };
}

/**
 * Sync one batch of pending records to S3 (SPEC §8.2). Call repeatedly (e.g.
 * from {@link useNetworkSync}) until `done` is true to drain the full queue.
 *
 * On a network/server error the pass aborts and returns `error`; the caller is
 * expected to back off ({@link BACKOFF_MS}) and retry. No records are purged
 * unless the backend confirms them.
 *
 * @returns Counts and completion flag for this pass.
 */
export async function syncPendingRecords(): Promise<SyncResult> {
  let rows: AttendanceLogRow[];
  try {
    rows = await AttendanceStore.getPendingRecords(SYNC_BATCH_SIZE);
  } catch (err) {
    logger.error(TAG, 'getPendingRecords failed', err);
    return { attempted: 0, synced: 0, failed: 0, done: true, error: String(err) };
  }

  if (rows.length === 0) {
    return { attempted: 0, synced: 0, failed: 0, done: true };
  }

  try {
    // Step 2: presigned URLs.
    let targets = await requestPresignedUrls(rows);

    // Step 3: PUT each (max 5 concurrent), refresh once on 403.
    let { confirmed, expired } = await uploadBatch(rows, targets);
    if (expired.length > 0) {
      logger.info(TAG, `refreshing ${expired.length} expired URL(s)`);
      targets = await requestPresignedUrls(expired);
      const retry = await uploadBatch(expired, targets);
      confirmed = confirmed.concat(retry.confirmed);
    }

    // Step 4: confirm with backend.
    if (confirmed.length > 0) {
      await axios.post(
        `${SYNC_BASE_URL}/sync/confirm`,
        { confirmed_ids: confirmed },
        { timeout: REQUEST_TIMEOUT_MS },
      );
      // Step 5: purge locally.
      await AttendanceStore.markSynced(confirmed);
      lastSyncTs = Date.now();
    }

    const failed = rows.length - confirmed.length;
    const remaining = await AttendanceStore.getPendingCount();
    logger.info(
      TAG,
      `synced=${confirmed.length} failed=${failed} remaining=${remaining}`,
    );
    return {
      attempted: rows.length,
      synced: confirmed.length,
      failed,
      done: remaining === 0,
    };
  } catch (err) {
    logger.error(TAG, 'sync pass failed', err);
    return {
      attempted: rows.length,
      synced: 0,
      failed: rows.length,
      done: false,
      error: String(err),
    };
  }
}

/**
 * Drain the entire queue, batch by batch, retrying transient errors with
 * exponential backoff ({@link BACKOFF_MS}). Stops when the queue is empty or a
 * batch makes no progress after exhausting the backoff schedule.
 *
 * @returns Aggregate result across all passes.
 */
export async function syncAll(): Promise<SyncResult> {
  let totalSynced = 0;
  let totalFailed = 0;
  let totalAttempted = 0;
  let backoffIdx = 0;

  for (;;) {
    const res = await syncPendingRecords();
    totalAttempted += res.attempted;
    totalSynced += res.synced;

    if (res.done && !res.error) {
      return {
        attempted: totalAttempted,
        synced: totalSynced,
        failed: totalFailed,
        done: true,
      };
    }

    if (res.synced > 0) {
      // Made progress: keep going immediately, reset backoff.
      backoffIdx = 0;
      continue;
    }

    // No progress this pass: back off, give up if schedule exhausted.
    if (backoffIdx >= BACKOFF_MS.length) {
      totalFailed += res.failed;
      return {
        attempted: totalAttempted,
        synced: totalSynced,
        failed: totalFailed,
        done: false,
        error: res.error ?? 'sync stalled',
      };
    }
    await delay(BACKOFF_MS[backoffIdx++]);
  }
}

/**
 * Current queue statistics (SPEC §8.2).
 *
 * @returns Pending count and last successful sync time.
 */
export async function getSyncStats(): Promise<SyncStats> {
  const pending = await AttendanceStore.getPendingCount();
  return { pending, lastSync: lastSyncTs != null ? new Date(lastSyncTs) : null };
}

export const SyncService = {
  syncPendingRecords,
  syncAll,
  getSyncStats,
};

export default SyncService;
