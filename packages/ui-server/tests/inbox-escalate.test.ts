import { afterEach, expect, test } from "bun:test";
import type { InboxActionItem, InboxOperation, AgentBackend } from "@schlessera/brain-ui-sdk/server";
import { requestToolPermission } from "@schlessera/brain-ui-sdk/server";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { createActivityStore } from "../src/activity/store.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createInboxBudget } from "../src/inbox/budget.js";
import { runAutonomousTurn } from "../src/inbox/autonomous-turn.js";
import { escalateInbox } from "../src/inbox/escalate.js";
import { createInboxResolver } from "../src/inbox/resolve.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const operation: InboxOperation = { toolName: "write", input: { path: "notes/harbor.md", content: "Odysseus returned." }, targetPath: "notes/harbor.md" };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "brain-action-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ui.sqlite"), db = createUiDb(path);
  cleanup.push(() => db.close());
  const now = Date.now(), principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const store = createInboxStore(db);
  store.ingest({ threadId: "harbor", itemId: "share", dedupKey: "share", source: "share", stagingId: crypto.randomUUID(), stakes: 2, expiresAt: now + 86_400_000 });
  const budget = createInboxBudget(db, { config: { spendUsd: 5, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 }, pricing: { resolve: () => null } });
  budget.claim("share", { runId: "run", principalId: principal.id, model: "fixture", billingMode: "subscription", purpose: "execute" }, now + 600_000);
  const action: InboxActionItem = { id: "approve-harbor", dedupKey: "approve-harbor", threadId: "harbor", queue: "actions", type: "approve", status: "pending", version: 1, createdAt: now, updatedAt: now, expiresAt: now + 86_400_000,
    payload: { title: "Write the harbor note?", detail: "Write notes/harbor.md once." }, options: [
      { id: "approve", label: "Write once", effect: { kind: "enqueue", payload: { instruction: "Write the harbor note", operation } } },
      { id: "deny", label: "Cancel", effect: { kind: "cancel_blocked" } },
      { id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } },
      { id: "later", label: "Later", effect: { kind: "snooze" } },
    ] };
  const escalation = { kind: "permission" as const, runId: "run", principalId: principal.id, stateMd: "Odysseus inspected the harbor.", request: { toolUseId: "write-harbor", toolName: operation.toolName, input: operation.input } };
  return { path, db, store, budget, principal, now, action, escalation };
}

test("real backend escalation commits checkpoint, Action and block before abort and settles its run", async () => {
  const f = setup();
  let starts = 0;
  const backend: AgentBackend = { id: "fixture", capabilities: { autonomous: true, resume: false, permissions: true, thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false }, listProfiles: () => [], listSessions: async () => [], getHistory: async () => [], startTurn: async (req) => {
    starts++;
    req.bridge.emit({ type: "text_delta", text: f.escalation.stateMd });
    const decision = await requestToolPermission(req.bridge, f.escalation.request, { noGrantSurface: true });
    expect(decision.behavior).toBe("deny");
    expect(req.signal.aborted).toBe(true);
    expect(f.store.getItem("share")).toMatchObject({ status: "blocked", blockedByItemId: f.action.id });
    req.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: "cancelled", isError: false, durationMs: 1, numTurns: 1 });
  } };
  const activity = createActivityStore(f.db, { writer: "fixture" });
  await runAutonomousTurn({ db: f.db, store: activity, backend, checkpoint: (escalation) => {
    escalateInbox(f.db, { itemId: "share", expectedVersion: 2, escalation, action: f.action, allowedOperations: [operation] });
  } }, { turnId: "run", principalId: f.principal.id, prompt: "Inspect Odysseus's harbor", billingMode: "subscription", allowedTools: ["read"], systemPromptAppend: "Server instructions", signal: new AbortController().signal });
  expect(starts).toBe(1);
  expect(f.store.checkpoints("harbor")).toHaveLength(1);
  expect(f.store.checkpoints("harbor")[0]!.facts.operations).toEqual([operation]);
  expect(activity.openRootSpans()).toEqual([]);
  expect(f.db.query("SELECT status, charged_turns FROM inbox_budget_reservations").get()).toEqual({ status: "settled", charged_turns: 1 });
  expect(f.store.getThread("harbor")).toMatchObject({ trustClass: "untrusted", source: "share" });
  const beforeResolution = starts, second = createUiDb(f.path); cleanup.push(() => second.close());
  const request = { type: "inbox_resolve" as const, itemId: f.action.id, optionId: "approve" };
  createInboxResolver(f.db, { allowedOperations: () => [operation] }).resolve(f.principal.id, request);
  createInboxResolver(second, { allowedOperations: () => [operation] }).resolve(f.principal.id, request);
  expect(starts - beforeResolution).toBe(0);
  expect(f.store.snapshot().items.filter(item => item.queue === "queue" && item.type === "execute")).toHaveLength(1);
  expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 1 });
  expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_budget_reservations").get()).toEqual({ n: 1 });
});

test("a refused Action rolls back the checkpoint and leaves the claimed work intact", () => {
  const f = setup(), before = f.store.exportState();
  f.db.exec("CREATE TRIGGER reject_action BEFORE INSERT ON inbox_items WHEN NEW.queue = 'actions' BEGIN SELECT RAISE(ABORT, 'fixture action refusal'); END");
  expect(() => escalateInbox(f.db, { itemId: "share", expectedVersion: 2, escalation: f.escalation, action: f.action, allowedOperations: [operation] })).toThrow("fixture action refusal");
  expect(f.store.checkpoints("harbor")).toEqual([]);
  expect(f.store.exportState()).toEqual(before);
});

test("a backend question commits its choices and checkpoint before unwinding without a live answer promise", async () => {
  const f = setup();
  const questions = [{ header: "Destination", question: "Where should Odysseus's note go?", multiSelect: false,
    options: [{ label: "Harbor", description: "Keep it with the harbor notes" }, { label: "Village", description: "Keep it with the village notes" }] }];
  const action: InboxActionItem = { ...f.action, type: "choose", options: questions[0]!.options.map((option, index) => ({
    id: `choice-${index}`, label: option.label, effect: { kind: "enqueue", payload: { instruction: `Answer the destination question: ${option.label}` } },
  })) };
  let starts = 0;
  const backend: AgentBackend = { id: "fixture", capabilities: { autonomous: true, resume: false, permissions: true, thinking: false, attachments: false, askUser: true, costReporting: false, concurrentSessions: true, followUp: false }, listProfiles: () => [], listSessions: async () => [], getHistory: async () => [], startTurn: async req => {
    starts++;
    await expect(req.bridge.askUser!("destination", questions)).rejects.toThrow("Autonomous work stopped for a durable decision.");
    expect(req.signal.aborted).toBe(true);
    expect(f.store.getItem("share")).toMatchObject({ status: "blocked", blockedByItemId: action.id });
    req.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: "cancelled", isError: false, durationMs: 1, numTurns: 1 });
  } };
  await runAutonomousTurn({ db: f.db, store: createActivityStore(f.db), backend, checkpoint: escalation => {
    escalateInbox(f.db, { itemId: "share", expectedVersion: 2, escalation, action, allowedOperations: [] });
  } }, { turnId: "run", principalId: f.principal.id, prompt: "Choose Odysseus's destination", billingMode: "subscription", allowedTools: [], systemPromptAppend: "Server instructions", signal: new AbortController().signal });
  expect(starts).toBe(1);
  expect(f.store.checkpoints("harbor")[0]!.facts.questions).toEqual([questions[0]!.question]);
  expect(f.store.getItem(action.id)).toMatchObject({ type: "choose", options: action.options });
  expect(action.options).toHaveLength(2);
});

test("two device connections resolve one stored option into one follow-up without starting a provider", () => {
  const f = setup();
  escalateInbox(f.db, { itemId: "share", expectedVersion: 2, escalation: f.escalation, action: f.action, allowedOperations: [operation] });
  const db2 = createUiDb(f.path); cleanup.push(() => db2.close());
  const resolver = createInboxResolver(f.db, { allowedOperations: () => [operation] });
  const other = createInboxResolver(db2, { allowedOperations: () => [operation] });
  const request = { type: "inbox_resolve" as const, itemId: f.action.id, optionId: "approve" };
  const first = resolver.resolve(f.principal.id, request, 1);
  expect(first.followUpId).toBeDefined();
  expect(other.resolve(f.principal.id, request, 1)).toMatchObject({ replay: true, followUpId: first.followUpId });
  expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 1 });
  const executable = f.store.snapshot().items.filter(i => i.queue === "queue" && i.type === "execute");
  expect(executable).toHaveLength(1);
  expect(executable[0]).toMatchObject({ status: "ready", payload: { operation } });
  expect(f.store.getItem("share")).toMatchObject({ status: "superseded" });
  expect(f.store.getItem(f.action.id)).toMatchObject({ status: "resolved" });
  expect(f.db.query("SELECT COUNT(*) AS n FROM activity_spans").get()).toEqual({ n: 0 });
});
