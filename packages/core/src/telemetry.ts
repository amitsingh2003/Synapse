/**
 * Phase 20.6 — Opt-in telemetry module.
 *
 * Collects anonymous usage metrics ONLY when the user explicitly opts in
 * by setting the environment variable CODEGRAPH_TELEMETRY=1 or calling
 * `enableTelemetry()`.
 *
 * Privacy guarantees:
 * - No file paths, symbol names, or source code are ever transmitted
 * - Only aggregate counts (files indexed, query latency, errors) are collected
 * - All data is stored locally until explicitly flushed
 * - Telemetry can be disabled at any time
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TelemetryEvent {
  /** Event category */
  category: 'index' | 'query' | 'error' | 'startup';
  /** Event action */
  action: string;
  /** Numeric value (latency ms, count, etc.) */
  value?: number;
  /** Timestamp */
  ts: number;
}

export interface TelemetryConfig {
  /** Whether telemetry is enabled */
  enabled: boolean;
  /** Optional endpoint for remote reporting (default: local file only) */
  endpoint?: string;
  /** Max events to buffer before auto-flush */
  bufferSize?: number;
}

// ─── State ─────────────────────────────────────────────────────────────────

let _enabled = false;
let _config: TelemetryConfig = { enabled: false, bufferSize: 100 };
const _buffer: TelemetryEvent[] = [];
const _listeners: Array<(events: TelemetryEvent[]) => void> = [];

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Check if telemetry is currently enabled.
 */
export function isTelemetryEnabled(): boolean {
  return _enabled;
}

/**
 * Enable telemetry collection. Can also be enabled via CODEGRAPH_TELEMETRY=1.
 */
export function enableTelemetry(config?: Partial<TelemetryConfig>): void {
  _enabled = true;
  _config = { ..._config, ...config, enabled: true };
}

/**
 * Disable telemetry and clear the buffer.
 */
export function disableTelemetry(): void {
  _enabled = false;
  _config.enabled = false;
  _buffer.length = 0;
}

/**
 * Record a telemetry event (no-op if disabled).
 */
export function recordEvent(
  category: TelemetryEvent['category'],
  action: string,
  value?: number,
): void {
  if (!_enabled) return;
  _buffer.push({ category, action, value, ts: Date.now() });
  if (_buffer.length >= (_config.bufferSize ?? 100)) {
    flush();
  }
}

/**
 * Flush buffered events to listeners and clear buffer.
 * Returns the flushed events.
 */
export function flush(): TelemetryEvent[] {
  if (_buffer.length === 0) return [];
  const events = [..._buffer];
  _buffer.length = 0;
  for (const listener of _listeners) {
    try {
      listener(events);
    } catch {
      // Telemetry must never crash the host
    }
  }
  return events;
}

/**
 * Register a flush listener (e.g. to write events to a file or HTTP endpoint).
 */
export function onFlush(listener: (events: TelemetryEvent[]) => void): () => void {
  _listeners.push(listener);
  return () => {
    const idx = _listeners.indexOf(listener);
    if (idx >= 0) _listeners.splice(idx, 1);
  };
}

/**
 * Get current buffer contents without flushing (for diagnostics).
 */
export function getBufferedEvents(): readonly TelemetryEvent[] {
  return _buffer;
}

/**
 * Initialize telemetry from environment. Call once at startup.
 * Respects CODEGRAPH_TELEMETRY env var.
 */
export function initTelemetryFromEnv(): void {
  const envVal = process.env['CODEGRAPH_TELEMETRY'];
  if (envVal === '1' || envVal === 'true') {
    enableTelemetry({ endpoint: process.env['CODEGRAPH_TELEMETRY_ENDPOINT'] });
  }
}

/**
 * Reset all state (for testing).
 */
export function resetTelemetry(): void {
  _enabled = false;
  _config = { enabled: false, bufferSize: 100 };
  _buffer.length = 0;
  _listeners.length = 0;
}
