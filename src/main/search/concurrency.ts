/**
 * Run async task factories with a bounded number in flight. A conception tree
 * can carry several thousand markdown files; a naive `Promise.all` over the lot
 * opens file descriptors as fast as the OS allows, occasionally tripping EMFILE
 * on dense trees. Shared by the per-query disk scan and the index build.
 */
export async function runWithConcurrency<T>(
  factories: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(factories.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= factories.length) return;
      results[i] = await factories[i]();
    }
  }
  const workers: Promise<void>[] = [];
  const n = Math.min(limit, factories.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
