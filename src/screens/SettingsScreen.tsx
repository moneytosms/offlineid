/**
 * System / settings screen — multi-subview layout.
 *
 * Subviews: main → navigate to display, technical, help.
 * Display prefs are persisted immediately via PrefsStore on every change.
 *
 * @module screens/SettingsScreen
 */

import React, {useCallback, useEffect, useState} from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {
  Button,
  Card,
  Label,
  Mono,
  NavRow,
  Screen,
  StatRow,
  StepperRow,
  Tag,
  ToggleRow,
} from '../ui/components';
import {colors, MONO, radius, space, type as typo} from '../ui/theme';
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
import {
  PrefsStore,
  PREF_FILL_LIGHT_LUX,
  PREF_FILL_BRIGHTNESS,
  PREF_HAPTIC,
  PREF_KEEP_AWAKE,
  PREF_AUTO_RESTART_SECS,
  PREF_SHOW_MATCH_SCORE,
  PREF_ENROLL_VIBRATE,
  PREF_CAMERA_ZOOM,
} from '../services/PrefsStore';
import {LUX_DIM_THRESHOLD} from '../services/ScreenBrightness';
import {logger} from '../utils/logger';

const TAG = 'Settings';

type Subview = 'main' | 'display' | 'technical' | 'help';

const AUTO_RESTART_VALUES = [-1, 3, 5, 10] as const;

/** {@link SettingsScreen} props. */
export interface SettingsScreenProps {
  deviceId: string;
  onOpenAbout: () => void;
}

/** System screen with subview navigation. */
export function SettingsScreen({
  deviceId,
  onOpenAbout,
}: SettingsScreenProps): React.JSX.Element {
  const [subview, setSubview] = useState<Subview>('main');
  const [counts, setCounts] = useState({people: 0, pending: 0});

  // Display prefs
  const [fillLux, setFillLux] = useState(LUX_DIM_THRESHOLD);
  const [fillBrightness, setFillBrightness] = useState(100);
  const [haptic, setHaptic] = useState(true);
  const [keepAwake, setKeepAwake] = useState(true);
  const [autoRestartSecs, setAutoRestartSecs] = useState(5);
  const [showMatchScore, setShowMatchScore] = useState(true);
  const [enrollVibrate, setEnrollVibrate] = useState(true);
  const [cameraZoom, setCameraZoom] = useState(10);

  // ── Load ──────────────────────────────────────────────────────────────────

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

  const loadPrefs = useCallback(async (): Promise<void> => {
    const [lux, bright, hap, awake, restart, score, evib, zoom] =
      await Promise.all([
        PrefsStore.getNumber(PREF_FILL_LIGHT_LUX, LUX_DIM_THRESHOLD),
        PrefsStore.getNumber(PREF_FILL_BRIGHTNESS, 1.0),
        PrefsStore.getBool(PREF_HAPTIC, true),
        PrefsStore.getBool(PREF_KEEP_AWAKE, true),
        PrefsStore.getNumber(PREF_AUTO_RESTART_SECS, 5),
        PrefsStore.getBool(PREF_SHOW_MATCH_SCORE, true),
        PrefsStore.getBool(PREF_ENROLL_VIBRATE, true),
        PrefsStore.getNumber(PREF_CAMERA_ZOOM, 1.0),
      ]);
    setFillLux(lux);
    setFillBrightness(Math.round(bright * 100));
    setHaptic(hap);
    setKeepAwake(awake);
    setAutoRestartSecs(restart);
    setShowMatchScore(score);
    setEnrollVibrate(evib);
    setCameraZoom(Math.round(zoom * 10));
  }, []);

  useEffect(() => {
    void load();
    void loadPrefs();
  }, [load, loadPrefs]);

  // ── Factory reset ─────────────────────────────────────────────────────────

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

  // ── Stepper helpers ───────────────────────────────────────────────────────

  const changeFillLux = useCallback(
    (delta: number): void => {
      const next = Math.min(80, Math.max(5, fillLux + delta));
      setFillLux(next);
      void PrefsStore.setNumber(PREF_FILL_LIGHT_LUX, next);
    },
    [fillLux],
  );

  const changeFillBrightness = useCallback(
    (delta: number): void => {
      const next = Math.min(100, Math.max(50, fillBrightness + delta));
      setFillBrightness(next);
      void PrefsStore.setNumber(PREF_FILL_BRIGHTNESS, next / 100);
    },
    [fillBrightness],
  );

  const changeAutoRestart = useCallback(
    (delta: number): void => {
      const idx = AUTO_RESTART_VALUES.indexOf(
        autoRestartSecs as (typeof AUTO_RESTART_VALUES)[number],
      );
      const safeIdx = idx === -1 ? 2 : idx;
      const nextIdx = Math.min(
        AUTO_RESTART_VALUES.length - 1,
        Math.max(0, safeIdx + delta),
      );
      const next = AUTO_RESTART_VALUES[nextIdx];
      setAutoRestartSecs(next);
      void PrefsStore.setNumber(PREF_AUTO_RESTART_SECS, next);
    },
    [autoRestartSecs],
  );

  const changeCameraZoom = useCallback(
    (delta: number): void => {
      const next = Math.min(20, Math.max(5, cameraZoom + delta));
      setCameraZoom(next);
      void PrefsStore.setNumber(PREF_CAMERA_ZOOM, next / 10);
    },
    [cameraZoom],
  );

  // ── Display helpers ───────────────────────────────────────────────────────

  const fillLuxDisplay = `${fillLux} lux`;
  const fillBrightnessDisplay = `${fillBrightness}%`;
  const autoRestartDisplay = autoRestartSecs === -1 ? 'Never' : `${autoRestartSecs} s`;
  const cameraZoomDisplay = `${(cameraZoom / 10).toFixed(1)}×`;

  // ── Subview: main ─────────────────────────────────────────────────────────

  if (subview === 'main') {
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

        <Label style={styles.section}>Configure</Label>
        <Card style={[styles.card, styles.navCard]}>
          <NavRow
            title="Display & fill-light"
            subtitle="Brightness, fill-light, camera"
            onPress={() => setSubview('display')}
          />
          <NavRow
            title="Help / How to use"
            subtitle="Gestures, tips, and what to expect"
            onPress={() => setSubview('help')}
          />
          <NavRow
            title="Technical"
            subtitle="AI engine, sync endpoint, thresholds"
            onPress={() => setSubview('technical')}
          />
        </Card>

        <View style={styles.actions}>
          <Button label="About OfflineID" variant="secondary" onPress={onOpenAbout} />
          <Button label="Factory reset" variant="danger" onPress={factoryReset} />
        </View>
      </Screen>
    );
  }

  // ── Subview: display ──────────────────────────────────────────────────────

  if (subview === 'display') {
    return (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}>
        <TouchableOpacity
          onPress={() => setSubview('main')}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back to System">
          <Text style={styles.backText}>{'‹  System'}</Text>
        </TouchableOpacity>

        <Label style={styles.firstLabel}>Fill-light</Label>
        <Card style={styles.card}>
          <StepperRow
            title="Sensitivity"
            subtitle="Activate below this ambient level"
            value={fillLux}
            displayValue={fillLuxDisplay}
            onDecrement={() => changeFillLux(-5)}
            onIncrement={() => changeFillLux(5)}
          />
          <StepperRow
            title="Brightness"
            subtitle="Screen brightness when fill-light is on"
            value={fillBrightness}
            displayValue={fillBrightnessDisplay}
            onDecrement={() => changeFillBrightness(-10)}
            onIncrement={() => changeFillBrightness(10)}
          />
        </Card>

        <Label style={styles.section}>Camera</Label>
        <Card style={styles.card}>
          <StepperRow
            title="Zoom"
            subtitle="Camera zoom level"
            value={cameraZoom}
            displayValue={cameraZoomDisplay}
            onDecrement={() => changeCameraZoom(-5)}
            onIncrement={() => changeCameraZoom(5)}
          />
        </Card>

        <Label style={styles.section}>Feedback</Label>
        <Card style={styles.card}>
          <ToggleRow
            title="Haptic on auth result"
            subtitle="Vibrate on access granted or denied"
            value={haptic}
            onValueChange={v => {
              setHaptic(v);
              void PrefsStore.setBool(PREF_HAPTIC, v);
            }}
          />
          <ToggleRow
            title="Vibrate on enrol capture"
            subtitle="Haptic feedback on each frame lock-in"
            value={enrollVibrate}
            onValueChange={v => {
              setEnrollVibrate(v);
              void PrefsStore.setBool(PREF_ENROLL_VIBRATE, v);
            }}
          />
        </Card>

        <Label style={styles.section}>Behaviour</Label>
        <Card style={styles.card}>
          <ToggleRow
            title="Keep screen awake"
            subtitle="Prevent display sleep during scan"
            value={keepAwake}
            onValueChange={v => {
              setKeepAwake(v);
              void PrefsStore.setBool(PREF_KEEP_AWAKE, v);
            }}
          />
          <StepperRow
            title="Auto-restart scan"
            subtitle="Restart automatically after result"
            value={autoRestartSecs}
            displayValue={autoRestartDisplay}
            onDecrement={() => changeAutoRestart(-1)}
            onIncrement={() => changeAutoRestart(1)}
          />
          <ToggleRow
            title="Show match score"
            subtitle="Display % confidence on access granted"
            value={showMatchScore}
            onValueChange={v => {
              setShowMatchScore(v);
              void PrefsStore.setBool(PREF_SHOW_MATCH_SCORE, v);
            }}
          />
        </Card>
      </ScrollView>
    );
  }

  // ── Subview: technical ────────────────────────────────────────────────────

  if (subview === 'technical') {
    return (
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}>
        <TouchableOpacity
          onPress={() => setSubview('main')}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back to System">
          <Text style={styles.backText}>{'‹  System'}</Text>
        </TouchableOpacity>

        <Label style={styles.firstLabel}>Sync endpoint</Label>
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
          <StatRow
            label="Uncertain band"
            value={`≥ ${UNCERTAIN_THRESHOLD.toFixed(2)}`}
          />
          <StatRow
            label="Passive liveness"
            value={`> ${PASSIVE_LIVENESS_THRESHOLD.toFixed(2)}`}
          />
          <StatRow
            label="Gesture challenge"
            value={`${GESTURE_SEQUENCE_LENGTH} in sequence`}
          />
          <StatRow
            label="Lockout after"
            value={`${MAX_CONSECUTIVE_FAILS} fails`}
            tone="warn"
          />
        </Card>

        <Label style={styles.section}>Security</Label>
        <Card style={styles.card}>
          <Text style={styles.note}>
            Faceprints are encrypted at rest with AES-256-GCM; the key lives in
            the platform keystore. Raw face images are never stored. All inference
            runs on-device — nothing leaves the phone until you sync.
          </Text>
        </Card>
      </ScrollView>
    );
  }

  // ── Subview: help ─────────────────────────────────────────────────────────

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}>
      <TouchableOpacity
        onPress={() => setSubview('main')}
        style={styles.backBtn}
        accessibilityRole="button"
        accessibilityLabel="Back to System">
        <Text style={styles.backText}>{'‹  System'}</Text>
      </TouchableOpacity>

      {/* How authentication works */}
      <Label style={styles.firstLabel}>How authentication works</Label>
      <Card style={styles.card}>
        {AUTH_STEPS.map((step, i) => (
          <View key={i} style={styles.stepRow}>
            <View style={styles.stepCircle}>
              <Text style={styles.stepNum}>{i + 1}</Text>
            </View>
            <View style={styles.stepText}>
              <Text style={styles.stepTitle}>{step.title}</Text>
              <Text style={styles.stepDesc}>{step.desc}</Text>
            </View>
          </View>
        ))}
      </Card>

      {/* Gesture guide */}
      <Label style={styles.section}>Gesture guide</Label>
      <Card style={styles.card}>
        {GESTURE_GUIDE.map((g, i) => (
          <View key={i} style={styles.gestureRow}>
            <Text style={styles.gestureGlyph}>{g.glyph}</Text>
            <View style={styles.gestureText}>
              <Text style={styles.gestureName}>{g.name}</Text>
              <Text style={styles.gestureDesc}>{g.desc}</Text>
            </View>
          </View>
        ))}
      </Card>

      {/* Tips */}
      <Label style={styles.section}>Tips for best results</Label>
      <Card style={styles.card}>
        {TIPS.map((tip, i) => (
          <View key={i} style={styles.tipRow}>
            <Text style={styles.tipBullet}>{'•'}</Text>
            <Text style={styles.tipText}>{tip}</Text>
          </View>
        ))}
      </Card>

      {/* About your data */}
      <Label style={styles.section}>About your data</Label>
      <Card style={styles.card}>
        {DATA_NOTES.map((note, i) => (
          <View key={i} style={styles.tipRow}>
            <Text style={styles.tipBullet}>{'•'}</Text>
            <Text style={styles.tipText}>{note}</Text>
          </View>
        ))}
      </Card>
    </ScrollView>
  );
}

// ── Static content ─────────────────────────────────────────────────────────

const AUTH_STEPS = [
  {
    title: 'Face the camera',
    desc: 'Position your face inside the oval and hold still.',
  },
  {
    title: 'Liveness check',
    desc: 'System confirms a real person is present (takes about 1 second).',
  },
  {
    title: 'Gesture prompt',
    desc: 'Follow the on-screen instruction (blink, smile, or turn).',
  },
  {
    title: 'Result',
    desc: 'Access granted or retry if not recognised.',
  },
];

const GESTURE_GUIDE = [
  {
    glyph: '👁',
    name: 'Blink',
    desc: 'Open and close both eyes once, naturally. Defeats photos and printed images.',
  },
  {
    glyph: '😊',
    name: 'Smile',
    desc: 'Give a natural smile. Shows live facial muscle movement.',
  },
  {
    glyph: '←',
    name: 'Turn left',
    desc: 'Rotate your head slightly toward your left shoulder.',
  },
  {
    glyph: '→',
    name: 'Turn right',
    desc: 'Rotate your head slightly toward your right shoulder.',
  },
];

const TIPS = [
  'Good lighting helps — the app boosts screen brightness automatically in dark conditions',
  'Keep your face centred in the oval, roughly 30–50 cm from the camera',
  'Remove sunglasses or face coverings',
  'Locked out after 3 failed attempts? Wait 30 seconds',
];

const DATA_NOTES = [
  'Face data encrypted and stored only on this device',
  'Nothing is sent off-device until you manually sync in the Sync tab',
  'Raw photos are never stored — only a 512-number mathematical fingerprint',
];

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Shared
  scroll: {flex: 1, backgroundColor: colors.bg},
  scrollContent: {
    paddingHorizontal: space.xl,
    paddingBottom: space.xxxl,
    paddingTop: space.xl,
  },
  card: {marginTop: space.sm},
  navCard: {paddingBottom: 0},
  section: {marginTop: space.xl},
  firstLabel: {marginTop: space.sm},
  actions: {marginTop: space.xl, gap: space.md},

  // Back button
  backBtn: {marginBottom: space.xl},
  backText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '700',
  },

  // Technical subview
  endpointRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.md,
    gap: space.md,
  },
  endpoint: {flex: 1, fontSize: 12, color: colors.text},
  note: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textDim,
    lineHeight: 19,
    paddingVertical: space.sm,
  },

  // Help — auth steps
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    gap: space.md,
  },
  stepCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 1,
  },
  stepNum: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 13,
  },
  stepText: {flex: 1},
  stepTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 2,
  },
  stepDesc: {fontSize: 13, color: colors.textDim, lineHeight: 18},

  // Help — gesture guide
  gestureRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    gap: space.md,
  },
  gestureGlyph: {fontSize: 24, lineHeight: 28, flexShrink: 0},
  gestureText: {flex: 1},
  gestureName: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 2,
  },
  gestureDesc: {fontSize: 13, color: colors.textDim, lineHeight: 18},

  // Help — tips / data notes
  tipRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: space.sm,
    gap: space.sm,
  },
  tipBullet: {
    fontSize: 14,
    color: colors.accent,
    lineHeight: 20,
    flexShrink: 0,
  },
  tipText: {flex: 1, fontSize: 13, color: colors.textDim, lineHeight: 19},
});

export default SettingsScreen;
