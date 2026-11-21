/** Coalesce the currently ready file operations into one FULL ledger commit. */
export function journalWriteBatch<I, O>(commit: (inputs: I[]) => Promise<O[]>): (input: I) => Promise<O> {
  let waiting: { input: I; resolve(value: O): void; reject(error: unknown): void }[] = [];
  return input => new Promise<O>((resolve, reject) => {
    waiting.push({ input, resolve, reject });
    if (waiting.length !== 1) return;
    setImmediate(() => {
      const batch = waiting; waiting = [];
      void commit(batch.map(entry => entry.input)).then(values => {
        if (values.length !== batch.length) throw new Error("Journal batch result count differs from its request");
        batch.forEach((entry, i) => entry.resolve(values[i]!));
      }).catch(error => { for (const entry of batch) entry.reject(error); });
    });
  });
}
