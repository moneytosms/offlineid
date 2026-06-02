/**
 * OfflineID — root application shell.
 *
 * State-based navigation across the five terminal sections (Scan / Enroll /
 * People / Sync / Settings, plus a pushed About view), pre-warms the native
 * ONNX engine + opens the local DB on launch, and renders the branded header.
 *
 * @format
 */

import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

import {FaceEngine, isFaceEngineAvailable} from './src/services/FaceEngine';
import {openDatabase} from './src/db/migrations';
import {AuthScreen} from './src/screens/AuthScreen';
import {EnrollScreen} from './src/screens/EnrollScreen';
import {SyncStatusScreen} from './src/screens/SyncStatusScreen';
import {PeopleScreen} from './src/screens/PeopleScreen';
import {SettingsScreen} from './src/screens/SettingsScreen';
import {AboutScreen} from './src/screens/AboutScreen';
import {SyncBadge} from './src/components/SyncBadge';
import {useNetworkSync} from './src/hooks/useNetworkSync';
import {logger} from './src/utils/logger';
import {colors, MONO, space} from './src/ui/theme';

type Tab = 'auth' | 'enroll' | 'people' | 'sync' | 'settings';
type View_ = Tab | 'about';

// Stable per-install device identifier (replace with Datalake 3.0 device id).
const DEVICE_ID = 'datalake-device-001';

const TABS: {key: Tab; label: string; glyph: string}[] = [
  {key: 'auth', label: 'Scan', glyph: '◎'},
  {key: 'enroll', label: 'Enrol', glyph: '＋'},
  {key: 'people', label: 'People', glyph: '☰'},
  {key: 'sync', label: 'Sync', glyph: '⟳'},
  {key: 'settings', label: 'System', glyph: '⚙'},
];

function App(): React.JSX.Element {
  const [engineReady, setEngineReady] = useState(false);
  const [dbReady, setDbReady] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [view, setView] = useState<View_>('auth');

  // Open the local database before anything reads it (stores + sync).
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
        if (!cancelled) setEngineReady(true);
      })
      .catch((e: unknown) => {
        logger.error('App', 'initModels failed', {error: String(e)});
        if (!cancelled) setEngineError(String(e));
      });
    return () => {
      cancelled = true;
      FaceEngine.releaseModels().catch(() => undefined);
    };
  }, []);

  const handleEnrolled = useCallback(() => setView('people'), []);

  if (engineError) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={[styles.flex, styles.center]}>
          <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
          <Text style={styles.bootGlyph}>⚠</Text>
          <Text style={styles.errorTitle}>SYSTEM FAULT</Text>
          <Text style={styles.errorBody}>{engineError}</Text>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (!engineReady || !dbReady) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={[styles.flex, styles.center]}>
          <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
          <Text style={styles.bootBrand}>OFFLINE·ID</Text>
          <ActivityIndicator size="large" color={colors.accent} style={styles.bootSpin} />
          <Text style={styles.bootStatus}>
            {dbReady ? 'LOADING NEURAL MODELS' : 'PREPARING SECURE STORE'}
          </Text>
          <Text style={styles.bootSub}>on-device · offline</Text>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  const activeTab: Tab = view === 'about' ? 'settings' : view;

  return (
    <SafeAreaProvider>
    <SafeAreaView style={styles.flex}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />

      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>OFFLINE·ID</Text>
          <Text style={styles.brandSub}>BIOMETRIC FIELD TERMINAL</Text>
        </View>
        <View style={styles.headerRight}>
          <SyncBadge />
          <Text style={styles.deviceId}>{DEVICE_ID}</Text>
        </View>
      </View>

      <View style={styles.flex}>
        {view === 'auth' && <AuthScreen deviceId={DEVICE_ID} />}
        {view === 'enroll' && <EnrollScreen onEnrolled={handleEnrolled} />}
        {view === 'people' && (
          <PeopleScreen onEnrolNew={() => setView('enroll')} />
        )}
        {view === 'sync' && <SyncStatusScreen />}
        {view === 'settings' && (
          <SettingsScreen
            deviceId={DEVICE_ID}
            onOpenAbout={() => setView('about')}
          />
        )}
        {view === 'about' && <AboutScreen onBack={() => setView('settings')} />}
      </View>

      <View style={styles.tabBar}>
        {TABS.map(t => {
          const active = activeTab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={styles.tab}
              onPress={() => setView(t.key)}
              accessibilityRole="button"
              accessibilityState={{selected: active}}
              accessibilityLabel={t.label}>
              <Text style={[styles.tabGlyph, active && styles.tabGlyphActive]}>
                {t.glyph}
              </Text>
              <Text style={[styles.tabText, active && styles.tabTextActive]}>
                {t.label}
              </Text>
              {active && <View style={styles.tabMarker} />}
            </TouchableOpacity>
          );
        })}
      </View>
    </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1, backgroundColor: colors.bg},
  center: {alignItems: 'center', justifyContent: 'center'},

  // Boot / error.
  bootBrand: {
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: 6,
    color: colors.text,
  },
  bootSpin: {marginTop: space.xxl},
  bootStatus: {
    marginTop: space.xl,
    color: colors.accent,
    fontFamily: MONO,
    fontSize: 12,
    letterSpacing: 1.5,
  },
  bootSub: {marginTop: space.sm, color: colors.textFaint, fontSize: 12, letterSpacing: 1},
  bootGlyph: {fontSize: 44, color: colors.danger},
  errorTitle: {
    color: colors.danger,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 2,
    marginTop: space.md,
  },
  errorBody: {
    color: colors.textDim,
    marginTop: space.md,
    paddingHorizontal: space.xxl,
    textAlign: 'center',
    fontFamily: MONO,
    fontSize: 12,
  },

  // Header.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  brand: {color: colors.text, fontSize: 18, fontWeight: '900', letterSpacing: 3},
  brandSub: {
    color: colors.accent,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 2,
    marginTop: 2,
  },
  headerRight: {alignItems: 'flex-end'},
  deviceId: {
    color: colors.textFaint,
    fontFamily: MONO,
    fontSize: 10,
    marginTop: 4,
  },

  // Tab bar.
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    paddingBottom: space.xs,
  },
  tab: {flex: 1, paddingVertical: space.md, alignItems: 'center'},
  tabGlyph: {fontSize: 20, color: colors.textFaint, marginBottom: 3},
  tabGlyphActive: {color: colors.accent},
  tabText: {
    color: colors.textFaint,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
  },
  tabTextActive: {color: colors.text},
  tabMarker: {
    position: 'absolute',
    top: 0,
    height: 2,
    width: 28,
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
});

export default App;
