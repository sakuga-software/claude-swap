/** A bounded worker pool for async tasks, like `ThreadPoolExecutor.map`. */

import os from "node:os";

/** The default `max_workers` of Python `ThreadPoolExecutor`: `min(32, cpu_count + 4)`. */
export function defaultMaxWorkers(): number {
  return Math.min(32, os.availableParallelism() + 4);
}

/**
 * Run `fn` on each item with at most `limit` tasks in flight. Return the
 * results in the order of `items`. The first rejection rejects the result.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = defaultMaxWorkers(),
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
  return results;
}
