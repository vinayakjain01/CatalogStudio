type PerfFields = Record<string, string | number | boolean | null | undefined>

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

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

export function logPerf(name: string, durationMs: number, fields: PerfFields = {}) {
  const payload = {
    metric: name,
    duration_ms: Math.round(durationMs),
    ...fields,
  }
  console.info('[perf]', JSON.stringify(payload))
}
