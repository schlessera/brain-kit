/**
 * Where submitted answers wait on this device (Lifetime B, #910).
 *
 * IndexedDB, because Queue A allows 16 MiB and `localStorage` would hit its
 * quota well before that, and it would block the page while doing it. The
 * card shows an answer as saved on this device only after a write here has
 * committed; a write that fails leaves the answer in the card, unsent.
 *
 * Whatever comes back out is validated as untrusted input before it can be
 * replayed: a corrupt or tampered record is dropped, never sent.
 */
import { clientMessageSchema } from "@schlessera/brain-ui-sdk/schemas";
import { answerFrame, type QueuedAnswer } from "./types.js";

export interface AnswerStorage {
  /** Every stored record, raw. Validate with {@link parseQueuedAnswer}. */
  load(): Promise<unknown[]>;
  /** Resolves only once the write has committed. */
  put(item: QueuedAnswer): Promise<void>;
  remove(submissionId: string): Promise<void>;
  clear(): Promise<void>;
  /** The last principal key this device saw, for an answer submitted before the next hello. */
  getPrincipalKey(): Promise<string | null>;
  setPrincipalKey(key: string): Promise<void>;
}

const KINDS = new Set(["ask_user", "ask_user_list", "ask_user_rank", "ask_user_form"]);
const MAX_ID = 128;
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID;

/** A stored record, if it is a well-formed answer this client could send. */
export function parseQueuedAnswer(raw: unknown): QueuedAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !isId(r.submissionId) || !isId(r.principalKey) || !isId(r.requestId)) return null;
  if (r.sessionId !== null && !isId(r.sessionId)) return null;
  if (r.turnId !== null && !isId(r.turnId)) return null;
  if (typeof r.submittedAt !== "number" || !Number.isFinite(r.submittedAt)) return null;
  if (typeof r.sent !== "boolean") return null;
  const payload = r.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object" || !KINDS.has(payload.kind as string)) return null;
  if (payload.kind === "ask_user_form" && (!Array.isArray(payload.visibleNodes) || !payload.visibleNodes.every((n) => typeof n === "string"))) return null;
  if (payload.kind === "ask_user" && payload.typed !== undefined && typeof payload.typed !== "boolean") return null;
  const item = raw as QueuedAnswer;
  // The frame it would become must pass the same boundary the host applies.
  const frame = answerFrame({ ...item, turnId: item.turnId ?? "pending" });
  return clientMessageSchema.safeParse(frame).success ? item : null;
}

/** A store for tests and for a page without IndexedDB, which then cannot promise reload safety. */
export function createMemoryAnswerStorage(): AnswerStorage & { readonly records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  let principalKey: string | null = null;
  return {
    records,
    async load() {
      return [...records.values()].map((r) => structuredClone(r));
    },
    async put(item) {
      records.set(item.submissionId, structuredClone(item));
    },
    async remove(id) {
      records.delete(id);
    },
    async clear() {
      records.clear();
    },
    async getPrincipalKey() {
      return principalKey;
    },
    async setPrincipalKey(key) {
      principalKey = key;
    },
  };
}

const ANSWERS = "answers";
const META = "meta";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** IndexedDB-backed storage, one database per root storage prefix. */
export function createIndexedDbAnswerStorage(name: string, factory: IDBFactory = indexedDB): AnswerStorage {
  let opened: Promise<IDBDatabase> | null = null;
  function db(): Promise<IDBDatabase> {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(name, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(ANSWERS)) d.createObjectStore(ANSWERS, { keyPath: "submissionId" });
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    }).catch((error) => {
      // A failed open is retried on the next operation, not cached forever.
      opened = null;
      throw error;
    });
    return opened;
  }
  async function write(store: string, op: (s: IDBObjectStore) => void): Promise<void> {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(store, "readwrite");
      // `complete`, not the request's success: only then is it durable.
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
      op(tx.objectStore(store));
    });
  }
  return {
    async load() {
      const d = await db();
      return request(d.transaction(ANSWERS, "readonly").objectStore(ANSWERS).getAll());
    },
    put: (item) => write(ANSWERS, (s) => s.put(item)),
    remove: (id) => write(ANSWERS, (s) => s.delete(id)),
    clear: () => write(ANSWERS, (s) => s.clear()),
    async getPrincipalKey() {
      const d = await db();
      const value = await request(d.transaction(META, "readonly").objectStore(META).get("principalKey"));
      return typeof value === "string" ? value : null;
    },
    setPrincipalKey: (key) => write(META, (s) => s.put(key, "principalKey")),
  };
}
