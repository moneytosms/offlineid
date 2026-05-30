/**
 * People / enrolment directory (SPEC §10).
 *
 * Lists enrolled personnel (metadata only — embeddings stay encrypted), shows
 * the roster count, and supports removing an enrolment with confirmation.
 *
 * @module screens/PeopleScreen
 */

import React, {useCallback, useEffect, useState} from 'react';
import {
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {EmbeddingStore} from '../services/EmbeddingStore';
import type {EnrolledPerson} from '../services/EmbeddingStore';
import {Button, Card, Label, Mono, Tag} from '../ui/components';
import {colors, MONO, radius, space, type as typo} from '../ui/theme';
import {logger} from '../utils/logger';

const TAG = 'People';

/** Initials for the avatar chip. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/** Short date for the enrolment timestamp. */
function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

/** {@link PeopleScreen} props. */
export interface PeopleScreenProps {
  /** Navigate to the enrolment flow. */
  onEnrolNew: () => void;
}

/** Enrolment directory with per-row removal. */
export function PeopleScreen({onEnrolNew}: PeopleScreenProps): React.JSX.Element {
  const [people, setPeople] = useState<EnrolledPerson[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    try {
      setPeople(await EmbeddingStore.listEnrolled());
    } catch (err) {
      logger.error(TAG, 'listEnrolled failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmDelete = useCallback(
    (person: EnrolledPerson): void => {
      Alert.alert(
        'Remove enrolment',
        `Delete ${person.name} (${person.employeeId})? Their faceprint will be erased from this device.`,
        [
          {text: 'Cancel', style: 'cancel'},
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              EmbeddingStore.deleteByEmployeeId(person.employeeId)
                .then(load)
                .catch(err => logger.error(TAG, 'delete failed', err));
            },
          },
        ],
      );
    },
    [load],
  );

  const renderItem = useCallback(
    ({item}: {item: EnrolledPerson}) => (
      <Card style={styles.row}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(item.name)}</Text>
        </View>
        <View style={styles.rowBody}>
          <Text style={styles.name}>{item.name}</Text>
          <Mono style={styles.empId}>{item.employeeId}</Mono>
          <View style={styles.metaRow}>
            {item.department != null && item.department !== '' && (
              <Tag tone="muted">{item.department}</Tag>
            )}
            <Text style={styles.enrolled}>enrolled {fmtDate(item.enrolledAt)}</Text>
          </View>
        </View>
        <TouchableOpacity
          style={styles.delBtn}
          onPress={() => confirmDelete(item)}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${item.name}`}>
          <Text style={styles.delGlyph}>✕</Text>
        </TouchableOpacity>
      </Card>
    ),
    [confirmDelete],
  );

  return (
    <View style={styles.container}>
      <View style={styles.head}>
        <View>
          <Text style={typo.title}>Personnel</Text>
          <View style={styles.titleRule} />
        </View>
        <Tag tone={people.length > 0 ? 'accent' : 'muted'}>
          {people.length} ENROLLED
        </Tag>
      </View>

      <FlatList
        data={people}
        keyExtractor={p => p.employeeId}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          loading ? null : (
            <View style={styles.empty}>
              <Text style={styles.emptyGlyph}>◎</Text>
              <Text style={styles.emptyTitle}>No one enrolled yet</Text>
              <Label style={styles.emptySub}>
                Enrol a person to start authenticating
              </Label>
            </View>
          )
        }
      />

      <View style={styles.footer}>
        <Button label="＋  Enrol new person" onPress={onEnrolNew} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg, padding: space.xl},
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.lg,
  },
  titleRule: {
    marginTop: space.md,
    height: 2,
    width: 40,
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
  list: {paddingBottom: space.xxl, gap: space.md},
  row: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  avatar: {
    width: 46,
    height: 46,
    borderRadius: radius.md,
    backgroundColor: colors.accentDim,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {color: colors.accent, fontWeight: '800', fontSize: 16, letterSpacing: 1},
  rowBody: {flex: 1, gap: 3},
  name: {...typo.heading},
  empId: {color: colors.textDim, fontSize: 12},
  metaRow: {flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2},
  enrolled: {color: colors.textFaint, fontSize: 11, fontFamily: MONO},
  delBtn: {padding: space.sm},
  delGlyph: {color: colors.textFaint, fontSize: 16},
  empty: {alignItems: 'center', paddingTop: 80},
  emptyGlyph: {fontSize: 56, color: colors.line, marginBottom: space.md},
  emptyTitle: {...typo.heading, color: colors.textDim},
  emptySub: {marginTop: space.sm, textAlign: 'center'},
  footer: {paddingTop: space.md},
});

export default PeopleScreen;
