/** Server-owned association and filing evidence; quoted IDs grant no authority. */
import type { Database } from "bun:sqlite";
import { constants, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { SHARE_MAX_FILE_BYTES, type ShareIntakeResult, type InboxQueueItem } from "@schlessera/brain-ui-sdk/protocol";
import { BRAIN_APPLICATION_MAX_BYTES, BRAIN_LOCK_KEY, brainApplicationInput, type BrainApplicationInput, type BrainApplicationResult, type BrainApplicationPolicy } from "@schlessera/brain-ui-sdk/server";
import { COMPLETE_SHARE_INPUT_SCHEMA, type CompleteShareInput, type CompleteShareResult } from "@schlessera/brain-ui-sdk/tool-contracts";
import { readBrainApplicationBase } from "../brain/application.js";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { createInboxStore } from "./store.js";
import { acquireInboxRunLifetime, inboxRunIsLive } from "./lifetime.js";
import { enqueueInboxCleanup } from "./actions.js";
import { recoverAutonomousItem } from "./yield.js";
import { assertInboxRecoveryReady } from "./recovery-gate.js";

interface Binding { item_id: string; staging_id: string; principal_id: string; session_id: string | null; run_id: string; completion_json: string | null }
interface Application { id: string; input_json: string; result_json: string | null; run_id: string }
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Read each path through directory descriptors, refusing aliases and hardlinks. */
function binary(root: string, path: string): Buffer {
  const parts = path.split("/");
  if (parts.some(p => !p || p === "." || p === "..") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("Unsupported binary evidence path");
  const fds: number[] = [];
  try {
    fds.push(openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    for (const part of parts.slice(0, -1)) fds.push(openSync(`/proc/self/fd/${fds.at(-1)}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    const fd = openSync(`/proc/self/fd/${fds.at(-1)}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    fds.push(fd);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > SHARE_MAX_FILE_BYTES) throw new Error("Unsupported binary evidence");
    return readFileSync(fd);
  } finally { for (const fd of fds.reverse()) closeSync(fd); }
}

export function createInteractiveShares(db: Database, root: string) {
  const store = createInboxStore(db);
  const lives = new Map<string, ReturnType<typeof acquireInboxRunLifetime>>();
  const bindingFor = (sessionId: string) => db.query("SELECT * FROM inbox_interactive_shares WHERE session_id = ?").get(sessionId) as Binding | null;
  function authorize(principalId: string, current: () => boolean) {
    assertInboxRecoveryReady(db);
    const principal = resolvePrincipal(db, principalId);
    if (!current() || !principal || !isUsablePrincipal(principal, Date.now())) throw new Error("Share principal or turn is no longer authorized");
  }
  function start(principalId: string, runId: string, sessionId: string | undefined, stagingId: string | undefined, current: () => boolean) {
    return db.transaction(() => {
      let binding = sessionId ? bindingFor(sessionId) : null;
      // Ordinary chat retains its existing admission path. Only a confirmed
      // intake or an already bound session enters this additional lifecycle.
      if (!stagingId && !binding) return;
      authorize(principalId, current);
      if (stagingId) {
        const receipt = db.query("SELECT item_id FROM inbox_intake_receipts WHERE staging_id = ? AND principal_id = ? AND source = 'share' AND state = 'committed'")
          .get(stagingId, principalId) as { item_id: string } | null;
        if (!receipt) throw new Error("No authenticated share intake matches this start");
        const prior = db.query("SELECT * FROM inbox_interactive_shares WHERE item_id = ?").get(receipt.item_id) as Binding | null;
        if (prior && (prior.session_id ? prior.session_id !== sessionId : inboxRunIsLive(db, prior.run_id))) throw new Error(prior.session_id ? `Share already belongs to session ${prior.session_id}` : "Share start is already in progress");
        if (binding && binding.item_id !== receipt.item_id) throw new Error("Session is bound to a different share");
        binding = prior ?? { item_id: receipt.item_id, staging_id: stagingId, principal_id: principalId, session_id: sessionId ?? null, run_id: runId, completion_json: null };
      }
      if (!binding) return;
      if (binding.principal_id !== principalId) throw new Error("Share belongs to another principal");
      if (binding.completion_json) return;
      const item = store.getItem(binding.item_id);
      if (!item || item.queue !== "queue" || item.type !== "triage") throw new Error("Share item is unavailable");
      if (item.status === "claimed") {
        if (item.runId !== runId && (item.leaseUntil! > Date.now() || inboxRunIsLive(db, item.runId!))) throw new Error("Share already has a live owner");
        // The existing runtime owns expired-lease recovery, including attempt limits.
        if (item.runId !== runId) throw new Error("Share awaits lease recovery");
      } else {
        if (item.status !== "ready" || item.expiresAt <= Date.now() || (item.waitUntil ?? 0) > Date.now()) throw new Error("Share is not ready for recovery");
        store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version, to: "claimed", runId, leaseUntil: Date.now() + 10 * 60_000 }]);
      }
      if (!db.query("SELECT 1 FROM inbox_interactive_shares WHERE item_id = ?").get(binding.item_id))
        db.query("INSERT INTO inbox_interactive_shares (item_id, staging_id, principal_id, session_id, run_id) VALUES (?, ?, ?, ?, ?)").run(binding.item_id, binding.staging_id, principalId, binding.session_id, runId);
      else db.query("UPDATE inbox_interactive_shares SET run_id = ? WHERE item_id = ?").run(runId, binding.item_id);
      lives.set(runId, acquireInboxRunLifetime(db, runId));
    }).immediate();
  }
  function bound(principalId: string, runId: string, sessionId: string, current: () => boolean): Binding {
    authorize(principalId, current);
    const binding = bindingFor(sessionId);
    if (!binding || binding.principal_id !== principalId || (!binding.completion_json && binding.run_id !== runId)) throw new Error("No matching server-owned share/session binding");
    if (!binding.completion_json) {
      const item = store.getItem(binding.item_id);
      if (item?.queue !== "queue" || item.status !== "claimed" || item.runId !== runId || !lives.has(runId)) throw new Error("Share claim is no longer owned by this turn");
    }
    return binding;
  }
  function replayResult(row: Application): BrainApplicationResult {
    if (!row.result_json) throw new Error("Filing outcome is uncertain; inspect existing content and preserve originals, never repeat the write");
    return JSON.parse(row.result_json) as BrainApplicationResult;
  }
  return {
    start,
    resolveSession(principalId: string, stagingId: string, requested: string | undefined, current: () => boolean): string | undefined {
      authorize(principalId, current);
      const receipt = db.query("SELECT item_id FROM inbox_intake_receipts WHERE staging_id = ? AND principal_id = ? AND source = 'share' AND state = 'committed'").get(stagingId, principalId) as { item_id: string } | null;
      if (!receipt) throw new Error("No authenticated share intake matches this start");
      const prior = db.query("SELECT session_id FROM inbox_interactive_shares WHERE item_id = ?").get(receipt.item_id) as { session_id: string | null } | null;
      if (prior?.session_id && requested && requested !== prior.session_id) throw new Error("Share belongs to a different filing session");
      return prior?.session_id ?? requested;
    },
    bind(runId: string, sessionId: string) {
      db.transaction(() => {
        const row = db.query("SELECT * FROM inbox_interactive_shares WHERE run_id = ?").get(runId) as Binding | null;
        if (!row) return;
        if (row.session_id && row.session_id !== sessionId) throw new Error("Share session identity changed");
        db.query("UPDATE inbox_interactive_shares SET session_id = ? WHERE item_id = ?").run(sessionId, row.item_id);
      }).immediate();
    },
    end(runId: string) {
      lives.get(runId)?.close(); lives.delete(runId);
      const row = db.query("SELECT item_id FROM inbox_interactive_shares WHERE run_id = ?").get(runId) as { item_id: string } | null;
      const item = row ? store.getItem(row.item_id) : null;
      if (item?.queue === "queue") {
        if (item.status === "claimed") recoverAutonomousItem(db, item);
        else if (item.status === "done") enqueueInboxCleanup(db, item.threadId, Date.now());
      }
    },
    async apply(principalId: string, runId: string, sessionId: string | undefined, current: () => boolean, input: BrainApplicationInput,
      apply: () => Promise<BrainApplicationResult>): Promise<BrainApplicationResult> {
      if (!sessionId) {
        if (db.query("SELECT 1 FROM inbox_interactive_shares WHERE run_id = ?").get(runId)) throw new Error("Bound share filing requires its server-named session before any application");
        return apply();
      }
      if (!bindingFor(sessionId)) return apply();
      const binding = bound(principalId, runId, sessionId, current);
      const parsed = brainApplicationInput.safeParse(input);
      if (!parsed.success) return apply();
      const json = JSON.stringify(parsed.data);
      if (Buffer.byteLength(json, "utf8") > BRAIN_APPLICATION_MAX_BYTES) return apply();
      // A lost write reply often prompts a fresh base read. That new base
      // cannot turn the same filing effect into a second append/application.
      const operationKey = hash(JSON.stringify(parsed.data, (key, value) => key === "expectedBaseHash" ? undefined : value));
      if (binding.completion_json) {
        const prior = db.query("SELECT * FROM inbox_share_applications WHERE item_id = ? AND operation_key = ?").get(binding.item_id, operationKey) as Application | null;
        if (prior) {
          const previous = replayResult(prior);
          if (!(prior.run_id !== runId && previous.ok === false && Array.isArray(previous.changes) && previous.changes.length === 0)) return previous;
        }
        // Known no-effect refusals do not disable ordinary later work. A
        // successful or uncertain filing still cannot be written twice.
        return apply();
      }
      const receiptId = db.transaction(() => {
        bound(principalId, runId, sessionId, current);
        const prior = db.query("SELECT * FROM inbox_share_applications WHERE item_id = ? AND operation_key = ?").get(binding.item_id, operationKey) as Application | null;
        if (prior) {
          const previous = prior.result_json ? JSON.parse(prior.result_json) as BrainApplicationResult : null;
          // Only a fresh, bounded Queue claim may retry a proven no-effect
          // refusal. Success, uncertainty and partial effects never replay writes.
          if (prior.run_id !== runId && previous?.ok === false && Array.isArray(previous.changes) && previous.changes.length === 0) {
            db.query("UPDATE inbox_share_applications SET input_json = ?, run_id = ?, result_json = NULL WHERE id = ?").run(json, runId, prior.id);
            return { ...prior, input_json: json, run_id: runId, result_json: null, created: true };
          }
          return prior;
        }
        const count = db.query("SELECT COUNT(*) AS n FROM inbox_share_applications WHERE item_id = ?").get(binding.item_id) as { n: number };
        if (count.n >= 32) throw new Error("Share filing receipt limit reached; preserve originals for recovery");
        const id = crypto.randomUUID();
        db.query("INSERT INTO inbox_share_applications (id, item_id, input_json, operation_key, run_id) VALUES (?, ?, ?, ?, ?)").run(id, binding.item_id, json, operationKey, runId);
        return { id, input_json: json, result_json: null, run_id: runId, created: true };
      }).immediate();
      if (!("created" in receiptId)) {
        return replayResult(receiptId);
      }
      const result = await apply();
      const receipt = { ...result, ...(result.ok && result.changes.length ? { shareReceiptId: receiptId.id } : {}) };
      db.query("UPDATE inbox_share_applications SET result_json = ? WHERE id = ? AND result_json IS NULL").run(JSON.stringify(receipt), receiptId.id);
      return receipt;
    },
    async complete(principalId: string, runId: string, sessionId: string | undefined, current: () => boolean, raw: CompleteShareInput,
      approve: () => Promise<boolean>, lock: BrainApplicationPolicy["lock"]): Promise<CompleteShareResult> {
      const input = COMPLETE_SHARE_INPUT_SCHEMA.parse(raw);
      if (!sessionId) throw new Error("Share completion requires a named bound session");
      const initial = bound(principalId, runId, sessionId, current);
      const json = JSON.stringify(input);
      if (initial.completion_json) {
        if (initial.completion_json !== json) throw new Error("Completion replay differs from the committed disposition");
        return { itemId: initial.item_id, status: "done", replay: true };
      }
      if (input.files.some(f => f.disposition === "discarded") && !await approve()) throw new Error("The exact binary discard was not approved; originals remain recoverable");
      return lock.withLock(BRAIN_LOCK_KEY, () => db.transaction(() => {
        const binding = bound(principalId, runId, sessionId, current);
        if (binding.completion_json) {
          if (binding.completion_json !== json) throw new Error("Completion replay differs from the committed disposition");
          return { itemId: binding.item_id, status: "done" as const, replay: true };
        }
        if (new Set(input.receiptIds).size !== input.receiptIds.length) throw new Error("Require distinct filing receipts");
        const documents: string[] = [];
        for (const id of input.receiptIds) {
          const row = db.query("SELECT result_json FROM inbox_share_applications WHERE id = ? AND item_id = ?").get(id, binding.item_id) as { result_json: string | null } | null;
          const receipt = row?.result_json ? JSON.parse(row.result_json) as BrainApplicationResult : null;
          if (!receipt?.ok || receipt.shareReceiptId !== id || !receipt.changes.length) throw new Error("Unsupported, forged or unrelated filing receipt");
          for (const change of receipt.changes) {
            if (!change.contentHash) throw new Error("Destructive effects do not prove share filing");
            const document = readBrainApplicationBase(root, change.path);
            if (document.expectedBaseHash !== change.contentHash) throw new Error("Filed content no longer matches its authoritative receipt");
            documents.push(document.content);
          }
        }
        // A source reference identifies the filing, rather than an unrelated write
        // made in the same chat. It is evidence of association, never a trust grant.
        if (!documents.some(d => d.includes(`share-source:${binding.staging_id}`))) throw new Error("Filing must reference this share's source identity");
        const row = db.query("SELECT result_json, binary_hashes_json FROM inbox_intake_receipts WHERE item_id = ? AND state = 'committed'").get(binding.item_id) as { result_json: string; binary_hashes_json: string };
        const manifest = JSON.parse(row.result_json) as ShareIntakeResult;
        const originalHashes = JSON.parse(row.binary_hashes_json) as { path: string; sha256: string }[];
        if (manifest.skipped?.length) throw new Error("Incomplete intake cannot be marked successfully filed");
        if (input.files.length !== manifest.files.length || new Set(input.files.map(f => f.sourcePath)).size !== input.files.length) throw new Error("Every original needs exactly one disposition");
        for (const file of manifest.files) {
          const disposition = input.files.find(f => f.sourcePath === file.path);
          if (!disposition) throw new Error("An original has no supported disposition");
          const source = binary(root, file.path);
          if (source.length !== file.bytes || originalHashes.find(h => h.path === file.path)?.sha256 !== hash(source)) throw new Error("Staged original does not match verified intake evidence");
          if (disposition.disposition === "retained") {
            if (!disposition.path.startsWith("assets/") || disposition.path.split("/").some(p => p.startsWith("."))) throw new Error("Retained evidence requires an ordinary assets path");
            if (hash(binary(root, disposition.path)) !== hash(source)) throw new Error("Retained binary differs from the original");
            if (!documents.some(d => d.includes(`](${disposition.path})`))) throw new Error("Retained binary must be linked by the filed document");
          }
        }
        authorize(principalId, current);
        const item = store.getItem(binding.item_id) as InboxQueueItem;
        store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version, to: "done" }]);
        db.query("UPDATE inbox_interactive_shares SET completion_json = ? WHERE item_id = ? AND completion_json IS NULL").run(json, item.id);
        enqueueInboxCleanup(db, item.threadId, Date.now());
        return { itemId: item.id, status: "done" as const, replay: false };
      }).immediate());
    },
  };
}
