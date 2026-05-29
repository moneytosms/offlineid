// src/utils/logger.ts

/** Severity levels in ascending order. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Active log level. Messages below this are dropped.
 * Defaults to 'debug' in dev (__DEV__) and 'info' otherwise.
 */
export const LOG_LEVEL: LogLevel =
  typeof __DEV__ !== 'undefined' && __DEV__ ? 'debug' : 'info';

const PREFIX = '[OfflineID]';

function emit(
  level: LogLevel,
  consoleFn: (...args: unknown[]) => void,
  tag: string,
  msg: string,
  meta?: unknown,
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[LOG_LEVEL]) return;
  const label = `${PREFIX}[${tag}]`;
  if (meta !== undefined) consoleFn(label, msg, meta);
  else consoleFn(label, msg);
}

/**
 * Structured logger. Every line is prefixed `[OfflineID][tag]` and gated by
 * {@link LOG_LEVEL}. Optional `meta` is logged as a trailing structured arg.
 */
export const logger = {
  /** Verbose diagnostic detail (suppressed in production). */
  debug: (tag: string, msg: string, meta?: unknown): void =>
    emit('debug', console.debug ?? console.log, tag, msg, meta),
  /** Normal operational events. */
  info: (tag: string, msg: string, meta?: unknown): void =>
    emit('info', console.info ?? console.log, tag, msg, meta),
  /** Recoverable / unexpected-but-handled conditions. */
  warn: (tag: string, msg: string, meta?: unknown): void =>
    emit('warn', console.warn ?? console.log, tag, msg, meta),
  /** Failures requiring attention. */
  error: (tag: string, msg: string, meta?: unknown): void =>
    emit('error', console.error ?? console.log, tag, msg, meta),
};

export default logger;
