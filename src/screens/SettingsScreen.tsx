/**
 * System / settings screen.
 *
 * Read-only operational config (device, sync endpoint, model + matching
 * parameters) plus a destructive "factory reset" that purges local data. Most
 * values are sourced from code constants so the screen documents the live
 * configuration rather than duplicating it.
 *
 * @module screens/SettingsScreen
 */

import React, {useCallback, useEffect, useState} from 'react';
import {Alert, StyleSheet, Text, View} from 'react-native';

import {Button, Card, Label, Mono, Screen, StatRow, Tag} from '../ui/components';
import {colors, space, type as typo} from '../ui/theme';
import {SYNC_BASE_URL, IS_SYNC_CONFIGURED, APP_VERSION} from '../config';
import {
  MATCH_THRESHOLD,
  UNCERTAIN_THRESHOLD,
  MAX_CONSECUTIVE_FAILS,
} from '../hooks/useFaceAuth';
import {
  PASSIVE_LIVENESS_THRESHOLD,
  GESTURE_SEQUENCE_LENGTH,
} from '../services/LivenessService';
import {EmbeddingStore} from '../services/EmbeddingStore';
import {AttendanceStore} from '../services/AttendanceStore';
import {logger} from '../utils/logger';

const TAG = 'Settings';

/** {@link SettingsScreen} props. */
export interface SettingsScreenProps {
  /** Device identifier shown in the operational block. */
  deviceId: string;
  /** Open the About view. */
  onOpenAbout: () => void;
}

/** Operational config + factory reset. */
export function SettingsScreen({
  deviceId,
  onOpenAbout,
}: SettingsScreenProps): React.JSX.Element {
  const [counts, setCounts] = useState({people: 0, pending: 0});

  const load = useCallback(async (): Promise<void> => {
    try {
      const [people, pending] = await Promise.all([
        EmbeddingStore.count(),
        AttendanceStore.getPendingCount(),
      ]);
      setCounts({people, pending});
    } catch (err) {
      logger.error(TAG, 'load counts failed', err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const factoryReset = useCallback((): void => {
    Alert.alert(
      'Factory reset',
      'Erase ALL enrolments and queued attendance from this device? This cannot be undone.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Erase everything',
          style: 'destructive',
          onPress: () => {
            Promise.all([EmbeddingStore.deleteAll(), AttendanceStore.deleteAll()])
              .then(load)
              .then(() => Alert.alert('Done', 'Local data erased.'))
              .catch(err => logger.error(TAG, 'reset failed', err));
          },
        },
      ],
    );
  }, [load]);

  return (
    <Screen title="System" subtitle="Operational configuration">
      <Label>Device</Label>
      <Card style={styles.card}>
        <StatRow label="Device ID" value={deviceId} />
        <StatRow label="App version" value={`v${APP_VERSION}`} />
        <StatRow label="Enrolled" value={String(counts.people)} tone="accent" />
        <StatRow
          label="Queued records"
          value={String(counts.pending)}
          tone={counts.pending > 0 ? 'warn' : undefined}
        />
      </Card>

      <Label style={styles.section}>Sync endpoint</Label>
      <Card style={styles.card}>
        <View style={styles.endpointRow}>
          <Mono style={styles.endpoint}>{SYNC_BASE_URL}</Mono>
          <Tag tone={IS_SYNC_CONFIGURED ? 'accent' : 'warn'}>
            {IS_SYNC_CONFIGURED ? 'LIVE' : 'PLACEHOLDER'}
          </Tag>
        </View>
        <Text style={styles.note}>
          Set in app.json → extra.syncBaseUrl. Records sync to S3 then purge
          locally when a real backend is configured.
        </Text>
      </Card>

      <Label style={styles.section}>AI engine</Label>
      <Card style={styles.card}>
        <StatRow label="Detector" value="SCRFD-500M" />
        <StatRow label="Recogniser" value="MobileFaceNet INT8" />
        <StatRow label="Liveness" value="FASNet 2.7 + 4.0" />
        <StatRow label="Embedding dim" value="512" />
        <StatRow label="Execution" value="ONNX · CPU · offline" tone="accent" />
      </Card>

      <Label style={styles.section}>Matching & liveness</Label>
      <Card style={styles.card}>
        <StatRow label="Match threshold" value={MATCH_THRESHOLD.toFixed(2)} />
        <StatRow label="Uncertain band" value={`≥ ${UNCERTAIN_THRESHOLD.toFixed(2)}`} />
        <StatRow
          label="Passive liveness"
          value={`> ${PASSIVE_LIVENESS_THRESHOLD.toFixed(2)}`}
        />
        <StatRow label="Gesture challenge" value={`${GESTURE_SEQUENCE_LENGTH} in sequence`} />
        <StatRow label="Lockout after" value={`${MAX_CONSECUTIVE_FAILS} fails`} tone="warn" />
      </Card>

      <Label style={styles.section}>Security</Label>
      <Card style={styles.card}>
        <Text style={styles.note}>
          Faceprints are encrypted at rest with AES-256-GCM; the key lives in the
          platform keystore. Raw face images are never stored. All inference runs
          on-device — nothing leaves the phone until you sync.
        </Text>
      </Card>

      <View style={styles.actions}>
        <Button label="About OfflineID" variant="secondary" onPress={onOpenAbout} />
        <Button label="Factory reset" variant="danger" onPress={factoryReset} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {marginTop: space.sm, paddingVertical: space.xs},
  section: {marginTop: space.xl},
  endpointRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.md,
    gap: space.md,
  },
  endpoint: {flex: 1, fontSize: 12, color: colors.text},
  note: {
    ...typo.muted,
    lineHeight: 19,
    paddingVertical: space.sm,
  },
  actions: {marginTop: space.xl, gap: space.md},
});

export default SettingsScreen;
