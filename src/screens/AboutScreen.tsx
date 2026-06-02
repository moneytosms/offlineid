/**
 * About / documentation view.
 *
 * @module screens/AboutScreen
 */

import React from 'react';
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import {Card, Label, Tag} from '../ui/components';
import {colors, MONO, space, type as typo} from '../ui/theme';
import {APP_VERSION} from '../config';

const BrandLogo = require('../assets/brand_logo.png') as number;

function Step({
  n,
  title,
  body,
}: {
  n: string;
  title: string;
  body: string;
}): React.JSX.Element {
  return (
    <View style={styles.step}>
      <Text style={styles.stepNum}>{n}</Text>
      <View style={styles.stepBody}>
        <Text style={styles.stepTitle}>{title}</Text>
        <Text style={styles.stepText}>{body}</Text>
      </View>
    </View>
  );
}

function Feature({text}: {text: string}): React.JSX.Element {
  return (
    <View style={styles.featureRow}>
      <Text style={[styles.featureMark, {color: colors.accent}]}>✓</Text>
      <Text style={styles.featureText}>{text}</Text>
    </View>
  );
}

export interface AboutScreenProps {
  onBack: () => void;
}

export function AboutScreen({onBack}: AboutScreenProps): React.JSX.Element {
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}>
      <TouchableOpacity
        style={styles.back}
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back to system">
        <Text style={styles.backText}>‹  System</Text>
      </TouchableOpacity>

      {/* Brand logo */}
      <View style={styles.logoWrap}>
        <Image
          source={BrandLogo}
          style={styles.logo}
          resizeMode="contain"
          accessibilityLabel="OfflineID logo"
        />
      </View>

      <View style={styles.heroTags}>
        <Tag tone="accent">100% ON-DEVICE</Tag>
        <Tag tone="muted">{`v${APP_VERSION}`}</Tag>
      </View>

      <Text style={styles.tagline}>
        Secure offline facial recognition + liveness detection for field
        personnel in zero-network zones. No internet. No cloud. No compromise.
      </Text>

      <Label style={styles.section}>How it works</Label>
      <Card style={styles.card}>
        <Step
          n="1"
          title="Detect"
          body="SCRFD-500M locates the face and 5 keypoints from a camera still."
        />
        <Step
          n="2"
          title="Align & embed"
          body="ArcFace alignment normalises the crop; MobileFaceNet INT8 produces a 512-d faceprint in ~51 ms."
        />
        <Step
          n="3"
          title="Passive liveness"
          body="FASNet (scales 2.7× + 4.0×) rejects printed photos and screen replays before any recognition runs."
        />
        <Step
          n="4"
          title="Active gesture"
          body="A randomised blink / smile / turn sequence from ML Kit defeats video replays and deepfakes."
        />
        <Step
          n="5"
          title="Match & log"
          body="Cosine similarity against AES-256-GCM encrypted faceprints; a match writes a local attendance record."
        />
        <Step
          n="6"
          title="Sync & purge"
          body="When the network returns, records upload via presigned S3 URLs then are erased locally."
        />
      </Card>

      <Label style={styles.section}>Features</Label>
      <Card style={styles.card}>
        <Feature text="Fully offline — all inference on-device, zero network dependency" />
        <Feature text="Dual-layer liveness: passive FASNet anti-spoof + randomised active gesture" />
        <Feature text="Ambient light sensor (TYPE_LIGHT) triggers fill-light overlay in dim conditions" />
        <Feature text="White fill-light panels around face oval illuminate subject using the screen" />
        <Feature text="Brightness held until ambient lux recovers — not dropped on first face detection" />
        <Feature text="Sub-second recognition on mid-range CPUs, no GPU required" />
        <Feature text="AES-256-GCM encrypted faceprints at rest; raw images never stored" />
        <Feature text="Offline attendance queue with automatic AWS S3 sync and local purge" />
        <Feature text="30-second lockout after repeated failed authentication attempts" />
        <Feature text="Cross-platform React Native, ready for Datalake 3.0 integration" />
      </Card>

      <Label style={styles.section}>AI models (open-source ONNX)</Label>
      <Card style={styles.card}>
        <Text style={styles.stack}>
          SCRFD-500M (face detect + 5 landmarks) · MobileFaceNet INT8 (512-d
          embedding) · Silent-Face FASNet (passive liveness, 2 scales) · ML Kit
          Face Detector (active gesture stream)
        </Text>
        <Text style={styles.note}>
          9.1 MB total · CPU-only ONNX Runtime (XNNPACK / NNAPI) · Android 8+ /
          iOS 12+ · 3 GB RAM · no GPU required · &gt; 95% recognition accuracy
        </Text>
      </Card>

      <Label style={styles.section}>Open-source stack</Label>
      <Card style={styles.card}>
        <Text style={styles.stack}>
          React Native · ONNX Runtime Mobile · VisionCamera v4 ·
          react-native-vision-camera-face-detector · @noble/ciphers
          (AES-256-GCM) · SQLite · react-native-worklets-core
        </Text>
      </Card>

      <Label style={styles.section}>Open-source licenses</Label>
      <Card style={styles.card}>
        {OSS_LICENSES.map((entry, i) => (
          <View
            key={entry.name}
            style={[
              styles.licenseRow,
              i < OSS_LICENSES.length - 1 && styles.licenseRowBorder,
            ]}>
            <Text style={styles.licenseName}>{entry.name}</Text>
            <Text style={styles.licenseSpdx}>{entry.spdx}</Text>
          </View>
        ))}
      </Card>

      <Text style={styles.footer}>
        OfflineID · Hackathon 7.0 · MIT licence
      </Text>
    </ScrollView>
  );
}

const OSS_LICENSES: { name: string; spdx: string }[] = [
  { name: 'React Native', spdx: 'MIT' },
  { name: 'ONNX Runtime Mobile', spdx: 'MIT' },
  { name: 'react-native-vision-camera', spdx: 'MIT' },
  { name: 'react-native-vision-camera-face-detector', spdx: 'MIT' },
  { name: '@noble/ciphers (AES-256-GCM)', spdx: 'MIT' },
  { name: 'SQLite', spdx: 'Public Domain' },
  { name: 'react-native-sqlite-storage', spdx: 'MIT' },
  { name: 'uuid', spdx: 'MIT' },
  { name: '@react-native-community/netinfo', spdx: 'MIT' },
  { name: 'ML Kit Face Detection (Google)', spdx: 'Apache-2.0' },
  { name: 'react-native-worklets-core', spdx: 'MIT' },
  { name: 'react-native-encrypted-storage', spdx: 'MIT' },
  { name: 'axios', spdx: 'MIT' },
];

const styles = StyleSheet.create({
  scroll: {flex: 1, backgroundColor: colors.bg},
  content: {padding: space.xl, paddingBottom: space.xxxl},
  back: {marginBottom: space.lg},
  backText: {color: colors.accent, fontSize: 15, fontWeight: '700'},

  logoWrap: {alignItems: 'center', marginBottom: space.lg},
  logo: {width: 200, height: 200},

  tagline: {
    ...typo.body,
    color: colors.textDim,
    marginTop: space.md,
    lineHeight: 22,
  },
  heroTags: {flexDirection: 'row', gap: space.sm},
  section: {marginTop: space.xl, marginBottom: space.sm},
  card: {gap: space.md},

  step: {flexDirection: 'row', gap: space.md},
  stepNum: {
    color: colors.accent,
    fontFamily: MONO,
    fontSize: 16,
    fontWeight: '700',
    width: 20,
  },
  stepBody: {flex: 1},
  stepTitle: {...typo.heading, fontSize: 15},
  stepText: {...typo.muted, marginTop: 2, lineHeight: 19},

  featureRow: {flexDirection: 'row', alignItems: 'flex-start', gap: space.md},
  featureMark: {fontSize: 15, fontWeight: '800', width: 16},
  featureText: {
    ...typo.body,
    flex: 1,
    fontSize: 14,
    color: colors.textDim,
  },

  stack: {
    ...typo.body,
    fontSize: 14,
    color: colors.textDim,
    lineHeight: 22,
  },
  note: {
    ...typo.muted,
    fontSize: 12,
    lineHeight: 18,
    color: colors.textFaint,
    marginTop: space.xs,
  },
  licenseRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.sm,
  },
  licenseRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  licenseName: { ...typo.body, fontSize: 13, color: colors.text, flex: 1 },
  licenseSpdx: {
    fontFamily: MONO,
    fontSize: 11,
    color: colors.accent,
    marginLeft: space.md,
  },
  footer: {
    textAlign: 'center',
    color: colors.textFaint,
    fontFamily: MONO,
    fontSize: 11,
    marginTop: space.xxl,
  },
});

export default AboutScreen;
