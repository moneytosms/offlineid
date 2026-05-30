/**
 * OfflineID — root application shell.
 *
 * Lightweight state-based navigation between the three module screens
 * (Auth / Enroll / Sync), pre-warms the native ONNX engine on launch, and
 * surfaces the unsynced-record badge in the header.
 *
 * @format
 */

import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {FaceEngine, isFaceEngineAvailable} from './src/services/FaceEngine';
import {openDatabase} from './src/db/migrations';
import {AuthScreen} from './src/screens/AuthScreen';
import {EnrollScreen} from './src/screens/EnrollScreen';
import {SyncStatusScreen} from './src/screens/SyncStatusScreen';
import {SyncBadge} from './src/components/SyncBadge';
import {useNetworkSync} from './src/hooks/useNetworkSync';
import {logger} from './src/utils/logger';

type Tab = 'auth' | 'enroll' | 'sync';

// Stable per-install device identifier (replace with Datalake 3.0 device id).
const DEVICE_ID = 'datalake-device-001';

const TABS: {key: Tab; label: string}[] = [
  {key: 'auth', label: 'Authenticate'},
  {key: 'enroll', label: 'Enroll'},
  {key: 'sync', label: 'Sync'},
];

function App(): React.JSX.Element {
  const [engineReady, setEngineReady] = useState(false);
  const [dbReady, setDbReady] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('auth');

  // Open the local database before anything reads it (stores + sync). Gated by
  // `dbReady` so useNetworkSync only runs once the schema exists.
  useEffect(() => {
    let cancelled = false;
    openDatabase()
      .then(() => {
        if (!cancelled) setDbReady(true);
      })
      .catch((e: unknown) => {
        logger.error('App', 'openDatabase failed', {error: String(e)});
        if (!cancelled) setEngineError(`Database init failed: ${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-sync queued attendance records when connectivity returns (after DB).
  useNetworkSync(dbReady);

  useEffect(() => {
    let cancelled = false;
    if (!isFaceEngineAvailable()) {
      setEngineError('Native FaceEngine module not linked.');
      return;
    }
    FaceEngine.initModels()
      .then(() => {
        if (!cancelled) {
          setEngineReady(true);
        }
      })
      .catch((e: unknown) => {
        logger.error('App', 'initModels failed', {error: String(e)});
        if (!cancelled) {
          setEngineError(String(e));
        }
      });
    return () => {
      cancelled = true;
      FaceEngine.releaseModels().catch(() => undefined);
    };
  }, []);

  const handleEnrolled = useCallback(() => setTab('auth'), []);

  if (engineError) {
    return (
      <SafeAreaView style={[styles.flex, styles.center]}>
        <Text style={styles.errorTitle}>AI engine unavailable</Text>
        <Text style={styles.errorBody}>{engineError}</Text>
      </SafeAreaView>
    );
  }

  if (!engineReady || !dbReady) {
    return (
      <SafeAreaView style={[styles.flex, styles.center]}>
        <ActivityIndicator size="large" color="#00E676" />
        <Text style={styles.loading}>
          {dbReady
            ? 'Loading face-recognition models…'
            : 'Preparing local database…'}
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.flex}>
      <StatusBar barStyle="light-content" backgroundColor="#101418" />
      <View style={styles.header}>
        <Text style={styles.title}>OfflineID</Text>
        <SyncBadge />
      </View>

      <View style={styles.flex}>
        {tab === 'auth' && <AuthScreen deviceId={DEVICE_ID} />}
        {tab === 'enroll' && <EnrollScreen onEnrolled={handleEnrolled} />}
        {tab === 'sync' && <SyncStatusScreen />}
      </View>

      <View style={styles.tabBar}>
        {TABS.map(t => (
          <TouchableOpacity
            key={t.key}
            style={[styles.tab, tab === t.key && styles.tabActive]}
            onPress={() => setTab(t.key)}
            accessibilityRole="button"
            accessibilityState={{selected: tab === t.key}}>
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1, backgroundColor: '#101418'},
  center: {alignItems: 'center', justifyContent: 'center'},
  loading: {color: '#cfd8dc', marginTop: 16, fontSize: 15},
  errorTitle: {color: '#ff5252', fontSize: 20, fontWeight: '700'},
  errorBody: {color: '#cfd8dc', marginTop: 12, paddingHorizontal: 32, textAlign: 'center'},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#161c22',
  },
  title: {color: '#ffffff', fontSize: 20, fontWeight: '700'},
  tabBar: {flexDirection: 'row', backgroundColor: '#161c22'},
  tab: {flex: 1, paddingVertical: 14, alignItems: 'center'},
  tabActive: {borderTopWidth: 2, borderTopColor: '#00E676'},
  tabText: {color: '#90a4ae', fontSize: 14},
  tabTextActive: {color: '#00E676', fontWeight: '700'},
});

export default App;
