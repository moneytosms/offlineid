/**
 * CRUD for enrolled face embeddings (`face_embeddings` table, SPEC §7, §10).
 *
 * Embeddings are AES-256-GCM encrypted (via {@link encryptEmbedding}) before
 * they ever touch SQLite, and decrypted on read. The encrypted bytes are
 * persisted as a lowercase hex string inside the BLOB column, because the
 * `react-native-sqlite-storage` bridge marshals SQL parameters as JS strings
 * and does not reliably round-trip raw `Uint8Array` values.
 *
 * @module services/EmbeddingStore
 */

import { v4 as uuidv4 } from 'uuid';

import { getDb } from '../db/migrations';
import { encryptEmbedding, decryptEmbedding } from '../utils/crypto';

/** Result of {@link EmbeddingStore.getAllEmbeddings}. */
export interface EnrolledEmbedding {
  /** Datalake 3.0 employee identifier. */
  employeeId: string;
  /** Display name. */
  name: string;
  /** Decrypted 512-dim L2-normalised embedding. */
  embedding: Float32Array;
}

/** Lightweight enrolment metadata (no embedding decrypt). */
export interface EnrolledPerson {
  /** Datalake 3.0 employee identifier. */
  employeeId: string;
  /** Display name. */
  name: string;
  /** Department label, or null. */
  department: string | null;
  /** Enrolment time, Unix timestamp ms. */
  enrolledAt: number;
}

/** Encode raw bytes to a lowercase hex string. */
function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Decode a lowercase hex string back to bytes. Throws on malformed hex. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('hexToBytes: odd-length hex string (corrupt BLOB)');
  }
  const len = hex.length >> 1;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error('hexToBytes: invalid hex digit (corrupt BLOB)');
    }
    bytes[i] = byte;
  }
  return bytes;
}

/**
 * Store for enrolled face embeddings.
 */
export const EmbeddingStore = {
  /**
   * Enrol a person: encrypt their embedding and INSERT a new row.
   *
   * @param employeeId - Unique Datalake 3.0 employee identifier.
   * @param name - Display name.
   * @param department - Department label, or null.
   * @param embedding - 512-dim L2-normalised enrolment embedding (SPEC §10).
   * @returns The generated UUID v4 row id.
   */
  async enrol(
    employeeId: string,
    name: string,
    department: string | null,
    embedding: Float32Array,
  ): Promise<string> {
    const id = uuidv4();
    const encrypted = await encryptEmbedding(embedding);
    const blobHex = bytesToHex(encrypted);
    const enrolledAt = Date.now();

    const db = getDb();
    await db.executeSql(
      `INSERT INTO face_embeddings
         (id, employee_id, name, department, embedding, enrolled_at, version)
       VALUES (?, ?, ?, ?, ?, ?, 1);`,
      [id, employeeId, name, department, blobHex, enrolledAt],
    );
    return id;
  },

  /**
   * Load and decrypt all enrolled embeddings for matching.
   *
   * @returns One entry per enrolled person.
   */
  async getAllEmbeddings(): Promise<EnrolledEmbedding[]> {
    const db = getDb();
    const [result] = await db.executeSql(
      `SELECT employee_id, name, embedding FROM face_embeddings;`,
    );

    const out: EnrolledEmbedding[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows.item(i);
      const bytes = hexToBytes(row.embedding as string);
      const embedding = await decryptEmbedding(bytes);
      out.push({
        employeeId: row.employee_id as string,
        name: row.name as string,
        embedding,
      });
    }
    return out;
  },

  /**
   * List enrolment metadata (no embedding decryption), newest first.
   *
   * @returns One {@link EnrolledPerson} per enrolled row.
   */
  async listEnrolled(): Promise<EnrolledPerson[]> {
    const db = getDb();
    const [result] = await db.executeSql(
      `SELECT employee_id, name, department, enrolled_at
       FROM face_embeddings ORDER BY enrolled_at DESC;`,
    );
    const out: EnrolledPerson[] = [];
    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows.item(i);
      out.push({
        employeeId: row.employee_id as string,
        name: row.name as string,
        department: (row.department as string | null) ?? null,
        enrolledAt: row.enrolled_at as number,
      });
    }
    return out;
  },

  /** Count enrolled people. */
  async count(): Promise<number> {
    const db = getDb();
    const [result] = await db.executeSql(
      `SELECT COUNT(*) AS cnt FROM face_embeddings;`,
    );
    return result.rows.item(0).cnt as number;
  },

  /**
   * Delete an enrolled person by employee id.
   *
   * @param employeeId - Employee identifier to remove.
   * @returns Number of rows deleted.
   */
  async deleteByEmployeeId(employeeId: string): Promise<number> {
    const db = getDb();
    const [result] = await db.executeSql(
      `DELETE FROM face_embeddings WHERE employee_id = ?;`,
      [employeeId],
    );
    return result.rowsAffected;
  },

  /** Delete all enrolments (factory reset). Returns rows removed. */
  async deleteAll(): Promise<number> {
    const db = getDb();
    const [result] = await db.executeSql(`DELETE FROM face_embeddings;`);
    return result.rowsAffected;
  },
};

export default EmbeddingStore;
