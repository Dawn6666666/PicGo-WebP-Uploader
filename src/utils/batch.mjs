// Each worker claims one index at a time. Results keep the input order.
export async function mapConcurrent(items, concurrency, processItem) {
  const results = new Array(items.length);
  let next = 0;
  async function work() {
    while (next < items.length) {
      const index = next++;
      results[index] = await processItem(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, work));
  return results;
}
