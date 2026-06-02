/**
 * Design tokens — "industrial biometric terminal" (SPEC §6.4 UI).
 *
 * Near-black control-panel surfaces, a single sharp "live scanner" green accent,
 * amber/red signal colours, and a monospace family for instrument readouts
 * (IDs, scores, timestamps). All values are plain JS so any component can import
 * without pulling native modules.
 *
 * @module ui/theme
 */

import { Platform } from 'react-native';

/** Monospace family for instrument readouts (no font bundling required). */
export const MONO = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
}) as string;

/** Colour palette. */
export const colors = {
  // Surfaces (darkest → lightest panel).
  bg: '#080C1A', // app background, deep navy
  surface: '#0D1226', // cards / panels
  surfaceAlt: '#111930', // raised / inputs
  line: '#1E2847', // hairline borders
  lineBright: '#283461',

  // Accent — sky blue highlight.
  accent: '#38BDF8',
  accentDim: '#0C2340',
  accentGlow: 'rgba(56,189,248,0.18)',

  // Signal colours.
  warn: '#FFB300',
  danger: '#FF5252',
  dangerDim: '#3A1614',
  info: '#4FC3F7',

  // Text.
  text: '#EAF3EF',
  textDim: '#8DA39B',
  textFaint: '#5C726A',
  onAccent: '#030A12',
} as const;

/** Spacing scale (4pt base). */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/** Corner radii. */
export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
} as const;

/** Typography presets. */
export const type = {
  /** Uppercase instrument label. */
  label: {
    fontSize: 11,
    fontWeight: '700' as const,
    letterSpacing: 1.5,
    color: colors.textDim,
  },
  /** Large screen title. */
  title: {
    fontSize: 26,
    fontWeight: '800' as const,
    letterSpacing: 0.3,
    color: colors.text,
  },
  /** Section heading. */
  heading: {
    fontSize: 17,
    fontWeight: '700' as const,
    color: colors.text,
  },
  /** Body copy. */
  body: {
    fontSize: 15,
    fontWeight: '500' as const,
    color: colors.text,
  },
  /** Muted body / helper. */
  muted: {
    fontSize: 13,
    fontWeight: '500' as const,
    color: colors.textDim,
  },
  /** Monospace readout (IDs, scores). */
  mono: {
    fontFamily: MONO,
    fontSize: 13,
    color: colors.text,
  },
} as const;

/** Elevation shadow (Android elevation + iOS shadow). */
export const elevation = {
  card: {
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
} as const;
