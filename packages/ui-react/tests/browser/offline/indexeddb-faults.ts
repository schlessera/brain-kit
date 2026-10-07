/**
 * IndexedDB quota failure, browser side (#1016).
 *
 * `failIndexedDbWrites` makes `put` and `add` fail the way a full origin
 * does: the write's transaction aborts and both the request and the
 * transaction report a `QuotaExceededError`. Whatever committed before stays.
 *
 * - `{ next: true }`: the next write fails, later ones succeed again.
 * - `{ afterBytes: n }`: writes succeed until the bytes written since
 *   installing would pass `n`; that write and every one after it fail, a
 *   smaller one too.
 *
 * Bytes are an estimate of the stored value: Blob and buffer sizes, string
 * lengths at two bytes a character, eight per number. Cursor `update` is not
 * covered. Call `restore()` when the test ends.
 */

export type QuotaFault = { next: true } | { afterBytes: number };

export interface QuotaFaultHandle {
  /** Writes failed so far. */
  readonly failures: number;
  /** Bytes the successful writes stored, by the estimate above. */
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
  let bytesWritten = 0;
  let armed = true;
  let full = false;

  function write(kind: "put" | "add") {
    return function faulted(this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      const size = estimate(value);
      // Past the threshold the origin stays full, even for a smaller write.
      const fail = "next" in fault ? armed : (full ||= bytesWritten + size > fault.afterBytes);
      const req = original[kind].call(this, value, key);
      if (!fail) {
        bytesWritten += size;
        return req;
      }
      if ("next" in fault) armed = false;
      failures++;
      const error = new DOMException("The quota has been exceeded.", "QuotaExceededError");
      Object.defineProperty(req, "error", { configurable: true, get: () => error });
      Object.defineProperty(this.transaction, "error", { configurable: true, get: () => error });
      this.transaction.abort();
      return req;
    };
  }
  proto.put = write("put");
  proto.add = write("add");

  return {
    get failures() { return failures; },
    get bytesWritten() { return bytesWritten; },
    restore() {
      proto.put = original.put;
      proto.add = original.add;
    },
  };
}
