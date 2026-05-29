/**
 * Network-driven sync trigger (SPEC §8.4, ARCHITECTURE §3.3).
 *
 * Subscribes to `@react-native-community/netinfo`. When connectivity is
 * restored (`isConnected && isInternetReachable`) on a rising edge, it drains
 * the offline queue via {@link SyncService.syncAll}. A re-entrancy guard
 * prevents overlapping syncs from rapid connectivity flapping.
 *
 * @module hooks/useNetworkSync
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import type { NetInfoState } from '@react-native-community/netinfo';

import { SyncService } from '../services/SyncService';
import type { SyncResult } from '../services/SyncService';
import { logger } from '../utils/logger';

const TAG = 'NetworkSync';

/** Public hook surface. */
export interface UseNetworkSync {
  /** Whether the device currently has reachable internet. */
  isOnline: boolean;
  /** Whether a sync pass is in flight. */
  isSyncing: boolean;
  /** Result of the most recent sync pass, or null. */
  lastResult: SyncResult | null;
  /** Manually trigger a queue drain (e.g. SyncStatusScreen button). */
  syncNow: () => Promise<void>;
}

/**
 * Auto-sync the offline queue when the network reconnects.
 *
 * @param enabled - Gate auto-sync (default true). When false only `syncNow`
 *   triggers a sync.
 * @returns Connectivity + sync state and a manual trigger.
 */
export function useNetworkSync(enabled = true): UseNetworkSync {
  const [isOnline, setIsOnline] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);

  const syncing = useRef(false); // re-entrancy guard
  const wasOnline = useRef(false); // rising-edge detection

  const runSync = useCallback(async (): Promise<void> => {
    if (syncing.current) {
      logger.debug(TAG, 'sync already in progress; skipping');
      return;
    }
    syncing.current = true;
    setIsSyncing(true);
    try {
      const result = await SyncService.syncAll();
      setLastResult(result);
      logger.info(TAG, 'sync complete', result);
    } catch (err) {
      logger.error(TAG, 'sync threw', err);
    } finally {
      syncing.current = false;
      setIsSyncing(false);
    }
  }, []);

  const syncNow = useCallback(async (): Promise<void> => {
    await runSync();
  }, [runSync]);

  useEffect(() => {
    const handle = (state: NetInfoState): void => {
      const online = Boolean(state.isConnected && state.isInternetReachable);
      setIsOnline(online);

      // Trigger only on the rising edge offline → online.
      if (enabled && online && !wasOnline.current) {
        logger.info(TAG, 'connectivity restored → syncing');
        void runSync();
      }
      wasOnline.current = online;
    };

    const unsubscribe = NetInfo.addEventListener(handle);
    return () => unsubscribe();
  }, [enabled, runSync]);

  return { isOnline, isSyncing, lastResult, syncNow };
}

export default useNetworkSync;
