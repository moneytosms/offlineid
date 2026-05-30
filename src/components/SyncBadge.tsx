/**
 * Unsynced-record count indicator (SPEC §8.2, ARCHITECTURE §3.3).
 *
 * Polls {@link SyncService.getSyncStats} on an interval and shows the pending
 * count with a red dot when anything is queued. Intended for a header/toolbar.
 *
 * @module components/SyncBadge
 */

import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { SyncService } from '../services/SyncService';
import { colors, MONO } from '../ui/theme';
import { logger } from '../utils/logger';

const TAG = 'SyncBadge';

/** Default poll interval. */
const DEFAULT_POLL_MS = 5_000;

/** {@link SyncBadge} props. */
export interface SyncBadgeProps {
  /** Poll interval in ms (default 5000). */
  pollIntervalMs?: number;
}

/**
 * Self-polling badge showing the number of pending (unsynced) records. Renders
 * a red dot while `pending > 0`; otherwise a muted "Synced" state.
 */
export function SyncBadge({
  pollIntervalMs = DEFAULT_POLL_MS,
}: SyncBadgeProps): React.JSX.Element {
  const [pending, setPending] = useState(0);

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
    const tick = (): void => {
      if (active) void refresh();
    };
    tick();
    const handle = setInterval(tick, pollIntervalMs);
    return () => {
      active = false;
      clearInterval(handle);
    };
  }, [refresh, pollIntervalMs]);

  const hasPending = pending > 0;

  return (
    <View
      style={styles.container}
      accessibilityRole="text"
      accessibilityLabel={
        hasPending ? `${pending} records pending sync` : 'All records synced'
      }
    >
      <View style={[styles.dot, hasPending ? styles.dotPending : styles.dotOk]} />
      <Text style={[styles.label, hasPending ? styles.pending : styles.synced]}>
        {hasPending ? `${pending} QUEUED` : 'SYNCED'}
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
  dotPending: { backgroundColor: colors.warn },
  dotOk: { backgroundColor: colors.accent },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: MONO,
  },
  pending: { color: colors.warn },
  synced: { color: colors.textDim },
});

export default SyncBadge;
