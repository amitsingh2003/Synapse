/**
 * Minimal NDJSON logger for synapse.
 *
 * Phase 9: replaces ad-hoc `process.stderr.write` calls with structured output.
 * Each line is a JSON object: { ts, level, msg, ...fields }
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const entry = { ts: new Date().toISOString(), level, msg, ...fields };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
