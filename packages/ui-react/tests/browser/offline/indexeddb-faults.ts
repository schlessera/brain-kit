/**
 * IndexedDB quota failure, browser side (#1016).
 *
 * `failIndexedDbWrites` makes `put` and `add` fail the way a full origin
 * does: the write itself is accepted, and its transaction then aborts with a
 * `QuotaExceededError` (`transaction.error`) instead of committing. Whatever
 * committed before stays. The abort happens right after the failing write's
 * own `success` event, so a transaction that queues several writes at once
 * queues all of them, as it would against a real full disk; writes still
 * pending then end with `AbortError`.
 *
 * - `{ next: true }`: the next write fails, later ones succeed again.
 * - `{ afterBytes: n }`: writes succeed until the bytes committed since
 *   installing, plus those in transactions still open, would pass `n`; that
 *   write and every one after it fail, a smaller one too. A transaction that
 *   aborts for any reason gives its bytes back.
 *
 * Bytes are an estimate of the stored value: Blob and buffer sizes, string
 * lengths at two bytes a character, eight per number. Cursor `update` is not
 * covered. Call `restore()` when the test ends.
 */

export type QuotaFault = { next: true } | { afterBytes: number };

export interface QuotaFaultHandle {
  /** Writes failed so far. */
  readonly failures: number;
  /** Bytes in committed transactions, by the estimate above. */
  readonly bytesWritten: number;
  restore(): void;
}

function estimate(value: unknown, seen = new Set<object>()): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (typeof value === "boolean") return 1;
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof Map) {
    let size = 0;
    for (const [k, v] of value) size += estimate(k, seen) + estimate(v, seen);
    return size;
  }
  let size = 0;
  if (value instanceof Set || Array.isArray(value)) {
    for (const item of value) size += estimate(item, seen);
    return size;
  }
  for (const [key, item] of Object.entries(value)) size += key.length * 2 + estimate(item, seen);
  return size;
}

export function failIndexedDbWrites(fault: QuotaFault): QuotaFaultHandle {
  const proto = IDBObjectStore.prototype;
  const original = { put: proto.put, add: proto.add };
  let failures = 0;
  let committed = 0;
  let armed = true;
  let full = false;
  /** Bytes written by transactions that have not finished yet. */
  const pending = new Map<IDBTransaction, number>();
  // A transaction that failed has `error` set before any abort listener runs,
  // and the caller's own `onabort` (registered first) may already be writing
  // again by the time this file's listener hears the abort.
  const inFlight = () => [...pending].reduce((sum, [tx, n]) => sum + (tx.error ? 0 : n), 0);

  function track(tx: IDBTransaction, size: number) {
    if (!pending.has(tx)) {
      pending.set(tx, 0);
      tx.addEventListener("complete", () => { committed += pending.get(tx) ?? 0; pending.delete(tx); });
      tx.addEventListener("abort", () => pending.delete(tx));
    }
    pending.set(tx, pending.get(tx)! + size);
  }

  function write(kind: "put" | "add") {
    return function faulted(this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const size = estimate(value);
      // Past the threshold the origin stays full, even for a smaller write.
      const fail = "next" in fault ? armed : (full ||= committed + inFlight() + size > fault.afterBytes);
      const req = original[kind].call(this, value, key);
      const tx = this.transaction;
      if (!fail) {
        track(tx, size);
        return req;
      }
      if ("next" in fault) armed = false;
      failures++;
      const error = new DOMException("The quota has been exceeded.", "QuotaExceededError");
      // Registered before the caller can add its own handlers: the caller still
      // sees this write succeed, then the transaction abort.
      req.addEventListener("success", () => {
        Object.defineProperty(tx, "error", { configurable: true, get: () => error });
        tx.abort();
      });
      return req;
    };
  }
  proto.put = write("put");
  proto.add = write("add");

  return {
    get failures() { return failures; },
    get bytesWritten() { return committed; },
    restore() {
      proto.put = original.put;
      proto.add = original.add;
    },
  };
}
