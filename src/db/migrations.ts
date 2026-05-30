/**
 * SQLite database open + idempotent migrations for OfflineID.
 *
 * Uses `react-native-sqlite-storage`. The database handle is a process-wide
 * singleton; call {@link openDatabase} once at app start, then use
 * {@link getDb} everywhere else.
 *
 * Migrations are idempotent: every table is created with
 * `CREATE TABLE IF NOT EXISTS` (see {@link ALL_TABLES}) and the applied
 * schema version is tracked in `sync_meta` under the key `schema_version`.
 *
 * @module db/migrations
 */

import SQLite, {
  type SQLiteDatabase,
  type Transaction,
} from 'react-native-sqlite-storage';

import { ALL_TABLES } from './schema';

// `react-native-sqlite-storage` ships a single CommonJS default export; its
// functions are NOT named exports, so under Hermes `import { enablePromise }`
// resolves to `undefined`. Always call through the default object.
const { enablePromise, openDatabase: sqliteOpenDatabase, DEBUG } = SQLite;

/** Current schema version. Bump when {@link ALL_TABLES} changes. */
export const SCHEMA_VERSION = 1;

/** `sync_meta` key under which the applied schema version is stored. */
export const SCHEMA_VERSION_KEY = 'schema_version';

const DB_NAME = 'offlineid.db';

// Use promise-based API throughout.
enablePromise(true);
DEBUG(false);

let dbInstance: SQLiteDatabase | null = null;

/**
 * Open (or return the already-open) singleton database and run migrations.
 *
 * @returns The shared {@link SQLiteDatabase} handle.
 */
export async function openDatabase(): Promise<SQLiteDatabase> {
  if (dbInstance) {
    return dbInstance;
  }
  const db = await sqliteOpenDatabase({
    name: DB_NAME,
    location: 'default',
  });
  await runMigrations(db);
  dbInstance = db;
  return dbInstance;
}

/**
 * Apply all schema migrations idempotently.
 *
 * Creates every table via `CREATE TABLE IF NOT EXISTS` and records the
 * applied version in `sync_meta`. Safe to call repeatedly.
 *
 * @param db - An open database handle.
 */
export async function runMigrations(db: SQLiteDatabase): Promise<void> {
  await db.transaction((tx: Transaction) => {
    for (const stmt of ALL_TABLES) {
      tx.executeSql(stmt);
    }
    // Record the schema version; INSERT OR REPLACE keeps this idempotent.
    tx.executeSql(
      `INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?);`,
      [SCHEMA_VERSION_KEY, String(SCHEMA_VERSION)],
    );
  });
}

/**
 * Get the open singleton database handle.
 *
 * @throws If called before {@link openDatabase} has resolved.
 * @returns The shared {@link SQLiteDatabase} handle.
 */
export function getDb(): SQLiteDatabase {
  if (!dbInstance) {
    throw new Error(
      'Database not initialised. Call openDatabase() before getDb().',
    );
  }
  return dbInstance;
}

/**
 * Close and clear the singleton handle. Primarily for tests/teardown.
 */
export async function closeDatabase(): Promise<void> {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
  }
}
