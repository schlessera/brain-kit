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
  write(changes: readonly PartitionWrite[], signal?: AbortSignal): Promise<void>;
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
  /** @internal One native read transaction for the complete authorized loss inventory. */
  snapshot(ids: readonly PartitionId[]): Promise<Array<{ partition: PartitionId; key: string; value: unknown }>>;
  /** Remove everything one partition holds. */
  clear(id: PartitionId): Promise<void>;
  /** @internal Fence old writers across tabs and return a fixed, authorized clear. */
  prepareSignOut(id: PartitionId): () => Promise<void>;
  /** @internal The native closed fence is an atomic receipt for whole-partition clearing. */
  isSignOutCleared(id: PartitionId): Promise<boolean>;
  /** @internal Called only after explicit sign-in verified the held account. */
  allowWritesAfterSignIn(key: string): Promise<void>;
  /** @internal Other roots stop capture and omit auth-expiry snapshots on intentional sign-out. */
  subscribeSignOut(fn: (id: PartitionId, closed: WriterFence, affectsWriter: boolean) => void): () => void;
  /** @internal An explicit capture or recovery action admits a fresh unassigned writer. */
  allowUnassignedAction(): Promise<string>;
  /** @internal Bind an asynchronous operation to its original writer generation. */
  writerGeneration(id: PartitionId): string;
  /** Each partition's aggregate size: no keys and no content. */
  sizes(prefix?: string): Promise<PartitionSize[]>;
  /** Atomically move named records; both partitions must be accessible. */
  move(from: PartitionId, to: PartitionId, keys: readonly string[]): Promise<void>;
}

const SIGNOUT_PREFIX = "brain-ui:account-write-fence:";
const signOutWatchers = new Set<(name: string, id: PartitionId, closed: WriterFence) => void>();
export type WriterFence = { token: string; closed: boolean; predecessors?: string[] };
type FenceAuthority = { check(): void; fence: WriterFence };
const memoryFences = new Map<string, WriterFence>();
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
  const adopted = new Map<string, string>();
  const fenceKey = (key: PartitionId) => `${SIGNOUT_PREFIX}${encodeURIComponent(options.name)}:${encodeURIComponent(key)}`;
  function fence(key: PartitionId): WriterFence {
    const storageKey = fenceKey(key);
    try {
      const text = localStorage.getItem(storageKey);
      if (text) return JSON.parse(text) as WriterFence;
      return { token: "initial", closed: false };
    } catch { return memoryFences.get(storageKey) ?? { token: "initial", closed: false }; }
  }
  function setFence(key: PartitionId, closed: boolean) {
    const previous = fence(key);
    // Pending transitions may supersede a marker before its native write.
    // Only that marker's ancestors may be replaced; a later native generation
    // is never authorized by an older, paused administrative operation.
    const value = { token: crypto.randomUUID(), closed, predecessors: [...new Set([previous.token, ...(previous.predecessors ?? [])])] };
    // Sign-out must report an unavailable cross-tab fence instead of claiming
    // complete deletion while another page may still snapshot old work.
    localStorage.setItem(fenceKey(key), JSON.stringify(value));
    memoryFences.set(fenceKey(key), value);
    return value;
  }
  const storedFenceKey = (id: PartitionId) => ["sign-out-fences", id];
  function checkFence(id: PartitionId) {
    const key = id;
    const current = fence(key);
    const token = adopted.get(key) ?? current.token;
    adopted.set(key, token);
    if (current.closed || current.token !== token) throw new PartitionRefusedError(id);
  }

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
  function check(id: PartitionId, reading = false): void {
    if (!allowed(id)) throw new PartitionRefusedError(id);
    if (!(reading && id === "unassigned")) checkFence(id);
  }

  /** Records are keyed `[partition, key]`, so a partition is one key range. */
  const range = (id: PartitionId, prefix = "") => IDBKeyRange.bound([id, prefix], [id, `${prefix}￿`]);

  async function transact(id: PartitionId, stores: string[], mode: IDBTransactionMode, op: (tx: IDBTransaction, stored?: WriterFence) => void, signal?: AbortSignal, authority?: FenceAuthority): Promise<void> {
    if (authority) authority.check(); else check(id);
    const writerToken = adopted.get(id);
    const d = await db();
    // The key may have gone while the database was opening: checked again before anything is written.
    if (authority) authority.check(); else check(id);
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(stores, mode);
      let operationError: unknown = null;
      // `complete`, not a request's success: only then has it committed.
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const abort = () => { try { tx.abort(); } catch { /* already committed */ } };
      signal?.addEventListener("abort", abort, { once: true });
      tx.oncomplete = () => { cleanup(); resolve(); };
      // A request's error bubbles here first; an abort names itself on the request.
      tx.onerror = (event) => { cleanup(); reject(tx.error ?? (event.target as IDBRequest | null)?.error ?? new Error("IndexedDB write failed")); };
      tx.onabort = () => { cleanup(); reject(operationError ?? tx.error ?? new DOMException("IndexedDB write aborted", "AbortError")); };
      try {
        if (signal?.aborted) { abort(); return; }
        {
          // Native transactions serialize this check with the clear's fence.
          // A writer checked before another process closed the localStorage
          // marker can still enqueue later; it must not resurrect cleared work.
          const fenceRequest = tx.objectStore(RECORDS).get(storedFenceKey(id));
          fenceRequest.onsuccess = () => {
            try {
              const stored = fenceRequest.result as { token: string; closed: boolean } | undefined;
              if (authority) {
                authority.check();
                const token = stored?.token ?? "initial";
                if (token !== authority.fence.token && !authority.fence.predecessors?.includes(token)) throw new PartitionRefusedError(id);
              } else {
                check(id);
                if (stored?.closed || (stored?.token ?? "initial") !== writerToken || fence(id).token !== writerToken) throw new PartitionRefusedError(id);
              }
              op(tx, stored);
            } catch (error) { operationError = error; abort(); }
          };
        }
      } catch (error) {
        try { tx.abort(); } catch { /* already finished */ }
        cleanup(); reject(error);
      }
    });
  }

  function handle(id: PartitionId): PartitionHandle {
    const generation = fence(id).token;
    async function write(changes: readonly PartitionWrite[], signal?: AbortSignal): Promise<void> {
      check(id);
      if (fence(id).token !== generation) throw new PartitionRefusedError(id);
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
      }, signal);
    }
    return {
      id,
      put: (key, value) => write([{ put: key, value }]),
      write,
      async get(key) {
        check(id, true);
        const d = await db();
        const value = await request(d.transaction(RECORDS, "readonly").objectStore(RECORDS).get([id, key]));
        // Signed out, or another account, while the read was out: nothing comes back.
        check(id, true);
        return value;
      },
      async list(prefix) {
        check(id, true);
        const d = await db();
        const tx = d.transaction(RECORDS, "readonly");
        const store = tx.objectStore(RECORDS);
        const [keys, values] = await Promise.all([request(store.getAllKeys(range(id, prefix))), request(store.getAll(range(id, prefix)))]);
        check(id, true);
        return keys.map((k, i) => ({ key: (k as [string, string])[1], value: values[i] }));
      },
    };
  }

  async function clear(id: PartitionId) {
    check(id);
    await transact(id, [RECORDS, SIZES], "readwrite", tx => {
      tx.objectStore(RECORDS).delete(range(id));
      tx.objectStore(SIZES).delete(range(id));
    });
  }
  async function admitWriter(id: PartitionId) {
    if (!allowed(id)) throw new PartitionRefusedError(id);
    const previous = fence(id);
    const current = previous.closed ? setFence(id, false) : previous;
    adopted.set(id, current.token);
    await transact(id, [RECORDS], "readwrite", (tx, stored) => {
      // Existing admission still validates native authority, but needs no put.
      // In particular, explicit discard must remain possible on a full origin.
      if ((stored?.token ?? "initial") !== current.token || stored?.closed) tx.objectStore(RECORDS).put(current, storedFenceKey(id));
    }, undefined, { fence: current, check() {
      if (!allowed(id) || fence(id).token !== current.token) throw new PartitionRefusedError(id);
    } });
    return current.token;
  }
  return {
    prepareSignOut(id) {
      if (!allowed(id)) throw new PartitionRefusedError(id);
      const key = id;
      const previous = fence(key);
      // A failed logout can reload with the cookie still held and this
      // account already fenced. Repeating its authorized clear is idempotent.
      if (!previous.closed) checkFence(id);
      const current = previous.closed ? previous : setFence(key, true);
      for (const fn of [...signOutWatchers]) fn(options.name, id, current);
      const authority = { fence: current, check() { if (fence(key).token !== current.token) throw new PartitionRefusedError(id); } };
      return () => transact(id, [RECORDS, SIZES], "readwrite", tx => {
        tx.objectStore(RECORDS).put(current, storedFenceKey(id));
        tx.objectStore(RECORDS).delete(range(id));
        tx.objectStore(SIZES).delete(range(id));
      }, undefined, authority);
    },
    async isSignOutCleared(id) {
      if (!allowed(id)) throw new PartitionRefusedError(id);
      const d = await db();
      const value = await request(d.transaction(RECORDS, "readonly").objectStore(RECORDS).get(storedFenceKey(id))) as { closed?: boolean } | undefined;
      if (!allowed(id)) throw new PartitionRefusedError(id);
      return value?.closed === true;
    },
    async allowWritesAfterSignIn(key) {
      const id = accountPartition(key);
      if (options.heldAccountKey() !== key) throw new PartitionRefusedError(id);
      await admitWriter(id);
    },
    allowUnassignedAction: () => admitWriter("unassigned"),
    writerGeneration(id) { if (!allowed(id)) throw new PartitionRefusedError(id); return fence(id).token; },
    subscribeSignOut(fn) {
      const watch = (name: string, id: PartitionId, closed: WriterFence) => {
        const writer = adopted.get(id) ?? fence(id).token;
        if (name === options.name && (id === "unassigned" || id === `account:${options.heldAccountKey()}`)) fn(id, closed, writer === closed.token || !!closed.predecessors?.includes(writer));
      };
      signOutWatchers.add(watch);
      const storage = (event: StorageEvent) => {
        const key = options.heldAccountKey();
        for (const id of ["unassigned", ...(key ? [accountPartition(key)] : [])] as PartitionId[]) {
          if (event.key !== fenceKey(id)) continue;
          // A queued close event still owns its close generation even when
          // another tab has already reopened the current marker.
          try { const closed = event.newValue ? JSON.parse(event.newValue) as WriterFence : null; if (closed?.closed) watch(options.name, id, closed); } catch { /* malformed marker is not an authorization */ }
        }
      };
      if (typeof window !== "undefined") window.addEventListener("storage", storage);
      return () => { signOutWatchers.delete(watch); if (typeof window !== "undefined") window.removeEventListener("storage", storage); };
    },
    openAccount() {
      const held = options.heldAccountKey();
      if (held === null) throw new PartitionRefusedError("account:");
      return handle(accountPartition(held));
    },
    open: handle,
    async snapshot(ids) {
      for (const id of ids) check(id, true);
      const d = await db();
      for (const id of ids) check(id, true);
      const store = d.transaction(RECORDS, "readonly").objectStore(RECORDS);
      const groups = await Promise.all(ids.map(async partition => {
        const [keys, values] = await Promise.all([request(store.getAllKeys(range(partition))), request(store.getAll(range(partition)))]);
        return keys.map((key, i) => ({ partition, key: (key as [string, string])[1], value: values[i] }));
      }));
      for (const id of ids) check(id, true);
      return groups.flat();
    },
    clear,
    async move(from, to, keys) {
      if (from !== "unassigned" || to === "unassigned") throw new PartitionRefusedError(from);
      check(from); check(to);
      const sourceToken = adopted.get(from);
      const destinationToken = adopted.get(to);
      await transact(from, [RECORDS, SIZES], "readwrite", (tx) => {
        check(to);
        const records = tx.objectStore(RECORDS);
        const sizes = tx.objectStore(SIZES);
        const destinationFence = records.get(storedFenceKey(to));
        destinationFence.onsuccess = () => {
          try {
            check(to);
            const stored = destinationFence.result as { token: string; closed: boolean } | undefined;
            if (stored?.closed || (stored?.token ?? "initial") !== destinationToken || fence(to).token !== destinationToken) { tx.abort(); return; }
            for (const key of keys) {
              const req = records.get([from, key]);
              req.onsuccess = () => {
                try { check(from); check(to); } catch { tx.abort(); return; }
                if (fence(from).token !== sourceToken || fence(to).token !== destinationToken) { tx.abort(); return; }
                if (req.result === undefined) return;
                records.put(req.result, [to, key]);
                sizes.put(measure(req.result), [to, key]);
                records.delete([from, key]);
                sizes.delete([from, key]);
              };
            }
          } catch { tx.abort(); }
        };
      });
    },
    async sizes(prefix = "") {
      const d = await db();
      const store = d.transaction(SIZES, "readonly").objectStore(SIZES);
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
      const totals = new Map<PartitionId, PartitionSize>();
      keys.forEach((k, i) => {
        const [partition, key] = k as [PartitionId, string];
        if (!key.startsWith(prefix)) return;
        const entry = totals.get(partition) ?? { partition, bytes: 0, records: 0 };
        entry.bytes += typeof values[i] === "number" ? values[i] as number : 0;
        entry.records += 1;
        totals.set(partition, entry);
      });
      return [...totals.values()];
    },
  };
}
