/**
 * Sync status screen (SPEC §8.2, ARCHITECTURE §3.3).
 *
 * Shows the pending (unsynced) record count and the last successful sync time,
 * and offers a manual sync button that calls {@link SyncService.syncPendingRecords}
 * with loading and result states.
 *
 * @module screens/SyncStatusScreen
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { SyncService } from '../services/SyncService';
import type { SyncResult, SyncStats } from '../services/SyncService';
import { logger } from '../utils/logger';

const TAG = 'SyncStatus';

/** Format an epoch Date for display, or a dash when null. */
function formatLastSync(date: Date | null): string {
  return date ? date.toLocaleString() : 'Never';
}

/**
 * Manual sync + status screen. Loads stats on mount, supports pull-to-refresh,
 * and a sync button that drains pending records and reports the outcome.
 */
export function SyncStatusScreen(): React.JSX.Element {
  const [stats, setStats] = useState<SyncStats | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);

  const loadStats = useCallback(async (): Promise<void> => {
    try {
      setStats(await SyncService.getSyncStats());
    } catch (err) {
      logger.error(TAG, 'getSyncStats failed', err);
    }
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const onRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await loadStats();
    setRefreshing(false);
  }, [loadStats]);

  const onSync = useCallback(async (): Promise<void> => {
    setSyncing(true);
    setResult(null);
    try {
      const res = await SyncService.syncPendingRecords();
      setResult(res);
      logger.info(TAG, `sync result synced=${res.synced} failed=${res.failed}`);
    } catch (err) {
      logger.error(TAG, 'manual sync failed', err);
      setResult({
        attempted: 0,
        synced: 0,
        failed: 0,
        done: false,
        error: String(err),
      });
    } finally {
      setSyncing(false);
      await loadStats();
    }
  }, [loadStats]);

  const pending = stats?.pending ?? 0;

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      <Text style={styles.heading}>Sync Status</Text>

      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Pending records</Text>
        <Text
          style={[styles.statValue, pending > 0 && styles.statValueAlert]}
          accessibilityLabel={`${pending} pending records`}
        >
          {pending}
        </Text>
      </View>

      <View style={styles.statRow}>
        <Text style={styles.statLabel}>Last sync</Text>
        <Text style={styles.statValue}>
          {formatLastSync(stats?.lastSync ?? null)}
        </Text>
      </View>

      <TouchableOpacity
        style={[styles.button, (syncing || pending === 0) && styles.buttonDisabled]}
        disabled={syncing || pending === 0}
        onPress={onSync}
        accessibilityRole="button"
        accessibilityLabel="Sync now"
        accessibilityState={{ disabled: syncing || pending === 0, busy: syncing }}
      >
        {syncing ? (
          <ActivityIndicator color="#FFF" />
        ) : (
          <Text style={styles.buttonText}>
            {pending === 0 ? 'Nothing to sync' : 'Sync now'}
          </Text>
        )}
      </TouchableOpacity>

      {result != null && (
        <View
          style={[
            styles.resultCard,
            result.error ? styles.resultError : styles.resultOk,
          ]}
          accessibilityLiveRegion="polite"
        >
          {result.error ? (
            <Text style={styles.resultText}>Sync failed: {result.error}</Text>
          ) : (
            <Text style={styles.resultText}>
              Synced {result.synced} of {result.attempted}
              {result.failed > 0 ? `, ${result.failed} failed` : ''}
              {result.done ? ' — queue empty' : ' — more pending'}
            </Text>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#FFF', flexGrow: 1 },
  heading: { fontSize: 24, fontWeight: '700', marginBottom: 24, color: '#111' },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E0E0E0',
  },
  statLabel: { fontSize: 16, color: '#555' },
  statValue: { fontSize: 16, fontWeight: '600', color: '#111' },
  statValueAlert: { color: '#E53935' },
  button: {
    marginTop: 28,
    backgroundColor: '#1565C0',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonDisabled: { backgroundColor: '#90A4AE' },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: '600' },
  resultCard: { marginTop: 20, padding: 16, borderRadius: 10 },
  resultOk: { backgroundColor: '#E8F5E9' },
  resultError: { backgroundColor: '#FFEBEE' },
  resultText: { fontSize: 14, color: '#111' },
});

export default SyncStatusScreen;
