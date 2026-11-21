/** Batch ready reservations, shrinking to one copy under temporary pressure. */
import { JournalCapacityError } from "./journal-objects.js";
export function journalReservationBatch(reserve: (entries: { bytes: number; hash: string }[]) => Promise<(string | null)[]>) {
  type Request = { input: { bytes: number; hash: string }; resolve(id: string | null): void; reject(error: unknown): void };
  const waiting: Request[] = [], copying = new Set<string>();
  let running = false, settledCount = 0;
  async function flush(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (waiting.length) {
        let batch = waiting.splice(0);
        let ids: (string | null)[];
        try { ids = await reserve(batch.map(item => item.input)); }
        catch (error) {
          if (!(error instanceof JournalCapacityError)) { for (const item of batch) item.reject(error); continue; }
          if (batch.length > 1) { waiting.unshift(...batch.slice(1)); batch = batch.slice(0, 1); }
          const before = settledCount;
          try { ids = await reserve(batch.map(item => item.input)); }
          catch (single) {
            if (single instanceof JournalCapacityError && (copying.size || settledCount !== before)) {
              waiting.unshift(...batch);
              if (!copying.size) setImmediate(() => { void flush(); });
              break;
            }
            for (const item of batch) item.reject(single);
            continue;
          }
        }
        batch.forEach((item, index) => { const id = ids[index]!; if (id !== null) copying.add(id); item.resolve(id); });
      }
    } finally { running = false; }
  }
  return {
    reserve(input: { bytes: number; hash: string }): Promise<string | null> {
      return new Promise((resolve, reject) => { waiting.push({ input, resolve, reject }); setImmediate(() => { void flush(); }); });
    },
    settled(ids: readonly string[]) { settledCount++; for (const id of ids) copying.delete(id); setImmediate(() => { void flush(); }); },
  };
}
