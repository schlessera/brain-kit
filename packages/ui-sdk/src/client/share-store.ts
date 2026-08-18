/**
 * Where a share waits between the service worker and the app.
 *
 * A POST share target hands the service worker a payload and expects a redirect
 * back; there is nowhere to put files in a URL, so they are parked here and the
 * redirect carries only an id. IndexedDB rather than Cache Storage: structured
 * clone stores `File`/`Blob` natively, so no part of the payload has to be
 * wrapped in a synthesized `Response` and unwrapped again.
 *
 * The store is an interface with an injectable implementation because the
 * handler has to be testable off-browser — Bun has no IndexedDB.
 */

/** One share, exactly as the sharing app handed it over. */
export interface StoredShare {
  id: string;
  receivedAt: number;
  title?: string;
  text?: string;
  url?: string;
  files: File[];
}

export interface ShareStore {
  put(record: StoredShare): Promise<void>;
  get(id: string): Promise<StoredShare | undefined>;
  /**
   * Read a share and delete it in ONE transaction.
   *
   * This is the claim operation, and its atomicity is what stops a share being
   * processed twice. The app is reloaded by its own service-worker update path,
   * and a reload preserves the query string — so `?share=<id>` can be read
   * again while the first upload is still in flight. Whoever takes the record
   * first owns it; the second reader gets undefined.
   */
  take(id: string): Promise<StoredShare | undefined>;
  /** Every stored share, oldest first. */
  list(): Promise<StoredShare[]>;
  delete(id: string): Promise<void>;
}

const DB_NAME = "brain-ui-shares";
const DB_VERSION = 1;
const STORE_NAME = "shares";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb_request_failed"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb_open_failed"));
    // A blocked upgrade means another tab holds an older version open. Failing
    // is better than hanging: the caller redirects with an error and the share
    // is re-offered rather than silently swallowed.
    req.onblocked = () => reject(new Error("indexeddb_blocked"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_NAME, mode);
    const result = await request(run(tx.objectStore(STORE_NAME)));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? new Error("indexeddb_transaction_failed"));
    });
    return result;
  } finally {
    db.close();
  }
}

/** Read and delete in one transaction — see ShareStore.take. */
async function takeFromDatabase(id: string): Promise<StoredShare | undefined> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const objectStore = tx.objectStore(STORE_NAME);
    const record = (await request(objectStore.get(id))) as StoredShare | undefined;
    if (record) await request(objectStore.delete(id));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? new Error("indexeddb_transaction_failed"));
    });
    return record;
  } finally {
    db.close();
  }
}

/** The real store. Only usable where `indexedDB` exists (window or worker). */
export function createIndexedDbShareStore(): ShareStore {
  return {
    put: (record) => withStore("readwrite", (store) => store.put(record)).then(() => undefined),
    get: (id) => withStore("readonly", (store) => store.get(id)),
    take: takeFromDatabase,
    delete: (id) => withStore("readwrite", (store) => store.delete(id)).then(() => undefined),
    async list() {
      const all = (await withStore("readonly", (store) => store.getAll())) as StoredShare[];
      return all.sort((a, b) => a.receivedAt - b.receivedAt);
    },
  };
}

let store: ShareStore | null = null;

/**
 * The process-wide store. Created lazily so importing this module in an
 * environment without IndexedDB (a test, a server render) costs nothing.
 */
export function getShareStore(): ShareStore {
  if (!store) store = createIndexedDbShareStore();
  return store;
}

/**
 * Swap the store. A test hook, not an extension point: persistence here is
 * IndexedDB and nothing else, and this is deliberately absent from the
 * package's public exports so it cannot become a storage seam.
 */
export function setShareStoreForTests(next: ShareStore | null): void {
  store = next;
}

/**
 * Drop stashed shares older than the TTL.
 *
 * Nothing else ever deletes a record the app fails to claim — a share made
 * while logged out and then abandoned, or one whose upload never succeeded —
 * and those records hold whole files. Called opportunistically after each
 * stash, so the bound costs one extra transaction per share.
 */
export async function pruneStoredShares(
  store: ShareStore,
  ttlMs: number,
  now = Date.now()
): Promise<number> {
  const stale = (await store.list()).filter(
    (record) => now - record.receivedAt > ttlMs
  );
  for (const record of stale) await store.delete(record.id);
  return stale.length;
}

/** An in-memory store, for tests and for probing the handler off-browser. */
export function createMemoryShareStoreForTests(): ShareStore {
  const records = new Map<string, StoredShare>();
  return {
    async put(record) {
      records.set(record.id, record);
    },
    async get(id) {
      return records.get(id);
    },
    async take(id) {
      const record = records.get(id);
      records.delete(id);
      return record;
    },
    async delete(id) {
      records.delete(id);
    },
    async list() {
      return [...records.values()].sort((a, b) => a.receivedAt - b.receivedAt);
    },
  };
}
