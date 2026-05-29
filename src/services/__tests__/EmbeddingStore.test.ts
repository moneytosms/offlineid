/**
 * Unit tests for EmbeddingStore + AttendanceStore against an in-memory mock
 * of `react-native-sqlite-storage` and stubbed crypto helpers.
 *
 * @module services/__tests__/EmbeddingStore.test
 */

import { encryptEmbedding, decryptEmbedding } from '../../utils/crypto';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Deterministic, sequential UUIDs.
let mockUuidCounter = 0;
jest.mock('uuid', () => ({
  v4: () => `uuid-${++mockUuidCounter}`,
}));

// Reversible crypto stub: serialise the Float32Array bytes 1:1.
jest.mock('../../utils/crypto', () => ({
  encryptEmbedding: jest.fn(async (vec: Float32Array) => {
    return new Uint8Array(vec.buffer.slice(0));
  }),
  decryptEmbedding: jest.fn(async (bytes: Uint8Array) => {
    const copy = new Uint8Array(bytes); // ensure 4-byte aligned buffer
    return new Float32Array(copy.buffer);
  }),
}));

/**
 * Minimal in-memory SQL engine supporting exactly the statements our stores
 * issue: INSERT, SELECT (with/without WHERE), DELETE ... IN, COUNT(*).
 */
interface AnyRow {
  [k: string]: unknown;
}

class MockDb {
  faceEmbeddings: AnyRow[] = [];
  attendanceLog: AnyRow[] = [];

  async executeSql(sql: string, params: unknown[] = []): Promise<[MockResult]> {
    const s = sql.trim();

    if (s.startsWith('INSERT INTO face_embeddings')) {
      const [id, employee_id, name, department, embedding, enrolled_at] =
        params;
      this.faceEmbeddings.push({
        id,
        employee_id,
        name,
        department,
        embedding,
        enrolled_at,
        version: 1,
      });
      return [new MockResult([], 1)];
    }

    if (s.startsWith('SELECT employee_id, name, embedding FROM face_embeddings')) {
      return [new MockResult(this.faceEmbeddings.slice(), 0)];
    }

    if (s.startsWith('DELETE FROM face_embeddings WHERE employee_id')) {
      const before = this.faceEmbeddings.length;
      this.faceEmbeddings = this.faceEmbeddings.filter(
        r => r.employee_id !== params[0],
      );
      return [new MockResult([], before - this.faceEmbeddings.length)];
    }

    if (s.startsWith('INSERT INTO attendance_log')) {
      const [
        id,
        employee_id,
        event_type,
        timestamp,
        location_lat,
        location_lon,
        device_id,
        confidence,
        liveness_score,
        face_thumbnail,
        created_at,
      ] = params;
      this.attendanceLog.push({
        id,
        employee_id,
        event_type,
        timestamp,
        location_lat,
        location_lon,
        device_id,
        confidence,
        liveness_score,
        face_thumbnail,
        synced: 0,
        sync_attempt: 0,
        created_at,
      });
      return [new MockResult([], 1)];
    }

    if (s.startsWith('SELECT * FROM attendance_log') && s.includes('synced = 0')) {
      const limit = (params[0] as number) ?? Infinity;
      const rows = this.attendanceLog
        .filter(r => r.synced === 0)
        .sort((a, b) => (a.created_at as number) - (b.created_at as number))
        .slice(0, limit);
      return [new MockResult(rows, 0)];
    }

    if (
      s.startsWith('SELECT * FROM attendance_log') &&
      s.includes("event_type = 'failed_attempt'")
    ) {
      const rows = this.attendanceLog
        .filter(r => r.event_type === 'failed_attempt')
        .sort((a, b) => (b.created_at as number) - (a.created_at as number));
      return [new MockResult(rows, 0)];
    }

    if (s.startsWith('DELETE FROM attendance_log WHERE id IN')) {
      const before = this.attendanceLog.length;
      const idSet = new Set(params);
      this.attendanceLog = this.attendanceLog.filter(r => !idSet.has(r.id));
      return [new MockResult([], before - this.attendanceLog.length)];
    }

    if (s.startsWith('SELECT COUNT(*) AS cnt FROM attendance_log')) {
      const cnt = this.attendanceLog.filter(r => r.synced === 0).length;
      return [new MockResult([{ cnt }], 0)];
    }

    throw new Error(`Unhandled SQL in mock: ${s}`);
  }
}

class MockResult {
  rowsAffected: number;
  rows: {
    length: number;
    item: (i: number) => AnyRow;
  };

  constructor(rows: AnyRow[], rowsAffected: number) {
    this.rowsAffected = rowsAffected;
    this.rows = {
      length: rows.length,
      item: (i: number) => rows[i],
    };
  }
}

let mockDb: MockDb;

// getDb() returns our in-memory engine; bypass the real openDatabase path.
jest.mock('../../db/migrations', () => ({
  getDb: () => mockDb,
}));

// Import after mocks are registered.
import EmbeddingStore from '../EmbeddingStore';
import AttendanceStore from '../AttendanceStore';

beforeEach(() => {
  mockDb = new MockDb();
  mockUuidCounter = 0;
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// EmbeddingStore
// ---------------------------------------------------------------------------

describe('EmbeddingStore', () => {
  it('enrol → getAllEmbeddings round-trips the embedding', async () => {
    const vec = new Float32Array([0.1, -0.2, 0.3, 0.4, -0.5]);

    const id = await EmbeddingStore.enrol('E001', 'Asha Rao', 'Field', vec);
    expect(id).toBe('uuid-1');
    expect(encryptEmbedding).toHaveBeenCalledTimes(1);

    const all = await EmbeddingStore.getAllEmbeddings();
    expect(all).toHaveLength(1);
    expect(all[0].employeeId).toBe('E001');
    expect(all[0].name).toBe('Asha Rao');
    expect(decryptEmbedding).toHaveBeenCalledTimes(1);

    // Float32 values survive the encrypt → hex BLOB → decrypt round-trip.
    expect(Array.from(all[0].embedding)).toEqual(
      Array.from(vec).map(v => Math.fround(v)),
    );
  });

  it('deleteByEmployeeId removes the row', async () => {
    await EmbeddingStore.enrol('E001', 'A', null, new Float32Array([1]));
    await EmbeddingStore.enrol('E002', 'B', null, new Float32Array([2]));

    const deleted = await EmbeddingStore.deleteByEmployeeId('E001');
    expect(deleted).toBe(1);

    const all = await EmbeddingStore.getAllEmbeddings();
    expect(all.map(r => r.employeeId)).toEqual(['E002']);
  });
});

// ---------------------------------------------------------------------------
// AttendanceStore
// ---------------------------------------------------------------------------

describe('AttendanceStore', () => {
  const base = {
    employee_id: 'E001',
    event_type: 'check_in' as const,
    timestamp: 1000,
    device_id: 'DEV-1',
  };

  it('logEvent writes synced=0 and getPendingCount counts it', async () => {
    const id = await AttendanceStore.logEvent(base);
    expect(id).toBe('uuid-1');
    expect(await AttendanceStore.getPendingCount()).toBe(1);
  });

  it('markSynced removes the rows it is given', async () => {
    const id1 = await AttendanceStore.logEvent({ ...base, timestamp: 1 });
    const id2 = await AttendanceStore.logEvent({ ...base, timestamp: 2 });
    const id3 = await AttendanceStore.logEvent({ ...base, timestamp: 3 });

    expect(await AttendanceStore.getPendingCount()).toBe(3);

    const removed = await AttendanceStore.markSynced([id1, id3]);
    expect(removed).toBe(2);

    const pending = await AttendanceStore.getPendingRecords();
    expect(pending.map(r => r.id)).toEqual([id2]);
    expect(await AttendanceStore.getPendingCount()).toBe(1);
  });

  it('markSynced with empty list is a no-op', async () => {
    await AttendanceStore.logEvent(base);
    const removed = await AttendanceStore.markSynced([]);
    expect(removed).toBe(0);
    expect(await AttendanceStore.getPendingCount()).toBe(1);
  });

  it('getPendingRecords honours the limit and ordering', async () => {
    await AttendanceStore.logEvent({ ...base, timestamp: 30 });
    await AttendanceStore.logEvent({ ...base, timestamp: 10 });
    await AttendanceStore.logEvent({ ...base, timestamp: 20 });

    const pending = await AttendanceStore.getPendingRecords(2);
    expect(pending).toHaveLength(2);
    // created_at is Date.now() at insert time → insertion order preserved.
    expect(pending[0].timestamp).toBe(30);
    expect(pending[1].timestamp).toBe(10);
  });

  it('getFailedAttempts filters by event_type', async () => {
    await AttendanceStore.logEvent({ ...base, event_type: 'check_in' });
    await AttendanceStore.logEvent({ ...base, event_type: 'failed_attempt' });

    const failed = await AttendanceStore.getFailedAttempts();
    expect(failed).toHaveLength(1);
    expect(failed[0].event_type).toBe('failed_attempt');
  });
});
