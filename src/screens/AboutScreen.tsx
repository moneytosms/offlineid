/**
 * About / documentation view.
 *
 * In-app explainer of what OfflineID is, how the offline pipeline works, its
 * feature set, and the open-source stack — so an evaluator can understand the
 * product without leaving the app.
 *
 * @module screens/AboutScreen
 */

import React from 'react';
import {ScrollView, StyleSheet, Text, TouchableOpacity, View} from 'react-native';

import {Card, Label, Tag} from '../ui/components';
import {colors, MONO, space, type as typo} from '../ui/theme';
import {APP_VERSION} from '../config';

/** A numbered pipeline step. */
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

/** Feature / capability row (always affirmative). */
function Feature({text}: {text: string}): React.JSX.Element {
  return (
    <View style={styles.spoofRow}>
      <Text style={[styles.spoofMark, {color: colors.accent}]}>✓</Text>
      <Text style={styles.spoofText}>{text}</Text>
    </View>
  );
}

/** {@link AboutScreen} props. */
export interface AboutScreenProps {
  /** Return to Settings. */
  onBack: () => void;
}

/** Read-only product explainer. */
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

      <Text style={styles.hero}>OFFLINE·ID</Text>
      <Text style={styles.tagline}>
        Secure offline facial recognition + liveness for field personnel in
        zero-network zones.
      </Text>
      <View style={styles.heroTags}>
        <Tag tone="accent">100% ON-DEVICE</Tag>
        <Tag tone="muted">{`v${APP_VERSION}`}</Tag>
      </View>

      <Label style={styles.section}>How it works</Label>
      <Card style={styles.card}>
        <Step
          n="1"
          title="Detect"
          body="SCRFD-500M finds the face and 5 keypoints in the camera still."
        />
        <Step
          n="2"
          title="Align & embed"
          body="The face is aligned (ArcFace) and MobileFaceNet turns it into a 512-number faceprint."
        />
        <Step
          n="3"
          title="Prove liveness"
          body="FASNet checks for a real face, then a random gesture sequence (blink / smile / turn) defeats photos."
        />
        <Step
          n="4"
          title="Match & log"
          body="Cosine similarity against enrolled faceprints; a match writes an attendance record."
        />
        <Step
          n="5"
          title="Sync & purge"
          body="When the network returns, records upload to AWS S3 and are erased locally."
        />
      </Card>

      <Label style={styles.section}>Features</Label>
      <Card style={styles.card}>
        <Feature text="Fully offline — recognition + liveness run on-device, zero network" />
        <Feature text="Dual-layer liveness: passive FASNet anti-spoof + active gestures" />
        <Feature text="Randomised gesture challenge (blink · smile · turn) defeats photos & screens" />
        <Feature text="Sub-second recognition on mid-range CPUs, no GPU required" />
        <Feature text="AES-256-GCM encrypted faceprints; raw images never stored" />
        <Feature text="Offline attendance queue with automatic AWS S3 sync & local purge" />
        <Feature text="Cross-platform React Native, ready for Datalake 3.0 integration" />
      </Card>

      <Label style={styles.section}>Built with (open-source)</Label>
      <Card style={styles.card}>
        <Text style={styles.stack}>
          React Native · ONNX Runtime · SCRFD · MobileFaceNet · Silent-Face
          FASNet · VisionCamera · ML Kit · SQLite · @noble/ciphers (AES-256-GCM)
        </Text>
        <Text style={styles.note}>
          Targets Android 8+ / iOS 12+, 3 GB RAM, no GPU. Models total ≈ 9 MB,
          inside the 20 MB budget — &gt; 95% recognition accuracy.
        </Text>
      </Card>

      <Text style={styles.footer}>OfflineID · Hackathon 7.0 prototype</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {flex: 1, backgroundColor: colors.bg},
  content: {padding: space.xl, paddingBottom: space.xxxl},
  back: {marginBottom: space.lg},
  backText: {color: colors.accent, fontSize: 15, fontWeight: '700'},
  hero: {fontSize: 30, fontWeight: '900', letterSpacing: 5, color: colors.text},
  tagline: {...typo.body, color: colors.textDim, marginTop: space.md, lineHeight: 22},
  heroTags: {flexDirection: 'row', gap: space.sm, marginTop: space.lg},
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
  spoofRow: {flexDirection: 'row', alignItems: 'flex-start', gap: space.md},
  spoofMark: {fontSize: 15, fontWeight: '800', width: 16},
  spoofText: {...typo.body, flex: 1, fontSize: 14, color: colors.textDim},
  note: {...typo.muted, fontSize: 12, lineHeight: 18, color: colors.textFaint},
  stack: {...typo.body, fontSize: 14, color: colors.textDim, lineHeight: 22},
  footer: {
    textAlign: 'center',
    color: colors.textFaint,
    fontFamily: MONO,
    fontSize: 11,
    marginTop: space.xxl,
  },
});

export default AboutScreen;
