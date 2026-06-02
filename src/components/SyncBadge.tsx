/**
 * Network connectivity + sync-queue status indicator (SPEC §8.2, ARCHITECTURE §3.3).
 *
 * Shows online/offline status (via NetInfo) and unsynced record count.
 * Polls {@link SyncService.getSyncStats} for pending count and subscribes to
 * NetInfo for live connectivity state.
 *
 * @module components/SyncBadge
 */

import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

import { SyncService } from '../services/SyncService';
import { colors, MONO } from '../ui/theme';
import { logger } from '../utils/logger';

const TAG = 'SyncBadge';

/** Default poll interval for pending count. */
const DEFAULT_POLL_MS = 5_000;

/** {@link SyncBadge} props. */
export interface SyncBadgeProps {
  /** Poll interval in ms (default 5000). */
  pollIntervalMs?: number;
}

/**
 * Self-polling badge showing network status and pending (unsynced) record count.
 *
 * - Offline: amber dot + "OFFLINE"
 * - Online, nothing queued: sky-blue dot + "ONLINE"
 * - Online, records queued: sky-blue dot + "ONLINE · N QUEUED"
 */
export function SyncBadge({
  pollIntervalMs = DEFAULT_POLL_MS,
}: SyncBadgeProps): React.JSX.Element {
  const [pending, setPending] = useState(0);
  const [isOnline, setIsOnline] = useState(true);

  // Poll pending count.
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const stats = await SyncService.getSyncStats();
      setPending(stats.pending);
    } catch (err) {
      logger.warn(TAG, 'getSyncStats failed', err);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const tick = (): void => { if (active) void refresh(); };
    tick();
    const handle = setInterval(tick, pollIntervalMs);
    return () => {
      active = false;
      clearInterval(handle);
    };
  }, [refresh, pollIntervalMs]);

  // Subscribe to network state.
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      setIsOnline(Boolean(state.isConnected));
    });
    return () => unsubscribe();
  }, []);

  const hasPending = pending > 0;

  const label = isOnline
    ? hasPending
      ? `ONLINE · ${pending} QUEUED`
      : 'ONLINE'
    : 'OFFLINE';

  const accessLabel = isOnline
    ? hasPending
      ? `Online - ${pending} records queued`
      : 'Online - synced'
    : hasPending
    ? `Offline - ${pending} records queued`
    : 'Offline - synced';

  return (
    <View
      style={styles.container}
      accessibilityRole="text"
      accessibilityLabel={accessLabel}
    >
      <View style={[styles.dot, isOnline ? styles.dotOnline : styles.dotOffline]} />
      <Text style={[styles.label, isOnline ? styles.online : styles.offline]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginRight: 6,
  },
  dotOnline: { backgroundColor: colors.accent },
  dotOffline: { backgroundColor: colors.warn },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 1, fontFamily: MONO },
  online: { color: colors.accent },
  offline: { color: colors.warn },
});

export default SyncBadge;
