/**
 * @module perf
 *
 * Lightweight performance instrumentation: timing helpers that log structured
 * `[perf]` lines for later aggregation, with no external tracing dependency.
 *
 * RESPONSIBILITIES:
 *   - measureAsync — times an async function and logs the duration.
 *   - logPerf — logs a single pre-measured duration as a structured metric.
 */
type PerfFields = Record<string, string | number | boolean | null | undefined>

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/**
 * Run `fn`, logging its elapsed wall-clock time under `name` via logPerf
 * regardless of whether it resolves or throws.
 *
 * @param fields Extra structured fields to attach to the logged metric.
 * @returns The resolved value of `fn`.
 */
export async function measureAsync<T>(
  name: string,
  fn: () => T | PromiseLike<T>,
  fields: PerfFields = {}
): Promise<T> {
  const started = now()
  try {
    return await fn()
  } finally {
    logPerf(name, now() - started, fields)
  }
}

/** Log a single named duration (plus optional extra fields) as a `[perf]` JSON line. */
export function logPerf(name: string, durationMs: number, fields: PerfFields = {}) {
  const payload = {
    metric: name,
    duration_ms: Math.round(durationMs),
    ...fields,
  }
  console.info('[perf]', JSON.stringify(payload))
}
