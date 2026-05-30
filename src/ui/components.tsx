/**
 * Reusable UI primitives for the OfflineID "biometric terminal" theme.
 *
 * Pure React Native (no native deps) so screens stay reload-only. Everything
 * reads tokens from {@link ./theme}.
 *
 * @module ui/components
 */

import React from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { colors, elevation, radius, space, type } from './theme';

/** Uppercase instrument label. */
export function Label({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
}): React.JSX.Element {
  return <Text style={[type.label, style]}>{children}</Text>;
}

/** Monospace readout text. */
export function Mono({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
}): React.JSX.Element {
  return <Text style={[type.mono, style]}>{children}</Text>;
}

/** Panel/card surface with hairline border + soft elevation. */
export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  return <View style={[styles.card, style]}>{children}</View>;
}

/** Coloured status pill. */
export function Tag({
  children,
  tone = 'accent',
}: {
  children: React.ReactNode;
  tone?: 'accent' | 'warn' | 'danger' | 'muted' | 'info';
}): React.JSX.Element {
  const toneStyle = TAG_TONES[tone];
  return (
    <View style={[styles.tag, { borderColor: toneStyle.border, backgroundColor: toneStyle.bg }]}>
      <Text style={[styles.tagText, { color: toneStyle.fg }]}>{children}</Text>
    </View>
  );
}

const TAG_TONES = {
  accent: { fg: colors.accent, bg: colors.accentGlow, border: colors.accentDim },
  warn: { fg: colors.warn, bg: 'rgba(255,179,0,0.12)', border: 'rgba(255,179,0,0.3)' },
  danger: { fg: colors.danger, bg: colors.dangerDim, border: 'rgba(255,82,82,0.35)' },
  info: { fg: colors.info, bg: 'rgba(79,195,247,0.12)', border: 'rgba(79,195,247,0.3)' },
  muted: { fg: colors.textDim, bg: colors.surfaceAlt, border: colors.line },
} as const;

/** Primary / secondary / danger button with optional loading + disabled. */
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const v = BUTTON_VARIANTS[variant];
  const isOff = disabled || loading;
  return (
    <TouchableOpacity
      style={[
        styles.button,
        { backgroundColor: v.bg, borderColor: v.border },
        isOff && styles.buttonOff,
        style,
      ]}
      activeOpacity={0.85}
      onPress={onPress}
      disabled={isOff}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isOff, busy: loading }}
    >
      {loading ? (
        <ActivityIndicator color={v.fg} />
      ) : (
        <Text style={[styles.buttonText, { color: v.fg }]}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

const BUTTON_VARIANTS = {
  primary: { bg: colors.accent, fg: colors.onAccent, border: colors.accent },
  secondary: { bg: colors.surfaceAlt, fg: colors.text, border: colors.lineBright },
  danger: { bg: colors.dangerDim, fg: colors.danger, border: 'rgba(255,82,82,0.4)' },
  ghost: { bg: 'transparent', fg: colors.textDim, border: colors.line },
} as const;

/** Labelled text input row. */
export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  autoCapitalize = 'sentences',
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Label style={styles.fieldLabel}>{label}</Label>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        autoCapitalize={autoCapitalize}
        accessibilityLabel={label}
      />
    </View>
  );
}

/** Key/value readout row (label left, mono value right). */
export function StatRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'accent' | 'warn' | 'danger';
}): React.JSX.Element {
  const color =
    tone === 'accent'
      ? colors.accent
      : tone === 'warn'
      ? colors.warn
      : tone === 'danger'
      ? colors.danger
      : colors.text;
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
    </View>
  );
}

/** Hairline divider. */
export function Divider({ style }: { style?: StyleProp<ViewStyle> }): React.JSX.Element {
  return <View style={[styles.divider, style]} />;
}

/** Scrollable screen body with consistent padding + title block. */
export function Screen({
  title,
  subtitle,
  children,
  scroll = true,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  scroll?: boolean;
}): React.JSX.Element {
  const header = (
    <View style={styles.screenHead}>
      <Text style={type.title}>{title}</Text>
      {subtitle != null && <Text style={[type.muted, styles.screenSub]}>{subtitle}</Text>}
      <View style={styles.titleRule} />
    </View>
  );
  if (!scroll) {
    return (
      <View style={styles.screenBody}>
        {header}
        {children}
      </View>
    );
  }
  return (
    <ScrollView
      style={styles.screenScroll}
      contentContainerStyle={styles.screenContent}
      keyboardShouldPersistTaps="handled"
    >
      {header}
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: space.lg,
    ...elevation.card,
  },
  tag: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tagText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  button: {
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  buttonOff: { opacity: 0.4 },
  buttonText: { fontSize: 15, fontWeight: '700', letterSpacing: 0.5 },
  field: { marginBottom: space.lg },
  fieldLabel: { marginBottom: space.sm },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.lineBright,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  statLabel: { ...type.muted },
  statValue: { fontFamily: undefined, fontSize: 15, fontWeight: '700', color: colors.text },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  screenScroll: { flex: 1, backgroundColor: colors.bg },
  screenContent: { padding: space.xl, paddingBottom: space.xxxl },
  screenBody: { flex: 1, backgroundColor: colors.bg, padding: space.xl },
  screenHead: { marginBottom: space.xl },
  screenSub: { marginTop: space.xs },
  titleRule: {
    marginTop: space.md,
    height: 2,
    width: 40,
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
});

export default {
  Label,
  Mono,
  Card,
  Tag,
  Button,
  Field,
  StatRow,
  Divider,
  Screen,
};
