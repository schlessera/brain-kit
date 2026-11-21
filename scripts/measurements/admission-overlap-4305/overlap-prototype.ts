/** Throwaway read-only preparation prototype, never a product admission path. */
export async function overlap<P, R>(admit: () => Promise<unknown>, prepare: () => P, effect: (prepared: P) => R): Promise<R> {
  const admitted = admit();
  const prepared = prepare();
  await admitted;
  return effect(prepared);
}
