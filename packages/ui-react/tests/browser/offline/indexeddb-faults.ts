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
 *   write and every one after it fail, a smaller one too. A write that fails or
 *   throws, and a transaction that aborts for any reason, give their bytes back.
 *
 * Bytes are an estimate of the stored value: Blob and buffer sizes, string
 * lengths at two bytes a character, eight per number. Cursor `update` is not
 * covered. Call `restore()` when the test ends.
 */

export type QuotaFault = ({ next: true } | { afterBytes: number }) & { errorName?: "QuotaExceededError" | "DataError" };

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
  const txProto = IDBTransaction.prototype;
  const original = { put: proto.put, add: proto.add, abort: txProto.abort };
  let failures = 0;
  let committed = 0;
  let armed = true;
  let full = false;
  /**
   * Each accepted write's bytes, per transaction still open. A write whose
   * request fails is released at once, so is a whole transaction the moment
   * it fails (`error` set) or anyone calls `abort()`: those bytes never
   * commit, and a caller's own handler (registered before this file's) may
   * already be writing again.
   */
  const open = new Map<IDBTransaction, Array<{ size: number; released: boolean }>>();
  const reserved = () => {
    let sum = 0;
    for (const [tx, writes] of open) if (!tx.error) for (const w of writes) if (!w.released) sum += w.size;
    return sum;
  };

  function reserve(tx: IDBTransaction, req: IDBRequest, size: number) {
    let writes = open.get(tx);
    if (!writes) {
      const list: Array<{ size: number; released: boolean }> = [];
      writes = list;
      open.set(tx, list);
      tx.addEventListener("complete", () => {
        for (const w of list) if (!w.released) committed += w.size;
        open.delete(tx);
      });
      tx.addEventListener("abort", () => open.delete(tx));
    }
    const write = { size, released: false };
    writes.push(write);
    // A failed request stores nothing, even if its handler lets the transaction complete.
    req.addEventListener("error", () => { write.released = true; });
  }

  function write(kind: "put" | "add") {
    return function faulted(this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const size = estimate(value);
      const fail = "next" in fault ? armed : full || committed + reserved() + size > fault.afterBytes;
      // The native call validates first: a write it refuses (a missing key, an
      // inactive transaction) throws here and leaves the fault untouched.
      const req = original[kind].call(this, value, key);
      const tx = this.transaction;
      if (!fail) {
        reserve(tx, req, size);
        return req;
      }
      // Past the threshold the origin stays full, even for a smaller write.
      if ("next" in fault) armed = false;
      else full = true;
      failures++;
      const error = new DOMException(fault.errorName === "DataError" ? "Failed to write blobs (IOError)" : "The quota has been exceeded.", fault.errorName ?? "QuotaExceededError");
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
  txProto.abort = function abortReleasing(this: IDBTransaction) {
    original.abort.call(this);
    open.delete(this);
  };

  return {
    get failures() { return failures; },
    get bytesWritten() { return committed; },
    restore() {
      proto.put = original.put;
      proto.add = original.add;
      txProto.abort = original.abort;
    },
  };
}

/** Keep the next matching write transaction alive, after request success but before commit. */
export function holdIndexedDbWrite(matches: (key: IDBValidKey | undefined, value: unknown) => boolean): { started: Promise<void>; release(): void; restore(): void } {
  const proto = IDBObjectStore.prototype;
  const put = proto.put;
  let held = false;
  let released = false;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  proto.put = function(value: unknown, key?: IDBValidKey) {
    const req = put.call(this, value, key);
    if (!held && matches(key, value)) {
      held = true;
      const read = () => this.get(key!);
      req.addEventListener("success", () => {
        started();
        const pump = () => {
          if (released) return;
          const pending = read();
          pending.addEventListener("success", pump);
        };
        pump();
      });
    }
    return req;
  };
  return { started: waiting, release() { released = true; }, restore() { released = true; proto.put = put; } };
}
