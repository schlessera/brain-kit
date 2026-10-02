import { afterEach, expect, test } from "bun:test";
import type { AgentBackend, BackendBridge, BillingMode, InboxActionItem, InboxOperation } from "@schlessera/brain-ui-sdk/server";
import { BackendRequestError, requestToolPermission, SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/server";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { createActivityStore } from "../src/activity/store.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createInboxBudget, reconcileInboxBudgets } from "../src/inbox/budget.js";
import { runAutonomousTurn } from "../src/inbox/autonomous-turn.js";
import { escalateInbox } from "../src/inbox/escalate.js";
import { createInboxResolver } from "../src/inbox/resolve.js";
import { createInboxCleanup } from "../src/inbox/cleanup.js";
import { createInboxAction, inboxIdentity, sweepInboxLifecycle } from "../src/inbox/actions.js";
import { createInboxRuntime } from "../src/inbox/runtime.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const operation: InboxOperation = { toolName: "write", input: { path: "notes/harbor.md", content: "Odysseus returned." }, targetPath: "notes/harbor.md" };

function setup(billingMode: BillingMode = "subscription") {
  const root = mkdtempSync(join(tmpdir(), "brain-inbox-unwind-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "ui.sqlite"), db = createUiDb(path);
  cleanup.push(() => db.close());
  const now = Date.now(), stagingId = crypto.randomUUID(), staging = join(root, SHARE_STAGING_DIR, stagingId);
  const bytes = Buffer.from("Odysseus's staged harbor notes\n");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "harbor.txt"), bytes);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const store = createInboxStore(db);
  store.ingest({ threadId: "harbor", itemId: "share", dedupKey: "share", source: "share", stagingId, stakes: 2, expiresAt: now + 86_400_000 });
  const budget = createInboxBudget(db, { config: { spendUsd: 5, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 }, pricing: { resolve: () => ({ input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0.01, estimate: false, source: "snapshot" }) } });
  budget.claim("share", { runId: "run", principalId: principal.id, model: "fixture", billingMode, purpose: "execute",
    maximumTokens: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 } }, now + 600_000);
  const action: InboxActionItem = { id: "approve-harbor", dedupKey: "approve-harbor", threadId: "harbor", queue: "actions", type: "approve", status: "pending", version: 1, createdAt: now, updatedAt: now, expiresAt: now + 86_400_000,
    payload: { title: "Write the harbor note?", detail: "Write notes/harbor.md once." }, options: [
      { id: "approve", label: "Write once", effect: { kind: "enqueue", payload: { instruction: "Write the harbor note", operation } } },
      { id: "deny", label: "Cancel", effect: { kind: "cancel_blocked" } },
      { id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } },
    ] };
  return { root, path, db, store, budget, principal, action, staging, stagingId, bytes, billingMode };
}

test("cancellation preserves staging while a real backend is held after denial", async () => {
  const f = setup(), activity = createActivityStore(f.db);
  const second = createUiDb(f.path); cleanup.push(() => second.close());
  const cleaner = createInboxCleanup(second, f.root); cleanup.push(() => cleaner.close());
  let release!: () => void, held!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { held = resolve; });
  let backendAlive = false, denied = false, aborted = false, starts = 0;
  const backend: AgentBackend = { id: "fixture", capabilities: { autonomous: true, resume: false, permissions: true, thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false }, listProfiles: () => [], listSessions: async () => [], getHistory: async () => [], startTurn: async req => {
    starts++;
    backendAlive = true;
    req.bridge.activity!({ kind: "autonomous_identity", runtimeSessionId: "ephemeral", backendId: "fixture" });
    const decision = await requestToolPermission(req.bridge, { toolUseId: "write-harbor", toolName: operation.toolName, input: operation.input }, { noGrantSurface: true });
    denied = decision.behavior === "deny";
    aborted = req.signal.aborted;
    held();
    await gate;
    backendAlive = false;
    req.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: "cancelled", isError: false, durationMs: 1, numTurns: 1 });
  } };
  const turn = runAutonomousTurn({ db: f.db, store: activity, backend, checkpoint: escalation => {
    escalateInbox(f.db, { itemId: "share", expectedVersion: 2, escalation, action: f.action, allowedOperations: [operation] });
  } }, { turnId: "run", principalId: f.principal.id, prompt: "Inspect Odysseus's harbor", billingMode: "subscription", allowedTools: ["read"], systemPromptAppend: "Server instructions", signal: new AbortController().signal });
  try {
    await reached;
    createInboxResolver(second, { allowedOperations: () => [operation] }).resolve(f.principal.id, { type: "inbox_resolve", itemId: f.action.id, optionId: "deny" });
    expect(backendAlive).toBe(true);
    expect(denied).toBe(true);
    expect(aborted).toBe(true);
    expect(activity.openRootSpans()).toHaveLength(1);
    expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_budget_reservations WHERE status = 'active'").get()).toEqual({ n: 1 });
    expect(readFileSync(join(f.staging, "harbor.txt"))).toEqual(f.bytes);
    expect(f.bytes.length).toBeGreaterThan(0);
    const swept = await cleaner.sweep();
    expect(swept).toBe(0);
    expect(readFileSync(join(f.staging, "harbor.txt"))).toEqual(f.bytes);
  } finally { release(); await turn; }
  expect(backendAlive).toBe(false);
  expect(activity.openRootSpans()).toHaveLength(0);
  expect(f.db.query("SELECT status, charged_turns FROM inbox_budget_reservations").get()).toEqual({ status: "settled", charged_turns: 1 });
  sweepInboxLifecycle(second);
  expect(await cleaner.sweep()).toBe(1);
  expect(existsSync(f.staging)).toBe(false);
  expect(await cleaner.sweep()).toBe(0);
  expect(starts).toBe(1);
  expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 1 });
  expect(f.store.getThread("harbor")).toMatchObject({ trustClass: "untrusted", source: "share" });
});

function holdBackend(f: ReturnType<typeof setup>, cap?: number) {
  const activity = createActivityStore(f.db);
  let release!: () => void, held!: () => void, bridge!: BackendBridge;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { held = resolve; });
  let alive = false, starts = 0, denied = false, aborted = false;
  const completed = { toolName: "prepare_staging", input: { stagingId: f.stagingId } };
  const backend: AgentBackend = { id: "fixture", capabilities: { autonomous: true, resume: false, permissions: true, thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false }, listProfiles: () => [], listSessions: async () => [], getHistory: async () => [], startTurn: async req => {
    bridge = req.bridge;
    alive = true; starts++;
    bridge.activity!({ kind: "autonomous_identity", runtimeSessionId: "ephemeral", backendId: "fixture" });
    writeFileSync(join(f.staging, "prepared.txt"), "Prepared harbor staging.");
    bridge.emit({ type: "tool_use_complete", toolUseId: "prepare", ...completed });
    bridge.emit({ type: "tool_result", toolUseId: "prepare", output: "Prepared", isError: false });
    const decision = await requestToolPermission(bridge, { toolUseId: "write-harbor", toolName: operation.toolName, input: operation.input }, { noGrantSurface: true });
    denied = decision.behavior === "deny"; aborted = req.signal.aborted;
    held(); await gate;
    alive = false;
    bridge.emit({ type: "result", sessionId: "ephemeral", outcome: "cancelled", isError: false, durationMs: 1, numTurns: 1 });
  } };
  const turn = runAutonomousTurn({ db: f.db, store: activity, backend, checkpoint: escalation => {
    escalateInbox(f.db, { itemId: "share", expectedVersion: 2, escalation, action: f.action, allowedOperations: [operation], cap });
  } }, { turnId: "run", principalId: f.principal.id, prompt: "Inspect Odysseus's harbor", billingMode: f.billingMode, allowedTools: ["read"], systemPromptAppend: "Server instructions", signal: new AbortController().signal });
  return { reached, activity, turn, completed, bridge: () => bridge,
    controls: () => ({ alive, starts, denied, aborted }), finish: async () => { release(); await turn; } };
}

function urgentAction(f: ReturnType<typeof setup>, db = f.db) {
  f.store.ingest({ threadId: "urgent", itemId: "urgent-share", dedupKey: "urgent-share", source: "share", stagingId: crypto.randomUUID(), stakes: 3, expiresAt: Date.now() + 86_400_000 });
  const action = { ...f.action, id: "urgent-action", dedupKey: "urgent-action", threadId: "urgent", options: f.action.options.filter(option => option.effect.kind !== "enqueue") };
  createInboxAction(db, action, [], { cap: 1 });
}

for (const retirement of ["dismissal", "expiry", "cap eviction", "incoming cap eviction"] as const) {
  test(`${retirement} defers cleanup admission through backend unwind and settles once`, async () => {
    const f = setup(), second = createUiDb(f.path); cleanup.push(() => second.close());
    const cleaner = createInboxCleanup(second, f.root); cleanup.push(() => cleaner.close());
    if (retirement === "incoming cap eviction") urgentAction(f);
    const running = holdBackend(f, retirement === "incoming cap eviction" ? 1 : undefined);
    try {
      await running.reached;
      if (retirement === "dismissal") createInboxResolver(second, { allowedOperations: () => [operation] }).resolve(f.principal.id, { type: "inbox_resolve", itemId: f.action.id, optionId: "dismiss" });
      else if (retirement === "expiry") sweepInboxLifecycle(second, f.action.expiresAt + 1);
      else if (retirement === "cap eviction") urgentAction(f, second);
      expect(running.controls()).toEqual({ alive: true, starts: 1, denied: true, aborted: true });
      expect(running.activity.openRootSpans()).toHaveLength(1);
      expect(f.db.query("SELECT status FROM inbox_budget_reservations WHERE run_id = 'run'").get()).toEqual({ status: "active" });
      expect(f.store.getItem("share")).toMatchObject({ status: "superseded" });
      expect(readFileSync(join(f.staging, "harbor.txt"))).toEqual(f.bytes);
      expect(f.store.snapshot().items.filter(i => i.type === "cleanup_pending" && i.threadId === "harbor")).toHaveLength(0);
      expect(await cleaner.sweep()).toBe(0);
      expect(readFileSync(join(f.staging, "harbor.txt"))).toEqual(f.bytes);
      expect(f.store.checkpoints("harbor")[0]!.facts.operations).toEqual([operation]);
      expect(operation.input).not.toEqual({});
    } finally { await running.finish(); }
    expect(f.db.query("SELECT status, charged_turns FROM inbox_budget_reservations WHERE run_id = 'run'").get()).toEqual({ status: "settled", charged_turns: 1 });
    const receipts = f.db.query("SELECT tool_name, input_json FROM inbox_completed_tool_calls WHERE item_id = 'share'").all();
    expect(receipts).toEqual([{ tool_name: running.completed.toolName, input_json: JSON.stringify(running.completed.input) }]);
    sweepInboxLifecycle(second);
    expect(await cleaner.sweep()).toBe(1);
    expect(await cleaner.sweep()).toBe(0);
    expect(existsSync(f.staging)).toBe(false);
    expect(f.db.query("SELECT tool_name, input_json FROM inbox_completed_tool_calls WHERE item_id = 'share'").all()).toEqual(receipts);
    expect(f.store.getThread("harbor")).toMatchObject({ trustClass: "untrusted", source: "share" });
    expect(running.controls().starts).toBe(1);
  });
}

test("a pre-existing compensation journal cannot be claimed while the backend is live", async () => {
  const f = setup(), running = holdBackend(f);
  const second = createUiDb(f.path); cleanup.push(() => second.close());
  const cleaner = createInboxCleanup(second, f.root); cleanup.push(() => cleaner.close());
  try {
    await running.reached;
    createInboxResolver(second, { allowedOperations: () => [operation] }).resolve(f.principal.id, { type: "inbox_resolve", itemId: f.action.id, optionId: "deny" });
    const now = Date.now(), id = inboxIdentity("cleanup", f.stagingId);
    createInboxStore(second).commit([{ kind: "item", item: { id, dedupKey: id, threadId: "harbor", queue: "queue", type: "cleanup_pending", status: "ready", attempts: 0, maxAttempts: 3, version: 1, createdAt: now, updatedAt: now, expiresAt: Number.MAX_SAFE_INTEGER, payload: { stagingId: f.stagingId } } }]);
    expect(running.controls().alive).toBe(true);
    expect(readFileSync(join(f.staging, "harbor.txt"))).toEqual(f.bytes);
    expect(await cleaner.sweep()).toBe(0);
    expect(f.store.getItem(id)).toMatchObject({ status: "ready", attempts: 0 });
  } finally { await running.finish(); }
  expect(await cleaner.sweep()).toBe(1);
  expect(await cleaner.sweep()).toBe(0);
});

test("budget recovery and terminal observations cannot settle a still-unwinding API attempt", async () => {
  const f = setup("api"), running = holdBackend(f);
  const second = createUiDb(f.path); cleanup.push(() => second.close());
  const cleaner = createInboxCleanup(second, f.root); cleanup.push(() => cleaner.close());
  try {
    await running.reached;
    createInboxResolver(second, { allowedOperations: () => [operation] }).resolve(f.principal.id, { type: "inbox_resolve", itemId: f.action.id, optionId: "deny" });
    expect(running.controls().alive).toBe(true);
    expect(running.activity.openRootSpans()).toHaveLength(1);
    expect(f.budget.recover()).toBe(0);
    expect(f.db.query("SELECT status, reserved_cost_usd FROM inbox_budget_reservations WHERE run_id = 'run'").get()).toEqual({ status: "active", reserved_cost_usd: 2 });
    running.bridge().emit({ type: "result", sessionId: "ephemeral", outcome: "cancelled", isError: false, durationMs: 1, numTurns: 1, costUsd: 0.3,
      usage: { inputTokens: 30, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, perModel: { fixture: { inputTokens: 30, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.3 } } } });
    expect(running.controls().alive).toBe(true);
    expect(f.db.query("SELECT status FROM inbox_budget_reservations WHERE run_id = 'run'").get()).toEqual({ status: "active" });
    expect(f.budget.settle("run", "released")).toBe(false);
    sweepInboxLifecycle(second);
    expect(await cleaner.sweep()).toBe(0);
    expect(readFileSync(join(f.staging, "harbor.txt"))).toEqual(f.bytes);
  } finally { await running.finish(); }
  expect(f.db.query("SELECT status, charged_cost_usd, charged_turns FROM inbox_budget_reservations WHERE run_id = 'run'").get()).toEqual({ status: "settled", charged_cost_usd: 0.3, charged_turns: 1 });
  sweepInboxLifecycle(second);
  expect(await cleaner.sweep()).toBe(1);
});

test("a prematurely released receipt does not masquerade as backend unwind", async () => {
  const f = setup(), running = holdBackend(f);
  const second = createUiDb(f.path); cleanup.push(() => second.close());
  const cleaner = createInboxCleanup(second, f.root); cleanup.push(() => cleaner.close());
  try {
    await running.reached;
    // Model the previously possible premature recovery independently of the
    // repaired settlement guard. The kernel lifetime must still protect bytes.
    f.db.query("UPDATE inbox_budget_reservations SET status = 'released', charged_cost_usd = 0, charged_turns = 1, settled_at = ? WHERE run_id = 'run'").run(Date.now());
    expect(f.db.query("SELECT status FROM inbox_budget_reservations WHERE run_id = 'run'").get()).toEqual({ status: "released" });
    expect(running.controls().alive).toBe(true);
    createInboxResolver(second, { allowedOperations: () => [operation] }).resolve(f.principal.id, { type: "inbox_resolve", itemId: f.action.id, optionId: "deny" });
    expect(await cleaner.sweep()).toBe(0);
    expect(readFileSync(join(f.staging, "harbor.txt"))).toEqual(f.bytes);
    expect(f.store.snapshot().items.filter(i => i.type === "cleanup_pending")).toHaveLength(0);
  } finally { await running.finish(); }
  sweepInboxLifecycle(second);
  expect(await cleaner.sweep()).toBe(1);
});

test("a refused duplicate start preserves the live owner's kernel file and admission", async () => {
  const f = setup(), running = holdBackend(f);
  try {
    await running.reached;
    const directory = `${f.path}.inbox-live`, names = readdirSync(directory);
    expect(names).toHaveLength(1);
    const file = join(directory, names[0]!), inode = lstatSync(file).ino;
    const duplicate = holdBackend(f);
    await expect(duplicate.turn).rejects.toBeInstanceOf(BackendRequestError);
    expect(duplicate.controls().starts).toBe(0);
    expect(running.controls().alive).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(lstatSync(file).ino).toBe(inode);
    expect(f.budget.recover()).toBe(0);
    expect(f.db.query("SELECT status FROM inbox_budget_reservations WHERE run_id = 'run'").get()).toEqual({ status: "active" });
    expect(readFileSync(join(f.staging, "harbor.txt"))).toEqual(f.bytes);
  } finally { await running.finish(); }
});

test("expired Queue leases do not recover an actually running backend", async () => {
  const f = setup(), activity = createActivityStore(f.db);
  let held!: () => void, release!: () => void;
  const reached = new Promise<void>(r => { held = r; }), gate = new Promise<void>(r => { release = r; });
  const backend: AgentBackend = { id: "fixture", capabilities: { autonomous: true, resume: false, permissions: true, thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false }, listProfiles: () => [], listSessions: async () => [], getHistory: async () => [], startTurn: async req => {
    req.bridge.activity!({ kind: "autonomous_identity", runtimeSessionId: "ephemeral", backendId: "fixture" });
    held(); await gate;
    req.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  } };
  const turn = runAutonomousTurn({ db: f.db, store: activity, backend, checkpoint: () => {} }, { turnId: "run", principalId: f.principal.id, prompt: "Inspect Odysseus's harbor", billingMode: "subscription", allowedTools: [], systemPromptAppend: "Server instructions", signal: new AbortController().signal });
  let runtime: ReturnType<typeof createInboxRuntime> | undefined;
  try {
    await reached;
    const before = f.store.getItem("share");
    expect(activity.openRootSpans()).toHaveLength(1);
    runtime = createInboxRuntime(f.db, { now: () => Date.now() + 700_000, log: { emit() {}, enabled: () => false } });
    expect(f.store.getItem("share")?.status).toBe("claimed");
    expect(f.store.getItem("share")).toEqual(before);
    expect((await runtime.tick()).recovered).toBe(0);
    expect(f.db.query("SELECT status FROM inbox_budget_reservations WHERE run_id = 'run'").get()).toEqual({ status: "active" });
  } finally { release(); await turn; await runtime?.close(); }
});

async function spawnHeldWorker(f: ReturnType<typeof setup>, mode: "escalated" | "claimed") {
  const fixture = join(f.root, "worker.json"), ready = join(f.root, "worker-ready.json");
  writeFileSync(fixture, JSON.stringify({ principalId: f.principal.id, action: f.action, operation, stagingId: f.stagingId }));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/inbox-unwind-worker.ts"), f.path, fixture, ready, mode], { stdout: "pipe", stderr: "pipe" });
  cleanup.push(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; });
  const deadline = Date.now() + 5000;
  while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(5);
  if (!existsSync(ready)) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    throw new Error(`Unwind worker did not become ready: ${await new Response(child.stderr).text()}`);
  }
  expect(child.exitCode).toBeNull();
  expect(JSON.parse(readFileSync(ready, "utf8"))).toEqual({ denied: mode === "escalated", aborted: mode === "escalated" });
  expect(createActivityStore(f.db).openRootSpans()).toHaveLength(1);
  expect(f.db.query("SELECT status, reserved_cost_usd FROM inbox_budget_reservations WHERE run_id = 'run'").get()).toEqual({ status: "active", reserved_cost_usd: 2 });
  expect(f.db.query("SELECT cost_usd FROM activity_spans WHERE run_id = 'run' AND parent_span_id IS NULL").get()).toEqual({ cost_usd: 3 });
  expect(readFileSync(join(f.staging, "harbor.txt"))).toEqual(f.bytes);
  return child;
}

test("SIGKILL during denial unwind releases kernel life and recovers cost before one cleanup", async () => {
  const f = setup("api"), child = await spawnHeldWorker(f, "escalated");
  const second = createUiDb(f.path); cleanup.push(() => second.close());
  const cleaner = createInboxCleanup(second, f.root); cleanup.push(() => cleaner.close());
  createInboxResolver(second, { allowedOperations: () => [operation] }).resolve(f.principal.id, { type: "inbox_resolve", itemId: f.action.id, optionId: "deny" });
  expect(child.exitCode).toBeNull();
  expect(reconcileInboxBudgets(second)).toBe(0);
  expect(await cleaner.sweep()).toBe(0);
  expect(readFileSync(join(f.staging, "harbor.txt"))).toEqual(f.bytes);
  child.kill("SIGKILL");
  expect(await child.exited).toBe(137);
  expect(readdirSync(`${f.path}.inbox-live`)).toHaveLength(1);
  expect(createActivityStore(second).openRootSpans()).toHaveLength(1);

  const reopened = createUiDb(f.path); cleanup.push(() => reopened.close());
  const resumed = createInboxCleanup(reopened, f.root); cleanup.push(() => resumed.close());
  expect(reconcileInboxBudgets(reopened)).toBe(1);
  expect(reopened.query("SELECT status, observed_cost_usd, charged_cost_usd, charged_turns FROM inbox_budget_reservations WHERE run_id = 'run'").get()).toEqual({ status: "released", observed_cost_usd: null, charged_cost_usd: 3, charged_turns: 1 });
  sweepInboxLifecycle(reopened);
  expect(await resumed.sweep()).toBe(1);
  expect(await resumed.sweep()).toBe(0);
  expect(reconcileInboxBudgets(reopened)).toBe(0);
  expect(existsSync(f.staging)).toBe(false);
  expect(reopened.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 1 });
  expect(readdirSync(`${f.path}.inbox-live`)).toHaveLength(0);
  expect(f.store.snapshot().items.filter(i => i.type === "cleanup_pending")).toHaveLength(1);
  expect(f.store.getThread("harbor")).toMatchObject({ trustClass: "untrusted", source: "share" });
  expect(await new Response(child.stdout).text()).toBe("");
  expect(await new Response(child.stderr).text()).toBe("");
});

test("SIGKILL before checkpoint recovers the expired claim without resetting attempts or spend", async () => {
  const f = setup("api"), child = await spawnHeldWorker(f, "claimed");
  const second = createUiDb(f.path); cleanup.push(() => second.close());
  const now = Date.now() + 700_000;
  const liveRuntime = createInboxRuntime(second, { now: () => now, brainRoot: f.root, log: { emit() {}, enabled: () => false } });
  cleanup.push(() => liveRuntime.close());
  await liveRuntime.ready;
  expect(f.store.getItem("share")).toMatchObject({ status: "claimed", attempts: 1 });
  expect((await liveRuntime.tick()).recovered).toBe(0);
  expect(readFileSync(join(f.staging, "harbor.txt"))).toEqual(f.bytes);
  child.kill("SIGKILL");
  expect(await child.exited).toBe(137);
  await liveRuntime.close();
  const reopened = createUiDb(f.path); cleanup.push(() => reopened.close());
  const recovered = createInboxRuntime(reopened, { now: () => now, brainRoot: f.root, log: { emit() {}, enabled: () => false } });
  cleanup.push(() => recovered.close());
  await recovered.ready;
  expect(createInboxStore(reopened).getItem("share")).toMatchObject({ status: "ready", attempts: 1, waitUntil: now + 60_000 });
  expect(reopened.query("SELECT status, charged_cost_usd, charged_turns FROM inbox_budget_reservations WHERE run_id = 'run'").get()).toEqual({ status: "released", charged_cost_usd: 3, charged_turns: 1 });
  expect(readFileSync(join(f.staging, "harbor.txt"))).toEqual(f.bytes);
  sweepInboxLifecycle(reopened, now + 86_400_000);
  const cleaner = createInboxCleanup(reopened, f.root, { now: () => now + 86_400_000 }); cleanup.push(() => cleaner.close());
  expect(await cleaner.sweep()).toBe(1);
  expect(await cleaner.sweep()).toBe(0);
  expect(existsSync(f.staging)).toBe(false);
  expect(readdirSync(`${f.path}.inbox-live`)).toHaveLength(0);
  expect((await recovered.tick()).claimed).toBe(0);
  expect(reopened.query("SELECT COUNT(*) AS n FROM inbox_budget_reservations").get()).toEqual({ n: 1 });
  expect(await new Response(child.stdout).text()).toBe("");
  expect(await new Response(child.stderr).text()).toBe("");
});
