/**
 * The native store's part of a chat deletion (#3229) against the actual
 * file-backed retirement ledger. Backends here are minimal seam doubles: the
 * concrete native removal is proven against the installed runtimes in the
 * Claude and Pi backend packages. Synthetic Odysseus fixtures, no network.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, SessionHistoryRemovalOutcome, SessionHistoryRemovalRequest } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createOffloopActivityStore } from "../src/activity/store-writes.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import type { RetireChatInput, RetireChatResult } from "../src/ws/chat-lifecycle.js";
import { removableBackendIds, removeRetiredNativeHistory } from "../src/ws/native-history-removal.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Seam = Pick<AgentBackend, "id" | "capabilities" | "removeSessionHistory">;
const capabilities = { resume: true, permissions: true, thinking: true, attachments: true, askUser: true, costReporting: true, concurrentSessions: true, followUp: true };
function backend(id: string, outcomes: Array<SessionHistoryRemovalOutcome | Error>, calls: SessionHistoryRemovalRequest[] = []): Seam {
  return { id, capabilities: { ...capabilities, historyRemoval: true }, async removeSessionHistory(req) {
    calls.push(req);
    const next = outcomes.shift()!;
    if (next instanceof Error) throw next;
    return { outcome: next };
  } };
}

async function fixture(backendId: string) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-native-ledger-")); roots.push(root);
  const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db);
  const catalog = createSessionCatalog(() => db, undefined, undefined, { writer, pricing: { resolve: () => null }, store: createOffloopActivityStore(db, writer) });
  const owner = createPrincipal(db, { authMethod: "password", label: "Odysseus phone", ttlSeconds: 86_400 }).id;
  catalog.persistSessionStub("voyage", "Plan the voyage home", null, backendId);
  const opened = await catalog.dialogueOpen!({ conversationId: "ithaca", principalId: owner, epoch: 1, providerId: "gemini-live", sessionId: "voyage" });
  expect(opened.generation).toBe(1);
  const request = (removableBackends: string[]): RetireChatInput => ({ operationId: "retire-voyage", principalId: owner, target: { sessionId: "voyage" },
    expected: { backendId, generation: 1 }, removableBackends, at: Date.now() });
  return { db, catalog, owner, request, async close() { await catalog.settled!(); await writer.close(); db.close(); } };
}
const retired = (result: RetireChatResult) => { if (result.status !== "retired") throw new Error(`not retired: ${JSON.stringify(result)}`); return result; };

test("only a backend that advertises and implements removal is removable; any other refuses before retirement", async () => {
  const advertisedOnly: Seam = { id: "pi", capabilities: { ...capabilities, historyRemoval: true } };
  const implementedOnly: Seam = { id: "legacy", capabilities, removeSessionHistory: async () => ({ outcome: "removed" }) };
  expect(removableBackendIds([backend("claude", []), advertisedOnly, implementedOnly])).toEqual(["claude"]);
  const f = await fixture("pi");
  try {
    expect(await f.catalog.retireChat!(f.request(removableBackendIds([backend("claude", []), advertisedOnly])), () => false),
      "UNSUPPORTED_REFUSES_BEFORE_RETIREMENT").toEqual({ status: "refused", reason: "unsupported" });
    expect((f.db.query("SELECT COUNT(*) AS n FROM chat_lifecycles").get() as { n: number }).n).toBe(0);
  } finally { await f.close(); }
});

test("the native store completes only when the backend confirms, and retries under the same operation", async () => {
  const f = await fixture("claude");
  try {
    const calls: SessionHistoryRemovalRequest[] = [];
    const claude = backend("claude", ["partial", new Error("disk went away"), "removed"], calls);
    const result = retired(await f.catalog.retireChat!(f.request(removableBackendIds([claude])), () => false));
    expect(result.stores.native).toBe("pending");
    expect(await removeRetiredNativeHistory(f.catalog, claude, result), "PARTIAL_IS_NOT_COMPLETE").toBe("partial");
    expect(retired((await f.catalog.chatRetirement!("retire-voyage", f.owner))!)).toMatchObject({ cleanup: "partial", stores: { native: "partial" } });
    expect(await removeRetiredNativeHistory(f.catalog, claude, result), "REJECTION_IS_UNKNOWN").toBe("unknown");
    // The backend confirmed native removal; the other stores are still pending under #3230.
    expect(await removeRetiredNativeHistory(f.catalog, claude, result)).toBe("pending");
    expect(calls.map(call => [call.operationId, call.sessionId])).toEqual([["retire-voyage", "voyage"], ["retire-voyage", "voyage"], ["retire-voyage", "voyage"]]);
    const stores = Object.fromEntries((f.db.query("SELECT store,outcome FROM chat_retirement_stores").all() as { store: string; outcome: string }[]).map(row => [row.store, row.outcome]));
    expect(stores).toEqual({ native: "removed", dialogue: "pending", tasks: "pending", projections: "pending", drafts: "pending" });
  } finally { await f.close(); }
});

test("a backend that is missing or no longer supports removal never completes the native store", async () => {
  const f = await fixture("claude");
  try {
    const result = retired(await f.catalog.retireChat!(f.request(["claude"]), () => false));
    expect(await removeRetiredNativeHistory(f.catalog, undefined, result), "MISSING_BACKEND_IS_PARTIAL").toBe("partial");
    expect(await removeRetiredNativeHistory(f.catalog, { id: "claude", capabilities }, result), "UNSUPPORTED_BACKEND_IS_PARTIAL").toBe("partial");
    const native = f.db.query("SELECT outcome FROM chat_retirement_stores WHERE store='native'").get() as { outcome: string };
    expect(native.outcome).toBe("partial");
  } finally { await f.close(); }
});
