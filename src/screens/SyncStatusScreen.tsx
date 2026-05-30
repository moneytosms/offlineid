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
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { SyncService } from '../services/SyncService';
import type { SyncResult, SyncStats } from '../services/SyncService';
import { IS_SYNC_CONFIGURED, SYNC_BASE_URL } from '../config';
import { Button, Card, Label, Mono, StatRow, Tag } from '../ui/components';
import { colors, space, type as typo } from '../ui/theme';
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
      setResult({ attempted: 0, synced: 0, failed: 0, done: false, error: String(err) });
    } finally {
      setSyncing(false);
      await loadStats();
    }
  }, [loadStats]);

  const pending = stats?.pending ?? 0;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
    >
      <View style={styles.head}>
        <Text style={typo.title}>Sync</Text>
        <View style={styles.titleRule} />
      </View>

      {/* Big pending counter. */}
      <Card style={styles.counterCard}>
        <Text style={styles.counterValue}>{pending}</Text>
        <Label>{pending === 1 ? 'RECORD QUEUED' : 'RECORDS QUEUED'}</Label>
        <View style={styles.counterTag}>
          <Tag tone={pending > 0 ? 'warn' : 'accent'}>
            {pending > 0 ? 'PENDING UPLOAD' : 'ALL CLEAR'}
          </Tag>
        </View>
      </Card>

      <Card style={styles.card}>
        <StatRow label="Last sync" value={formatLastSync(stats?.lastSync ?? null)} />
        <StatRow
          label="Backend"
          value={IS_SYNC_CONFIGURED ? 'configured' : 'placeholder'}
          tone={IS_SYNC_CONFIGURED ? 'accent' : 'warn'}
        />
        <View style={styles.endpoint}>
          <Mono style={styles.endpointText}>{SYNC_BASE_URL}</Mono>
        </View>
      </Card>

      <Button
        label={pending === 0 ? 'Nothing to sync' : `Sync ${pending} now`}
        onPress={onSync}
        loading={syncing}
        disabled={pending === 0}
        style={styles.syncBtn}
      />

      {result != null && (
        <Card
          style={[styles.resultCard, result.error ? styles.resultErr : styles.resultOk]}
        >
          <Label style={result.error ? styles.resultLabelErr : styles.resultLabelOk}>
            {result.error ? 'SYNC FAILED' : 'SYNC COMPLETE'}
          </Label>
          <Text style={styles.resultText}>
            {result.error
              ? result.error
              : `Synced ${result.synced} of ${result.attempted}` +
                (result.failed > 0 ? `, ${result.failed} failed` : '') +
                (result.done ? ' — queue empty' : ' — more pending')}
          </Text>
        </Card>
      )}

      <Text style={styles.note}>
        Records sync to AWS S3 and are purged locally once confirmed. Sync runs
        automatically when connectivity returns; pull to refresh.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.xl, paddingBottom: space.xxxl },
  head: { marginBottom: space.xl },
  titleRule: {
    marginTop: space.md,
    height: 2,
    width: 40,
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
  counterCard: { alignItems: 'center', paddingVertical: space.xxl },
  counterValue: {
    fontSize: 64,
    fontWeight: '900',
    color: colors.text,
    letterSpacing: -2,
  },
  counterTag: { marginTop: space.md },
  card: { marginTop: space.lg, paddingVertical: space.xs },
  endpoint: { paddingTop: space.md },
  endpointText: { color: colors.textDim, fontSize: 12 },
  syncBtn: { marginTop: space.xl },
  resultCard: { marginTop: space.lg, gap: space.sm },
  resultOk: { borderColor: colors.accentDim },
  resultErr: { borderColor: 'rgba(255,82,82,0.4)' },
  resultLabelOk: { color: colors.accent },
  resultLabelErr: { color: colors.danger },
  resultText: { ...typo.body, fontSize: 14, color: colors.textDim },
  note: {
    ...typo.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: space.xl,
    color: colors.textFaint,
  },
});

export default SyncStatusScreen;
