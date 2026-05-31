import { getDb } from '../db/migrations';

export const PREF_FILL_LIGHT_LUX    = 'pref_fill_light_lux';
export const PREF_FILL_BRIGHTNESS   = 'pref_fill_brightness';
export const PREF_HAPTIC            = 'pref_haptic';
export const PREF_KEEP_AWAKE        = 'pref_keep_awake';
export const PREF_AUTO_RESTART_SECS = 'pref_auto_restart_secs';
export const PREF_SHOW_MATCH_SCORE  = 'pref_show_match_score';
export const PREF_ENROLL_VIBRATE    = 'pref_enroll_vibrate';
export const PREF_CAMERA_ZOOM       = 'pref_camera_zoom';

export const PrefsStore = {
  async getNumber(key: string, fallback: number): Promise<number> {
    try {
      const db = getDb();
      const [result] = await db.executeSql(
        'SELECT value FROM sync_meta WHERE key = ?',
        [key],
      );
      if (result.rows.length === 0) return fallback;
      const parsed = parseFloat(result.rows.item(0).value as string);
      return isNaN(parsed) ? fallback : parsed;
    } catch (e) {
      console.error('PrefsStore.getNumber', key, e);
      return fallback;
    }
  },

  async getBool(key: string, fallback: boolean): Promise<boolean> {
    try {
      const db = getDb();
      const [result] = await db.executeSql(
        'SELECT value FROM sync_meta WHERE key = ?',
        [key],
      );
      if (result.rows.length === 0) return fallback;
      return (result.rows.item(0).value as string) === '1';
    } catch (e) {
      console.error('PrefsStore.getBool', key, e);
      return fallback;
    }
  },

  async setNumber(key: string, value: number): Promise<void> {
    try {
      const db = getDb();
      await db.executeSql(
        'INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)',
        [key, String(value)],
      );
    } catch (e) {
      console.error('PrefsStore.setNumber', key, e);
    }
  },

  async setBool(key: string, value: boolean): Promise<void> {
    try {
      const db = getDb();
      await db.executeSql(
        'INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)',
        [key, value ? '1' : '0'],
      );
    } catch (e) {
      console.error('PrefsStore.setBool', key, e);
    }
  },
};
