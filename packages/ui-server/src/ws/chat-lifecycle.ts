/**
 * Chat identity retirement (#3228): the serialized, content-free ledger and
 * gate that every later removal owner shares. Retiring a chat fences its
 * identities permanently; it removes no content and never acknowledges a
 * completed deletion by itself. Each selected store reports its own cleanup.
 * Policy: docs/decisions/chat-history-deletion.md.
 */
import type { Database } from "bun:sqlite";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";

export type RetiredKind = "session" | "dialogue_owner" | "conversation" | "task" | "request" | "native_task";
export const CHAT_STORES = ["native", "dialogue", "tasks", "projections", "drafts"] as const;
export type ChatStore = (typeof CHAT_STORES)[number];
export type ChatStoreOutcome = "pending" | "partial" | "unknown" | "removed";

/** A write or admission under a retired identity. Content-free by construction. */
export class ChatRetiredError extends Error {
  readonly code = "chat_retired";
  constructor() { super("This chat has been retired and cannot be used again."); this.name = "ChatRetiredError"; }
}

/** A chat is named by its backend session, or by a provisional dialogue owner never bound to one. */
export type ChatTarget = { sessionId: string } | { ownerId: string };
export interface RetireChatInput {
  /** Client-minted idempotency key. A repeat returns the same result; it never re-authorizes a replacement. */
  operationId: string;
  /** The authenticated caller. Authority is re-read at commit, never inferred from history or titles. */
  principalId: string;
  target: ChatTarget;
  /** What the caller reviewed. Any difference is stale and refuses. */
  expected: { backendId: string | null; generation: number };
  /** Backends whose native removal is supported. Anything else refuses before retirement. */
  removableBackends: readonly string[];
  at: number;
}
/**
 * `unavailable` covers absent, foreign, ambiguous and already-retired targets
 * alike, so a refusal never tells a caller whether someone else's chat exists.
 * `unauthorized` describes the caller alone.
 */
export type RetireRefusal = "unauthorized" | "unavailable" | "stale" | "unsupported" | "busy";
export interface RetiredChatIdentities {
  sessions: string[]; dialogueOwners: string[]; conversations: string[]; tasks: string[]; requests: string[]; nativeTasks: string[];
}
export type ChatRetirementStatus = "pending" | "partial" | "unknown" | "removed";
export type RetireChatResult =
  | { status: "refused"; reason: RetireRefusal }
  | { status: "retired"; lifecycleId: string; operationId: string; generation: number; identities: RetiredChatIdentities;
      /** The backend whose native store was selected, or null for a provisional chat. */
      backendId: string | null;
      cleanup: ChatRetirementStatus; stores: Partial<Record<ChatStore, ChatStoreOutcome>> };

const MAX_ID = 2048;
const nativeTaskKey = (conversationId: string, epoch: number, nativeHandle: string) => JSON.stringify([conversationId, epoch, nativeHandle]);

export function isRetired(db: Database, kind: RetiredKind, id: string): boolean {
  return !!db.query("SELECT 1 FROM chat_retired_identities WHERE kind=? AND id=?").get(kind, id);
}
/** Throws `ChatRetiredError` if any named identity is retired. Absent values are ignored. */
export function assertLive(db: Database, identities: ReadonlyArray<readonly [RetiredKind, string | null | undefined]>): void {
  for (const [kind, id] of identities) if (id && isRetired(db, kind, id)) throw new ChatRetiredError();
}
export function nativeTaskRetired(db: Database, conversationId: string, epoch: number, nativeHandle: string): boolean {
  return isRetired(db, "native_task", nativeTaskKey(conversationId, epoch, nativeHandle));
}

interface Resolved {
  id: string; kind: "session" | "provisional"; principalId: string; backendId: string | null; generation: number;
  identities: RetiredChatIdentities;
}
/**
 * The exact current identity set of a chat, from verified ownership records
 * only: canonical dialogue owners (with every alias an earlier adoption
 * joined) and recorded voice conversation epochs. A chat with no such record,
 * or with records naming different principals, has unknown ownership.
 */
export function resolveChat(db: Database, target: ChatTarget): Resolved | { refused: "unavailable" | "stale" } {
  const owners = new Set<string>(), conversations = new Set<string>(), principals = new Set<string>();
  let id: string, kind: Resolved["kind"], generation = 1, sessionId: string | null = null;
  if ("sessionId" in target) {
    if (!target.sessionId || target.sessionId.length > MAX_ID) return { refused: "unavailable" };
    id = sessionId = target.sessionId; kind = "session";
    const owner = db.query("SELECT id,principal_id,generation FROM dialogue_owners WHERE session_id=?").get(sessionId) as { id: string; principal_id: string; generation: number } | null;
    if (owner) { owners.add(owner.id); principals.add(owner.principal_id); generation = owner.generation; }
    for (const row of db.query("SELECT id,principal_id FROM conversation_epochs WHERE session_id=?").all(sessionId) as { id: string; principal_id: string }[]) {
      conversations.add(row.id); principals.add(row.principal_id);
    }
  } else {
    if (!target.ownerId || target.ownerId.length > MAX_ID) return { refused: "unavailable" };
    const owner = db.query("SELECT id,principal_id,session_id,generation FROM dialogue_owners WHERE id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=?),?)")
      .get(target.ownerId, target.ownerId) as { id: string; principal_id: string; session_id: string | null; generation: number } | null;
    if (!owner) return { refused: "unavailable" };
    // Adoption made this a backend session's chat: the reviewed target changed.
    if (owner.session_id || owner.id !== target.ownerId) return { refused: "stale" };
    id = owner.id; kind = "provisional"; generation = owner.generation;
    owners.add(owner.id); principals.add(owner.principal_id);
  }
  for (const owner of [...owners]) {
    for (const row of db.query("SELECT id FROM dialogue_aliases WHERE owner_id=?").all(owner) as { id: string }[]) owners.add(row.id);
    for (const row of db.query("SELECT id FROM dialogue_conversations WHERE owner_id=?").all(owner) as { id: string }[]) conversations.add(row.id);
  }
  for (const conversation of conversations) {
    const row = db.query("SELECT principal_id FROM conversation_epochs WHERE id=?").get(conversation) as { principal_id: string } | null;
    if (row) principals.add(row.principal_id);
  }
  if (principals.size !== 1) return { refused: "unavailable" };
  const tasks: string[] = [], requests: string[] = [], nativeTasks: string[] = [];
  for (const conversation of conversations) {
    for (const row of db.query("SELECT epoch,native_handle,task_id,request_id FROM conversation_tasks WHERE conversation_id=? ORDER BY rowid").all(conversation) as { epoch: number; native_handle: string; task_id: string; request_id: string }[]) {
      tasks.push(row.task_id); requests.push(row.request_id); nativeTasks.push(nativeTaskKey(conversation, row.epoch, row.native_handle));
    }
  }
  const backend = sessionId ? db.query("SELECT backend_id FROM sessions WHERE id=?").get(sessionId) as { backend_id: string | null } | null : null;
  return { id, kind, principalId: [...principals][0]!, backendId: backend?.backend_id ?? null, generation, identities: {
    sessions: sessionId ? [sessionId] : [], dialogueOwners: [...owners].sort(), conversations: [...conversations].sort(), tasks, requests, nativeTasks } };
}

/** The caller alone: a usable owner principal. Ambient callers have no owner mapping, agents never delete. */
export function authorizedOwner(db: Database, principalId: string, at: number): boolean {
  const principal = resolvePrincipal(db, principalId);
  return !!principal && principal.kind === "owner" && isUsablePrincipal(principal, at);
}

function stored(db: Database, lifecycleId: string): Partial<Record<ChatStore, ChatStoreOutcome>> {
  return Object.fromEntries((db.query("SELECT store,outcome FROM chat_retirement_stores WHERE lifecycle_id=? ORDER BY store").all(lifecycleId) as { store: ChatStore; outcome: ChatStoreOutcome }[])
    .map(row => [row.store, row.outcome]));
}
/** Completed only when every selected store confirmed removal; unknown dominates partial, partial dominates pending. */
export function cleanupStatus(stores: Partial<Record<ChatStore, ChatStoreOutcome>>): ChatRetirementStatus {
  const outcomes = Object.values(stores);
  if (!outcomes.length) return "pending";
  if (outcomes.includes("unknown")) return "unknown";
  if (outcomes.includes("partial")) return "partial";
  return outcomes.every(outcome => outcome === "removed") ? "removed" : "pending";
}
export function identitiesOf(db: Database, lifecycleId: string): RetiredChatIdentities {
  const rows = db.query("SELECT kind,id FROM chat_retired_identities WHERE lifecycle_id=? ORDER BY kind,id").all(lifecycleId) as { kind: RetiredKind; id: string }[];
  const of = (kind: RetiredKind) => rows.filter(row => row.kind === kind).map(row => row.id);
  return { sessions: of("session"), dialogueOwners: of("dialogue_owner"), conversations: of("conversation"), tasks: of("task"), requests: of("request"), nativeTasks: of("native_task") };
}
function receipt(db: Database, row: { id: string; operation_id: string; generation: number; backend_id: string | null }): RetireChatResult {
  const stores = stored(db, row.id);
  return { status: "retired", lifecycleId: row.id, operationId: row.operation_id, generation: row.generation, identities: identitiesOf(db, row.id),
    backendId: row.backend_id, cleanup: cleanupStatus(stores), stores };
}
const targetId = (target: ChatTarget) => "sessionId" in target ? target.sessionId : target.ownerId;

/**
 * One immediate transaction on the serialized writer: re-check the caller's
 * authority, resolve the exact identity set (an adoption committed earlier is
 * included), compare it with what was reviewed, then persist the content-free
 * intent, terminal generation and every fence before any cleanup is accepted.
 * Writes submitted after it refuse. Busy holders are the host's to judge and
 * are refused before submission.
 */
export function retireChat(db: Database, input: RetireChatInput): RetireChatResult {
  if (!input.operationId || input.operationId.length > MAX_ID) return { status: "refused", reason: "unavailable" };
  return db.transaction((): RetireChatResult => {
    if (!authorizedOwner(db, input.principalId, input.at)) return { status: "refused", reason: "unauthorized" };
    const previous = db.query("SELECT id,principal_id,operation_id,generation,backend_id FROM chat_lifecycles WHERE operation_id=?")
      .get(input.operationId) as { id: string; principal_id: string; operation_id: string; generation: number; backend_id: string | null } | null;
    if (previous) {
      // The same key for the same owner and target is the same operation.
      return previous.principal_id === input.principalId && previous.id === targetId(input.target)
        ? receipt(db, previous) : { status: "refused", reason: "unavailable" };
    }
    if ("sessionId" in input.target ? isRetired(db, "session", input.target.sessionId) : isRetired(db, "dialogue_owner", input.target.ownerId))
      return { status: "refused", reason: "unavailable" };
    const chat = resolveChat(db, input.target);
    if ("refused" in chat) return { status: "refused", reason: chat.refused === "stale" && ownsAlias(db, input) ? "stale" : "unavailable" };
    if (chat.principalId !== input.principalId) return { status: "refused", reason: "unavailable" };
    if (chat.backendId !== input.expected.backendId || chat.generation !== input.expected.generation) return { status: "refused", reason: "stale" };
    if (chat.backendId !== null && !input.removableBackends.includes(chat.backendId)) return { status: "refused", reason: "unsupported" };
    const generation = chat.generation + 1;
    db.prepare("INSERT INTO chat_lifecycles(id,kind,principal_id,backend_id,generation,operation_id,retired_at) VALUES(?,?,?,?,?,?,?)")
      .run(chat.id, chat.kind, chat.principalId, chat.backendId, generation, input.operationId, input.at);
    const fence = db.prepare("INSERT OR IGNORE INTO chat_retired_identities(kind,id,lifecycle_id) VALUES(?,?,?)");
    const kinds: [RetiredKind, string[]][] = [["session", chat.identities.sessions], ["dialogue_owner", chat.identities.dialogueOwners],
      ["conversation", chat.identities.conversations], ["task", chat.identities.tasks], ["request", chat.identities.requests], ["native_task", chat.identities.nativeTasks]];
    for (const [kind, ids] of kinds) for (const id of ids) fence.run(kind, id, chat.id);
    const stores: ChatStore[] = [...(chat.backendId !== null ? ["native" as const] : []), "dialogue", "tasks", "projections", "drafts"];
    const intent = db.prepare("INSERT INTO chat_retirement_stores(lifecycle_id,store,outcome,updated_at) VALUES(?,?,'pending',?)");
    for (const store of stores) intent.run(chat.id, store, input.at);
    // Old cursors and live epochs lose authority; content stays for its owners to remove.
    for (const owner of chat.identities.dialogueOwners) db.prepare("UPDATE dialogue_owners SET generation=? WHERE id=?").run(generation, owner);
    for (const conversation of chat.identities.conversations) db.prepare("UPDATE dialogue_conversations SET closed=1 WHERE id=?").run(conversation);
    return receipt(db, { id: chat.id, operation_id: input.operationId, generation, backend_id: chat.backendId });
  }).immediate();
}
/** Whether a stale provisional target is the caller's own; otherwise staleness would reveal it. */
function ownsAlias(db: Database, input: RetireChatInput): boolean {
  if (!("ownerId" in input.target)) return false;
  const row = db.query("SELECT principal_id FROM dialogue_owners WHERE id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=?),?)")
    .get(input.target.ownerId, input.target.ownerId) as { principal_id: string } | null;
  return row?.principal_id === input.principalId;
}

/** The retirement's current non-content outcome for its owner, or null. */
export function chatRetirement(db: Database, operationId: string, principalId: string): RetireChatResult | null {
  const row = db.query("SELECT id,principal_id,operation_id,generation,backend_id FROM chat_lifecycles WHERE operation_id=?")
    .get(operationId) as { id: string; principal_id: string; operation_id: string; generation: number; backend_id: string | null } | null;
  return row && row.principal_id === principalId ? receipt(db, row) : null;
}

/**
 * Every retirement whose cleanup is not yet confirmed by each selected store,
 * oldest first: the restart reconciliation's work list (#3230). Content-free.
 */
export function unfinishedChatRetirements(db: Database): Array<Extract<RetireChatResult, { status: "retired" }> & { principalId: string }> {
  const rows = db.query(`SELECT id,principal_id,operation_id,generation,backend_id FROM chat_lifecycles
    WHERE id IN (SELECT lifecycle_id FROM chat_retirement_stores WHERE outcome!='removed') ORDER BY retired_at,id`)
    .all() as { id: string; principal_id: string; operation_id: string; generation: number; backend_id: string | null }[];
  return rows.map(row => ({ ...receipt(db, row) as Extract<RetireChatResult, { status: "retired" }>, principalId: row.principal_id }));
}

/**
 * A store owner reports its cleanup under the retirement's intent. Idempotent;
 * a confirmed removal is final, and a store not selected at retirement is refused.
 */
export function recordChatCleanup(db: Database, lifecycleId: string, store: ChatStore, outcome: Exclude<ChatStoreOutcome, "pending">, at: number): ChatRetirementStatus {
  return db.transaction(() => {
    const row = db.query("SELECT outcome FROM chat_retirement_stores WHERE lifecycle_id=? AND store=?").get(lifecycleId, store) as { outcome: ChatStoreOutcome } | null;
    if (!row) throw new Error("Chat cleanup store was not selected");
    if (row.outcome !== "removed" && row.outcome !== outcome)
      db.prepare("UPDATE chat_retirement_stores SET outcome=?,updated_at=? WHERE lifecycle_id=? AND store=?").run(outcome, at, lifecycleId, store);
    return cleanupStatus(stored(db, lifecycleId));
  }).immediate();
}
