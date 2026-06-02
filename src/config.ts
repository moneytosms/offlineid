/**
 * Runtime configuration — single source for deployment-specific values
 * (SPEC §8). Kept tiny and dependency-free so both the app and tests can import
 * it without pulling native modules.
 *
 * The sync backend is read from `app.json`'s `extra.syncBaseUrl` when present,
 * falling back to the placeholder used for offline-only testing. Point this at
 * the real Datalake 3.0 / AWS endpoint before enabling online sync.
 *
 * @module config
 */

import appConfig from '../app.json';

/** App version surfaced in Settings / About. */
export const APP_VERSION = '1.4.0';

/** Placeholder backend — offline auth works; real upload requires a live URL. */
const DEFAULT_SYNC_BASE_URL = 'https://api.datalake.example.com';

/** Shape of the optional `extra` block we read from `app.json`. */
interface AppExtra {
  syncBaseUrl?: string;
}

const extra = (appConfig as { extra?: AppExtra }).extra ?? {};

/** Backend base URL for sync endpoints (SPEC §8.1). */
export const SYNC_BASE_URL: string = extra.syncBaseUrl ?? DEFAULT_SYNC_BASE_URL;

/** Whether a real (non-placeholder) sync backend is configured. */
export const IS_SYNC_CONFIGURED: boolean =
  SYNC_BASE_URL !== DEFAULT_SYNC_BASE_URL;
