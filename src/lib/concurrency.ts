/**
 * @module concurrency
 *
 * Small, dependency-free concurrency helpers shared across the generation
 * pipeline.
 *
 * RESPONSIBILITIES:
 *   - mapWithConcurrency — runs an async mapper over a list with a bounded
 *     number of in-flight calls.
 *   - chunkArray — splits an array into fixed-size sub-arrays.
 */

/**
 * Map `items` through `mapper`, running at most `concurrency` calls at once.
 * Results preserve the original order regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []

  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await mapper(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: limit }, worker))
  return results
}

/** Split `items` into consecutive sub-arrays of at most `size` elements each. */
export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}
