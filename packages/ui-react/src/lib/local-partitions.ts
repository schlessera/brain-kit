/**
 * Device-local partitions (#1014): one per account, plus one for work that
 * belongs to no account yet (`unassigned`).
 *
 * An account partition is named by the account key the host sends on its
 * authenticated probe (`/api/vpn-check`'s `accountKey`). This module opens,
 * reads, writes or clears `account:<key>` only while the client holds that
 * same key; any other caller is refused with {@link PartitionRefusedError},
 * whatever the UI shows. The check is made when an operation starts and
 * again before a read hands anything back.
 *
 * This is a boundary inside the app, not protection against someone with
 * access to the device: the records are plain IndexedDB data, not encrypted,
 * and the browser's own tools can read them.
 *
 * Writes resolve only after their IndexedDB transaction completes, so a
 * caller that must not lose work (a snapshot before an unmount, a draft
 * written before its audio is deleted) can wait for it.
 */

export type PartitionId = `account:${string}` | "unassigned";

export class PartitionRefusedError extends Error {
  constructor(readonly partition: PartitionId) {
    super("This partition belongs to an account the client does not hold");
    this.name = "PartitionRefusedError";
  }
}

export type PartitionWrite = { put: string; value: unknown } | { delete: string };

export interface PartitionHandle {
  readonly id: PartitionId;
  /** Resolves once the transaction has committed. */
  put(key: string, value: unknown): Promise<void>;
  /** Several changes in one transaction; resolves once it has committed. */
  write(changes: readonly PartitionWrite[]): Promise<void>;
  get(key: string): Promise<unknown>;
  /** Every record whose key starts with `prefix`. */
  list(prefix: string): Promise<Array<{ key: string; value: unknown }>>;
}

/** What a partition holds, without any of its content. */
export interface PartitionSize {
  partition: PartitionId;
  bytes: number;
  records: number;
}

export interface LocalPartitions {
  /** The partition of the account the client holds now. Throws {@link PartitionRefusedError} when it holds none. */
  openAccount(): PartitionHandle;
  /** A handle on a named partition; every operation on it is checked. */
  open(id: PartitionId): PartitionHandle;
  /** Remove everything one partition holds. */
  clear(id: PartitionId): Promise<void>;
  /** Each partition's aggregate size: no keys and no content. */
  sizes(): Promise<PartitionSize[]>;
}

const RECORDS = "records";
const SIZES = "sizes";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** An estimate of what a value occupies: UTF-8 for text, the byte length of binary data. */
export function measure(value: unknown, seen = new Set<object>()): number {
  if (typeof value === "string") {
    let n = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? (i++, 4) : 3;
    }
    return n;
  }
  if (typeof value === "number") return 8;
  if (typeof value === "boolean" || value === null || value === undefined) return 1;
  if (typeof value !== "object") return 0;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (seen.has(value)) return 0;
  seen.add(value);
  let n = 0;
  if (Array.isArray(value)) for (const item of value) n += measure(item, seen);
  else for (const [k, v] of Object.entries(value)) n += measure(k, seen) + measure(v, seen);
  return n;
}

export interface LocalPartitionOptions {
  /** The IndexedDB database: one per app origin, shared by every partition. */
  name: string;
  /** The account key the client holds now; null while it holds none. */
  heldAccountKey: () => string | null;
  factory?: IDBFactory;
  /** Asked once, on the first write, to keep the data; its answer is never presented as a guarantee. */
  persist?: () => void;
}

export function accountPartition(accountKey: string): PartitionId {
  return `account:${accountKey}`;
}

export function createLocalPartitions(options: LocalPartitionOptions): LocalPartitions {
  const factory = options.factory ?? (typeof indexedDB === "undefined" ? null : indexedDB);
  let opened: Promise<IDBDatabase> | null = null;
  let persistAsked = false;

  function db(): Promise<IDBDatabase> {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (!factory) { reject(new DOMException("IndexedDB is unavailable on this page", "NotSupportedError")); return; }
      const req = factory.open(options.name, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(RECORDS)) d.createObjectStore(RECORDS);
        if (!d.objectStoreNames.contains(SIZES)) d.createObjectStore(SIZES);
      };
      req.onsuccess = () => {
        const d = req.result;
        // Another tab upgrading: let it, and open again next time.
        d.onversionchange = () => { d.close(); opened = null; };
        resolve(d);
      };
      req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    }).catch((error) => {
      // A failed open is tried again on the next operation.
      opened = null;
      throw error;
    });
    return opened;
  }

  function allowed(id: PartitionId): boolean {
    if (id === "unassigned") return true;
    const held = options.heldAccountKey();
    return held !== null && id === accountPartition(held);
  }
  function check(id: PartitionId): void {
    if (!allowed(id)) throw new PartitionRefusedError(id);
  }

  /** Records are keyed `[partition, key]`, so a partition is one key range. */
  const range = (id: PartitionId, prefix = "") => IDBKeyRange.bound([id, prefix], [id, `${prefix}￿`]);

  async function transact(id: PartitionId, stores: string[], mode: IDBTransactionMode, op: (tx: IDBTransaction) => void): Promise<void> {
    const d = await db();
    // The key may have gone while the database was opening: checked again before anything is written.
    check(id);
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(stores, mode);
      // `complete`, not a request's success: only then has it committed.
      tx.oncomplete = () => resolve();
      // A request's error bubbles here first; an abort names itself on the request.
      tx.onerror = (event) => reject(tx.error ?? (event.target as IDBRequest | null)?.error ?? new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error ?? new DOMException("IndexedDB write aborted", "AbortError"));
      try {
        op(tx);
      } catch (error) {
        try { tx.abort(); } catch { /* already finished */ }
        reject(error);
      }
    });
  }

  function handle(id: PartitionId): PartitionHandle {
    async function write(changes: readonly PartitionWrite[]): Promise<void> {
      check(id);
      if (!persistAsked) { persistAsked = true; options.persist?.(); }
      await transact(id, [RECORDS, SIZES], "readwrite", (tx) => {
        const records = tx.objectStore(RECORDS);
        const sizes = tx.objectStore(SIZES);
        for (const change of changes) {
          if ("put" in change) {
            records.put(change.value, [id, change.put]);
            sizes.put(measure(change.value), [id, change.put]);
          } else {
            records.delete([id, change.delete]);
            sizes.delete([id, change.delete]);
          }
        }
      });
    }
    return {
      id,
      put: (key, value) => write([{ put: key, value }]),
      write,
      async get(key) {
        check(id);
        const d = await db();
        const value = await request(d.transaction(RECORDS, "readonly").objectStore(RECORDS).get([id, key]));
        // Signed out, or another account, while the read was out: nothing comes back.
        check(id);
        return value;
      },
      async list(prefix) {
        check(id);
        const d = await db();
        const tx = d.transaction(RECORDS, "readonly");
        const store = tx.objectStore(RECORDS);
        const [keys, values] = await Promise.all([request(store.getAllKeys(range(id, prefix))), request(store.getAll(range(id, prefix)))]);
        check(id);
        return keys.map((k, i) => ({ key: (k as [string, string])[1], value: values[i] }));
      },
    };
  }

  return {
    openAccount() {
      const held = options.heldAccountKey();
      if (held === null) throw new PartitionRefusedError("account:");
      return handle(accountPartition(held));
    },
    open: handle,
    async clear(id) {
      check(id);
      await transact(id, [RECORDS, SIZES], "readwrite", (tx) => {
        tx.objectStore(RECORDS).delete(range(id));
        tx.objectStore(SIZES).delete(range(id));
      });
    },
    async sizes() {
      const d = await db();
      const store = d.transaction(SIZES, "readonly").objectStore(SIZES);
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
      const totals = new Map<PartitionId, PartitionSize>();
      keys.forEach((k, i) => {
        const partition = (k as [PartitionId, string])[0];
        const entry = totals.get(partition) ?? { partition, bytes: 0, records: 0 };
        entry.bytes += typeof values[i] === "number" ? values[i] as number : 0;
        entry.records += 1;
        totals.set(partition, entry);
      });
      return [...totals.values()];
    },
  };
}
