/**
 * SQLite schema definitions for OfflineID.
 *
 * The three CREATE TABLE statements are reproduced verbatim from SPEC.md §7.
 * Column names here are the canonical on-device storage names; do not rename
 * without updating the S3 sync payload contract (SPEC §8).
 *
 * @module db/schema
 */

/**
 * Enrolled face embeddings (permanent on-device). SPEC §7.
 * `embedding` holds an AES-256-GCM encrypted Float32Array (512 × 4 bytes).
 */
export const CREATE_FACE_EMBEDDINGS = `CREATE TABLE IF NOT EXISTS face_embeddings (
  id          TEXT PRIMARY KEY,          -- UUID v4
  employee_id TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  department  TEXT,
  embedding   BLOB NOT NULL,             -- AES-256 encrypted Float32Array (512 × 4 bytes)
  enrolled_at INTEGER NOT NULL,          -- Unix timestamp ms
  version     INTEGER DEFAULT 1
);`;

/**
 * Attendance log (ephemeral, purged after S3 sync). SPEC §7.
 */
export const CREATE_ATTENDANCE_LOG = `CREATE TABLE IF NOT EXISTS attendance_log (
  id              TEXT PRIMARY KEY,      -- UUID v4
  employee_id     TEXT NOT NULL,
  event_type      TEXT NOT NULL,         -- 'check_in' | 'check_out' | 'failed_attempt'
  timestamp       INTEGER NOT NULL,      -- Unix timestamp ms
  location_lat    REAL,
  location_lon    REAL,
  device_id       TEXT NOT NULL,
  confidence      REAL,                  -- cosine similarity score
  liveness_score  REAL,
  face_thumbnail  BLOB,                  -- JPEG, max 20 KB, for audit trail
  synced          INTEGER DEFAULT 0,     -- 0 = pending, 1 = synced
  sync_attempt    INTEGER DEFAULT 0,     -- retry counter
  created_at      INTEGER NOT NULL
);`;

/**
 * Sync metadata key/value store. SPEC §7.
 * Keys: 'last_sync_ts', 'device_id', 'sync_endpoint', 'schema_version'.
 */
export const CREATE_SYNC_META = `CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;

/**
 * All CREATE TABLE statements in creation order. Consumed by {@link runMigrations}.
 */
export const ALL_TABLES: string[] = [
  CREATE_FACE_EMBEDDINGS,
  CREATE_ATTENDANCE_LOG,
  CREATE_SYNC_META,
];

/** Row shape of the `face_embeddings` table. SPEC §7. */
export interface FaceEmbeddingRow {
  /** UUID v4 primary key. */
  id: string;
  /** Datalake 3.0 employee identifier (unique). */
  employee_id: string;
  /** Display name. */
  name: string;
  /** Optional department label. */
  department: string | null;
  /** AES-256-GCM encrypted Float32Array (512 × 4 bytes) as a BLOB. */
  embedding: Uint8Array;
  /** Enrollment time, Unix timestamp ms. */
  enrolled_at: number;
  /** Schema/record version (defaults to 1). */
  version: number;
}

/** Attendance event discriminator. SPEC §7. */
export type AttendanceEventType = 'check_in' | 'check_out' | 'failed_attempt';

/** Row shape of the `attendance_log` table. SPEC §7. */
export interface AttendanceLogRow {
  /** UUID v4 primary key. */
  id: string;
  /** Employee identifier (not unique; one per event). */
  employee_id: string;
  /** Event type. */
  event_type: AttendanceEventType;
  /** Event time, Unix timestamp ms. */
  timestamp: number;
  /** Optional GPS latitude. */
  location_lat: number | null;
  /** Optional GPS longitude. */
  location_lon: number | null;
  /** Device identifier. */
  device_id: string;
  /** Cosine similarity score of the match, if any. */
  confidence: number | null;
  /** Passive liveness score, if computed. */
  liveness_score: number | null;
  /** JPEG thumbnail (≤ 20 KB) for audit, purged on sync. */
  face_thumbnail: Uint8Array | null;
  /** 0 = pending sync, 1 = synced. */
  synced: number;
  /** Retry counter for sync attempts. */
  sync_attempt: number;
  /** Record creation time, Unix timestamp ms. */
  created_at: number;
}

/** Row shape of the `sync_meta` table. SPEC §7. */
export interface SyncMetaRow {
  /** Metadata key (e.g. 'last_sync_ts', 'device_id', 'schema_version'). */
  key: string;
  /** Stringified metadata value. */
  value: string;
}
