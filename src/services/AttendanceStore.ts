/**
 * CRUD for the attendance log (`attendance_log` table, SPEC §7, §8, §11).
 *
 * Records are written with `synced = 0` and later purged by the sync service
 * once confirmed in S3. This store backs the offline queue.
 *
 * @module services/AttendanceStore
 */

import { v4 as uuidv4 } from 'uuid';

import { getDb } from '../db/migrations';
import type { AttendanceLogRow, AttendanceEventType } from '../db/schema';

/**
 * Caller-supplied fields for a new attendance event. `id`, `synced`,
 * `sync_attempt`, and `created_at` are managed by {@link AttendanceStore.logEvent}.
 */
export interface AttendanceEventInput {
  /** Employee identifier. */
  employee_id: string;
  /** Event type. */
  event_type: AttendanceEventType;
  /** Event time, Unix timestamp ms. */
  timestamp: number;
  /** Device identifier. */
  device_id: string;
  /** Optional GPS latitude. */
  location_lat?: number | null;
  /** Optional GPS longitude. */
  location_lon?: number | null;
  /** Cosine similarity score of the match, if any. */
  confidence?: number | null;
  /** Passive liveness score, if computed. */
  liveness_score?: number | null;
  /** JPEG thumbnail (≤ 20 KB) for audit, or null. */
  face_thumbnail?: Uint8Array | null;
}

/** Encode raw bytes to a lowercase hex string. */
function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Store for attendance / authentication events.
 */
export const AttendanceStore = {
  /**
   * Insert a new attendance event with `synced = 0`.
   *
   * @param record - Event fields.
   * @returns The generated UUID v4 row id.
   */
  async logEvent(record: AttendanceEventInput): Promise<string> {
    const id = uuidv4();
    const createdAt = Date.now();
    const thumb =
      record.face_thumbnail != null ? bytesToHex(record.face_thumbnail) : null;

    const db = getDb();
    await db.executeSql(
      `INSERT INTO attendance_log
         (id, employee_id, event_type, timestamp, location_lat, location_lon,
          device_id, confidence, liveness_score, face_thumbnail,
          synced, sync_attempt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?);`,
      [
        id,
        record.employee_id,
        record.event_type,
        record.timestamp,
        record.location_lat ?? null,
        record.location_lon ?? null,
        record.device_id,
        record.confidence ?? null,
        record.liveness_score ?? null,
        thumb,
        createdAt,
      ],
    );
    return id;
  },

  /**
   * Fetch pending (unsynced) records, oldest first.
   *
   * @param limit - Maximum rows to return (default 10).
   * @returns Pending rows.
   */
  async getPendingRecords(limit = 10): Promise<AttendanceLogRow[]> {
    const db = getDb();
    const [result] = await db.executeSql(
      `SELECT * FROM attendance_log
       WHERE synced = 0
       ORDER BY created_at ASC
       LIMIT ?;`,
      [limit],
    );

    const rows: AttendanceLogRow[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      rows.push(result.rows.item(i) as AttendanceLogRow);
    }
    return rows;
  },

  /**
   * Purge synced records by id. Records are deleted (not flagged) once
   * confirmed in S3, per SPEC §8 purge-on-ACK.
   *
   * @param ids - Row ids confirmed as synced.
   * @returns Number of rows deleted.
   */
  async markSynced(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const placeholders = ids.map(() => '?').join(', ');
    const db = getDb();
    const [result] = await db.executeSql(
      `DELETE FROM attendance_log WHERE id IN (${placeholders});`,
      ids,
    );
    return result.rowsAffected;
  },

  /**
   * Fetch failed authentication attempts for the audit trail (SPEC §11).
   *
   * @returns Rows whose `event_type` is `'failed_attempt'`, newest first.
   */
  async getFailedAttempts(): Promise<AttendanceLogRow[]> {
    const db = getDb();
    const [result] = await db.executeSql(
      `SELECT * FROM attendance_log
       WHERE event_type = 'failed_attempt'
       ORDER BY created_at DESC;`,
    );

    const rows: AttendanceLogRow[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      rows.push(result.rows.item(i) as AttendanceLogRow);
    }
    return rows;
  },

  /**
   * Count pending (unsynced) records, e.g. for the sync badge.
   *
   * @returns Number of rows with `synced = 0`.
   */
  async getPendingCount(): Promise<number> {
    const db = getDb();
    const [result] = await db.executeSql(
      `SELECT COUNT(*) AS cnt FROM attendance_log WHERE synced = 0;`,
    );
    return result.rows.item(0).cnt as number;
  },

  /**
   * Recent events of any type, newest first (for the activity view).
   *
   * @param limit - Maximum rows (default 50).
   */
  async getRecentEvents(limit = 50): Promise<AttendanceLogRow[]> {
    const db = getDb();
    const [result] = await db.executeSql(
      `SELECT * FROM attendance_log ORDER BY created_at DESC LIMIT ?;`,
      [limit],
    );
    const rows: AttendanceLogRow[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      rows.push(result.rows.item(i) as AttendanceLogRow);
    }
    return rows;
  },

  /** Delete all attendance rows (factory reset). Returns rows removed. */
  async deleteAll(): Promise<number> {
    const db = getDb();
    const [result] = await db.executeSql(`DELETE FROM attendance_log;`);
    return result.rowsAffected;
  },
};

export default AttendanceStore;
