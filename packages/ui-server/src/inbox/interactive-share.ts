/** Hosted share orchestration; its complete transactions run on the write worker. */
import type { Database } from "bun:sqlite";
import { BRAIN_LOCK_KEY, type BrainApplicationInput, type BrainApplicationResult, type BrainApplicationPolicy } from "@schlessera/brain-ui-sdk/server";
import { COMPLETE_SHARE_INPUT_SCHEMA, type CompleteShareInput, type CompleteShareResult } from "@schlessera/brain-ui-sdk/tool-contracts";
import { procedureCaller } from "../db/write-worker.js";
import { inboxWriter } from "./write-runtime.js";
import * as writes from "./interactive-share-writes.js";

interface Binding { item_id: string; completion_json: string | null }
type Application = { kind: "ordinary" } | { kind: "replay"; result: BrainApplicationResult } | { kind: "reserved"; id: string };

export function createInteractiveShares(db: Database, root: string) {
  const call = procedureCaller(db, writes, { root }, inboxWriter(db));
  const authorize = (current: () => boolean) => {
    if (!current()) throw new Error("Share principal or turn is no longer authorized");
  };
  return {
    start(principalId: string, runId: string, sessionId: string | undefined, stagingId: string | undefined, current: () => boolean) {
      authorize(current);
      return call<void>("start", principalId, runId, sessionId, stagingId);
    },
    resolveSession(principalId: string, stagingId: string, requested: string | undefined, current: () => boolean) {
      authorize(current);
      return call<string | undefined>("resolveSession", principalId, stagingId, requested);
    },
    bind: (runId: string, sessionId: string) => call<void>("bind", runId, sessionId),
    end: (runId: string) => call<void>("end", runId),
    async apply(principalId: string, runId: string, sessionId: string | undefined, current: () => boolean, input: BrainApplicationInput,
      apply: () => Promise<BrainApplicationResult>): Promise<BrainApplicationResult> {
      authorize(current);
      const reserved = await call<Application>("reserveApplication", principalId, runId, sessionId, input);
      if (reserved.kind === "replay") return reserved.result;
      authorize(current);
      const result = await apply();
      if (reserved.kind === "ordinary") return result;
      const receipt = { ...result, ...(result.ok && result.changes.length ? { shareReceiptId: reserved.id } : {}) };
      await call("saveApplication", reserved.id, receipt);
      return receipt;
    },
    async complete(principalId: string, runId: string, sessionId: string | undefined, current: () => boolean, raw: CompleteShareInput,
      approve: () => Promise<boolean>, lock: BrainApplicationPolicy["lock"], assertVisible?: (paths: string[]) => void): Promise<CompleteShareResult> {
      const input = COMPLETE_SHARE_INPUT_SCHEMA.parse(raw);
      assertVisible?.(input.files.flatMap(file => file.disposition === "retained" ? [file.sourcePath, file.path] : [file.sourcePath]));
      if (!sessionId) throw new Error("Share completion requires a named bound session");
      authorize(current);
      const initial = await call<Binding>("completion", principalId, runId, sessionId);
      if (initial.completion_json) {
        if (initial.completion_json !== JSON.stringify(input)) throw new Error("Completion replay differs from the committed disposition");
        return { itemId: initial.item_id, status: "done", replay: true };
      }
      // The turn's fixed provider mask is checked before submitting the write.
      // The worker re-reads every receipt and verifies the bytes under the lock.
      if (assertVisible) for (const id of input.receiptIds) {
        const row = db.query("SELECT result_json FROM inbox_share_applications WHERE id = ? AND item_id = ?").get(id, initial.item_id) as { result_json: string | null } | null;
        const receipt = row?.result_json ? JSON.parse(row.result_json) as BrainApplicationResult : null;
        assertVisible(receipt?.changes.map(change => change.path) ?? []);
      }
      if (input.files.some(f => f.disposition === "discarded") && !await approve()) throw new Error("The exact binary discard was not approved; originals remain recoverable");
      return lock.withLock(BRAIN_LOCK_KEY, () => {
        authorize(current);
        return call<CompleteShareResult>("complete", principalId, runId, sessionId, input);
      });
    },
  };
}
