/** `run` over `items`, at most `n` in flight, order preserved. */
export const mapPool = async <T, R>(
  items: ReadonlyArray<T>,
  n: number,
  run: (t: T) => Promise<R>,
): Promise<ReadonlyArray<R>> => {
  const out: R[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the cursor bounds it: current < items.length
        const item = items[current] as T;
        // oxlint-disable-next-line eslint/no-await-in-loop -- the shared cursor serializes each worker's steps.
        out[current] = await run(item);
      }
    }),
  );
  return out;
};
