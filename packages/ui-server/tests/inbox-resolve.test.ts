import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxActionItem, InboxOperation } from "@schlessera/brain-ui-sdk/protocol";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createInboxBudget } from "../src/inbox/budget.js";
import { escalateInbox } from "../src/inbox/escalate.js";
import { createInboxResolver, inboxSnoozeUntil } from "../src/inbox/resolve.js";
import { createInboxAction, failInboxWork, inboxIdentity, sweepInboxLifecycle } from "../src/inbox/actions.js";
import { createInboxCleanup } from "../src/inbox/cleanup.js";
import { finishYield, recordCompletedCall } from "../src/inbox/yield.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const operation: InboxOperation = { toolName: "write", input: { path: "notes/harbor.md", content: "Odysseus returned." }, targetPath: "notes/harbor.md" };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "brain-action-lifecycle-")), path = join(dir, "ui.sqlite");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = createUiDb(path); cleanup.push(() => db.close());
  let now = Date.UTC(2026, 9, 2, 22);
  const store = createInboxStore(db, { now: () => now });
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 86400 });
  // The principal's durable clock must cover this deterministic fixture date.
  db.query("UPDATE principals SET created_at = ?, expires_at = ? WHERE id = ?").run(now - 1, now + 60 * 86_400_000, principal.id);
  const budget = createInboxBudget(db, { now: () => now, config: { spendUsd: 5, turns: 200, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 }, pricing: { resolve: () => null } });
  function seed(id = "harbor", stakes = 1, withOperation = true) {
    const stagingId = crypto.randomUUID();
    store.ingest({ threadId: id, itemId: `work-${id}`, dedupKey: `work-${id}`, source: "share", stagingId, stakes, expiresAt: now + 30 * 86_400_000 });
    const runId = `run-${id}`;
    expect(budget.claim(`work-${id}`, { runId, principalId: principal.id, model: "fixture", billingMode: "subscription", purpose: "execute" }, now + 600_000)).not.toBeNull();
    const action: InboxActionItem = { id: `action-${id}`, dedupKey: `action-${id}`, threadId: id, queue: "actions", type: "approve", status: "pending", version: 1, createdAt: now, updatedAt: now, expiresAt: now + 30 * 86_400_000,
      payload: { title: "Write Odysseus's note?", detail: "An exact proposed operation." }, options: [
        { id: "approve", label: "Write once", effect: { kind: "enqueue", payload: { instruction: "Write the note", ...(withOperation ? { operation } : {}) } } },
        { id: "deny", label: "Cancel", effect: { kind: "cancel_blocked" } },
        { id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } },
        { id: "later", label: "Later", effect: { kind: "snooze" } },
      ] };
    const escalation = { kind: "permission" as const, runId, principalId: principal.id, stateMd: "Odysseus inspected the harbor.", request: { toolUseId: `tool-${id}`, toolName: operation.toolName, input: operation.input } };
    return { action, escalation, stagingId, itemId: `work-${id}`, expectedVersion: 2, allowedOperations: [operation], now };
  }
  let allowed = [operation];
  const resolver = createInboxResolver(db, { now: () => now, allowedOperations: () => allowed });
  return { db, path, dir, store, principal, budget, resolver, seed, at: () => now,
    advance: (ms: number) => { now += ms; }, restrict: () => { allowed = []; } };
}
function request(id: string, optionId = "approve") { return { type: "inbox_resolve" as const, itemId: id, optionId }; }

test("creation and replay accept semantically identical operation input and option key ordering", () => {
  const f = setup(), input = f.seed();
  input.action.options = input.action.options.map(({ id, label, effect }) => ({ effect, label, id }));
  input.escalation.request.input = { content: operation.input.content as string, path: operation.input.path as string };
  escalateInbox(f.db, input);
  expect(f.store.getItem(input.action.id)).toMatchObject({ status: "pending" });
  expect(f.store.checkpoints("harbor")[0]!.facts.operations).toHaveLength(1);
  let result: ReturnType<typeof f.resolver.resolve> | undefined;
  expect(() => { result = f.resolver.resolve(f.principal.id, request(input.action.id)); }).not.toThrow();
  expect(result?.followUpId).toBeDefined();
  expect(f.resolver.resolve(f.principal.id, request(input.action.id))).toMatchObject({ replay: true, followUpId: result!.followUpId });
});

test("fresh principal and exact input/target authority gate the actual resolution transaction", () => {
  const f = setup(), input = f.seed(); escalateInbox(f.db, input);
  f.restrict();
  expect(() => f.resolver.resolve(f.principal.id, request(input.action.id))).toThrow("outside the thread envelope");
  expect(f.store.getItem(input.itemId)).toMatchObject({ status: "blocked" });
  expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 0 });
  const wrongTarget = createInboxResolver(f.db, { now: f.at, allowedOperations: () => [{ ...operation, targetPath: "notes/another.md" }] });
  expect(() => wrongTarget.resolve(f.principal.id, request(input.action.id))).toThrow("outside the thread envelope");
  revokePrincipal(f.db, f.principal.id, f.at());
  expect(() => f.resolver.resolve(f.principal.id, request(input.action.id, "dismiss"))).toThrow("principal is no longer usable");
  expect(f.store.getItem(input.action.id)).toMatchObject({ status: "pending" });
});

test("apply validates raw stored authority fields, deferred kinds and frozen options", () => {
  for (const effect of [{ kind: "enqueue", payload: { instruction: "Write", operation: { ...operation, input: { ...operation.input, profileId: "wide" } } } }, { kind: "write_policy", policy: { slug: "harbor", content: "Permit writes" } }, { kind: "open_session", seed: { prompt: "Discuss" } }]) {
    const f = setup(), input = f.seed(); escalateInbox(f.db, input);
    const raw = { ...input.action, options: [{ ...input.action.options[0]!, effect }] };
    f.db.query("UPDATE inbox_items SET data_json = ? WHERE id = ?").run(JSON.stringify(raw), input.action.id);
    expect(() => f.resolver.resolve(f.principal.id, request(input.action.id))).toThrow(effect.kind === "enqueue" ? "authority-free JSON input" : "Invalid or unavailable");
    expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 0 });
    expect(f.store.getItem(input.itemId)).toMatchObject({ status: "blocked" });
  }
  const f = setup(), input = f.seed(); escalateInbox(f.db, input);
  f.db.query("UPDATE inbox_items SET data_json = ? WHERE id = ?").run(JSON.stringify({ ...input.action, options: [{ id: "approve", label: "Changed", effect: { kind: "cancel_blocked" } }] }), input.action.id);
  expect(() => f.resolver.resolve(f.principal.id, request(input.action.id))).toThrow("Stored Action options changed");
});

test("failed follow-up insertion rolls back resolution, supersede, Action and every change", () => {
  const f = setup(), input = f.seed(); escalateInbox(f.db, input);
  const before = f.store.exportState();
  f.db.exec("CREATE TRIGGER refuse_followup BEFORE INSERT ON inbox_items WHEN NEW.type = 'execute' BEGIN SELECT RAISE(ABORT, 'fixture followup refusal'); END");
  expect(() => f.resolver.resolve(f.principal.id, request(input.action.id))).toThrow("fixture followup refusal");
  expect(f.store.exportState()).toEqual(before);
  expect(f.store.getItem(input.itemId)).toMatchObject({ status: "blocked" });
});

test("stale versions and another option cannot overwrite a winning resolution", () => {
  const f = setup(), input = f.seed(); escalateInbox(f.db, input);
  expect(() => f.resolver.resolve(f.principal.id, request(input.action.id), 2)).toThrow("version conflict");
  f.resolver.resolve(f.principal.id, request(input.action.id), 1);
  expect(() => f.resolver.resolve(f.principal.id, request(input.action.id, "deny"))).toThrow("already resolved differently");
  expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 1 });
});

test("dismissal with no reason or each feedback reason grants nothing and journals cleanup once", () => {
  for (const reason of [undefined, "dont_ask_again", "wrong_call", "need_more_info", "no_longer_relevant"] as const) {
    const f = setup(), input = f.seed(); escalateInbox(f.db, input);
    const msg = { ...request(input.action.id, "dismiss"), ...(reason ? { reason } : {}) };
    expect(f.resolver.resolve(f.principal.id, msg).followUpId).toBeUndefined();
    expect(f.resolver.resolve(f.principal.id, msg).replay).toBe(true);
    expect(f.store.getItem(input.itemId)).toMatchObject({ status: "superseded" });
    expect(f.store.snapshot().items.filter(item => item.queue === "queue" && item.type === "execute")).toEqual([]);
    expect(f.store.snapshot().items.filter(item => item.queue === "queue" && item.type === "cleanup_pending")).toHaveLength(1);
    expect(f.store.exportState().inbox_resolutions[0]).toMatchObject({ reason: reason ?? null, principal_id: f.principal.id });
    expect(f.store.exportState().inbox_checkpoints[0]).toBeDefined();
    expect(f.store.getThread("harbor")).toMatchObject({ trustClass: "untrusted", source: "share" });
  }
});

test("Later at 22:00 resurfaces next weekday at 08:00, retains the block and still permits one later resolution", () => {
  const f = setup(), input = f.seed(); input.action.expiresAt = f.at() + 60_000; escalateInbox(f.db, input);
  const source = f.store.getItem(input.itemId)!;
  f.db.query("UPDATE inbox_items SET data_json = ?, expires_at = ? WHERE id = ?")
    .run(JSON.stringify({ ...source, expiresAt: f.at() + 60_000 }), f.at() + 60_000, source.id);
  f.resolver.resolve(f.principal.id, request(input.action.id, "later"));
  const due = Date.UTC(2026, 9, 5, 8);
  expect(f.store.getItem(input.action.id)).toMatchObject({ status: "snoozed", waitUntil: due, expiresAt: due + 86_400_000 });
  expect(f.store.getItem(input.itemId)).toMatchObject({ status: "blocked", expiresAt: due + 86_400_000 });
  expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 0 });
  f.advance(due - f.at() - 1); sweepInboxLifecycle(f.db, f.at());
  expect(f.store.getItem(input.action.id)).toMatchObject({ status: "snoozed" });
  f.advance(1); sweepInboxLifecycle(f.db, f.at());
  expect(f.store.getItem(input.action.id)).toMatchObject({ status: "pending" });
  expect(f.store.getItem(input.action.id)).not.toHaveProperty("waitUntil");
  f.resolver.resolve(f.principal.id, request(input.action.id));
  expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 1 });
  expect(inboxSnoozeUntil(Date.UTC(2026, 9, 23, 20), 1, 1, "Europe/Berlin")).toBe(Date.UTC(2026, 9, 26, 7));
});

test("all 60 existing decisions block work: the lowest loses its block and journals compensation with one FYI", () => {
  const f = setup();
  for (let n = 0; n < 60; n++) {
    const input = f.seed(String(n).padStart(2, "0"), 1);
    escalateInbox(f.db, input);
    // A waiting decision retains work, not an active inference slot. The
    // backend test proves terminal settlement; this fixture releases its
    // unused reservation conservatively before the next synthetic admission.
    expect(f.budget.settle(input.escalation.runId, "released")).toBe(true);
  }
  const incoming = f.seed("urgent", 3); escalateInbox(f.db, incoming);
  const items = f.store.snapshot().items;
  expect(items.filter(item => item.queue === "actions" && item.type !== "fyi" && ["pending", "snoozed"].includes(item.status))).toHaveLength(60);
  expect(items.filter(item => item.queue === "actions" && item.type === "fyi")).toHaveLength(1);
  expect(f.store.getItem("action-00")).toMatchObject({ status: "dropped" });
  expect(f.store.getItem("work-00")).toMatchObject({ status: "superseded" });
  expect(f.store.getItem(incoming.action.id)).toMatchObject({ status: "pending" });
  expect(items.filter(item => item.queue === "queue" && item.type === "cleanup_pending")).toHaveLength(1);
  expect(f.store.exportState().inbox_suppressions).toHaveLength(1);
  sweepInboxLifecycle(f.db, f.at());
  expect(f.store.snapshot().items.filter(item => item.queue === "actions" && item.type === "fyi")).toHaveLength(1);
});

test("incoming lowest candidate can lose atomically; a FYI never consumes or evicts a decision slot", () => {
  const f = setup(), existing = f.seed("urgent", 3); escalateInbox(f.db, { ...existing, cap: 1 });
  const incoming = f.seed("low", 1); escalateInbox(f.db, { ...incoming, cap: 1 });
  expect(f.store.getItem(incoming.action.id)).toMatchObject({ status: "dropped" });
  expect(f.store.getItem(incoming.itemId)).toMatchObject({ status: "superseded" });
  expect(f.store.checkpoints("low")).toHaveLength(1);
  const fyi = { ...incoming.action, id: "fyi", dedupKey: "fyi", type: "fyi" as const, options: [] };
  createInboxAction(f.db, fyi, [], { now: f.at(), cap: 1 });
  expect(f.store.getItem(existing.action.id)).toMatchObject({ status: "pending" });
  expect(f.store.getItem("fyi")).toMatchObject({ status: "pending" });
});

test("expiry emits one FYI and suppression; changed evidence or expiry permits re-raise", () => {
  const f = setup(), input = f.seed(); input.action.expiresAt = f.at() + 1; escalateInbox(f.db, input);
  f.advance(1); sweepInboxLifecycle(f.db, f.at()); sweepInboxLifecycle(f.db, f.at());
  expect(f.store.getItem(input.itemId)).toMatchObject({ status: "superseded" });
  expect(f.store.snapshot().items.filter(item => item.queue === "actions" && item.type === "fyi")).toHaveLength(1);
  const context = { classKey: inboxIdentity("action", input.action.dedupKey), evidenceBoundary: input.action.dedupKey, suppressionUntil: f.at() + 86_400_000, reraiseCondition: "New evidence or expiry" };
  const newAction = { ...input.action, id: "new-action", dedupKey: "new-action", expiresAt: f.at() + 86_400_000 };
  expect(createInboxAction(f.db, newAction, [operation], { now: f.at(), context })).toBe(false);
  expect(createInboxAction(f.db, newAction, [operation], { now: f.at(), context: { ...context, evidenceBoundary: "new evidence" } })).toBe(true);
  f.advance(86_400_000);
  expect(createInboxAction(f.db, { ...newAction, id: "expiry-action", dedupKey: "expiry-action", expiresAt: f.at() + 86_400_000 }, [operation], { now: f.at(), context })).toBe(true);
});

test("bounded failed attempts back off and finish in exactly one dead-letter Action", () => {
  const f = setup(), input = f.seed();
  for (let n = 1; n <= 3; n++) {
    const item = f.store.getItem(input.itemId)!;
    expect(item).toMatchObject({ status: "claimed", attempts: n });
    failInboxWork(f.db, item.id, item.version, f.at());
    const after = f.store.getItem(item.id)!;
    if (n < 3) {
      expect(after).toMatchObject({ status: "ready", waitUntil: f.at() + 60_000 * 2 ** (n - 1) });
      expect(f.store.snapshot().items.filter(item => item.queue === "actions" && item.type !== "fyi")).toEqual([]);
      f.advance(60_000 * 2 ** (n - 1));
      f.budget.recover();
      f.budget.claim(item.id, { runId: `retry-${n}`, principalId: f.principal.id, model: "fixture", billingMode: "subscription", purpose: "retry" }, f.at() + 600_000);
    } else expect(after).toMatchObject({ status: "failed", attempts: 3 });
  }
  sweepInboxLifecycle(f.db, f.at()); sweepInboxLifecycle(f.db, f.at());
  const actions = f.store.snapshot().items.filter(item => item.queue === "actions" && item.type !== "fyi");
  expect(actions).toHaveLength(1);
  f.resolver.resolve(f.principal.id, request(actions[0]!.id, "dismiss"));
  expect(f.store.getItem(input.itemId)).toMatchObject({ status: "dropped" });
  expect(f.store.snapshot().items.filter(item => item.queue === "queue" && item.type === "cleanup_pending")).toHaveLength(1);
});

test("cleanup retries after removed files but failed acknowledgement, preserving unrelated content", async () => {
  const f = setup(), input = f.seed(); escalateInbox(f.db, input);
  const staged = join(f.dir, SHARE_STAGING_DIR, input.stagingId), partial = join(f.dir, SHARE_STAGING_DIR, `.${input.stagingId}.partial`);
  mkdirSync(staged, { recursive: true }); mkdirSync(partial); writeFileSync(join(staged, "share.txt"), "Odysseus fixture");
  writeFileSync(join(f.dir, "keep.md"), "Keep Odysseus's note");
  f.resolver.resolve(f.principal.id, request(input.action.id, "deny"));
  expect(existsSync(staged)).toBe(true);
  const cleaner = createInboxCleanup(f.db, f.dir, { now: f.at }); cleanup.push(() => cleaner.close());
  f.db.exec("CREATE TRIGGER refuse_cleanup_ack BEFORE UPDATE ON inbox_items WHEN NEW.type = 'cleanup_pending' AND NEW.status = 'done' BEGIN SELECT RAISE(ABORT, 'fixture ack failure'); END");
  expect(await cleaner.sweep()).toBe(0);
  expect(existsSync(staged)).toBe(false); expect(existsSync(partial)).toBe(false);
  f.db.exec("DROP TRIGGER refuse_cleanup_ack"); f.advance(60_000);
  expect(await cleaner.sweep()).toBe(1); expect(await cleaner.sweep()).toBe(0);
  expect(f.store.getItem(inboxIdentity("cleanup", input.stagingId))).toMatchObject({ status: "done", attempts: 2 });
  expect(readFileSync(join(f.dir, "keep.md"), "utf8")).toBe("Keep Odysseus's note");
});

test("cleanup refuses an internal staging-root symlink and keeps its target untouched", async () => {
  const f = setup(), input = f.seed(); escalateInbox(f.db, input);
  const unrelated = join(f.dir, "unrelated"); mkdirSync(join(unrelated, input.stagingId), { recursive: true });
  const keep = join(unrelated, input.stagingId, "keep.md"); writeFileSync(keep, "Odysseus fixture");
  const stagingRoot = join(f.dir, SHARE_STAGING_DIR); mkdirSync(join(stagingRoot, ".."), { recursive: true }); symlinkSync(unrelated, stagingRoot);
  f.resolver.resolve(f.principal.id, request(input.action.id, "deny"));
  const cleaner = createInboxCleanup(f.db, f.dir, { now: f.at }); cleanup.push(() => cleaner.close());
  expect(await cleaner.sweep()).toBe(0);
  expect(readFileSync(keep, "utf8")).toBe("Odysseus fixture");
  expect(f.store.getItem(inboxIdentity("cleanup", input.stagingId))).toMatchObject({ status: "ready", attempts: 1 });
});

test("actual process death at checkpoint, commit and follow-up boundaries reopens an atomic state", async () => {
  for (const mode of ["checkpoint", "commit", "follow-up"] as const) {
    const f = setup(), input = f.seed();
    if (mode === "follow-up") escalateInbox(f.db, input);
    const before = f.store.exportState(), fixture = join(f.dir, "intent.json"); writeFileSync(fixture, JSON.stringify(input));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/inbox-actions-worker.ts"), mode, f.path, fixture, f.dir], { stdout: "pipe", stderr: "pipe" });
    cleanup.push(async () => { if (child.exitCode === null) child.kill(); await child.exited; });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(code).toBe(mode === "checkpoint" ? 71 : mode === "commit" ? 74 : 72);
    const reopened = createUiDb(f.path); cleanup.push(() => reopened.close());
    const store = createInboxStore(reopened, { now: f.at });
    if (mode === "commit") {
      expect(store.checkpoints("harbor")).toHaveLength(1);
      expect(store.getItem(input.itemId)).toMatchObject({ status: "blocked", blockedByItemId: input.action.id });
      expect(store.getItem(input.action.id)).toMatchObject({ status: "pending" });
      f.budget.recover();
      expect(f.db.query("SELECT status, charged_turns FROM inbox_budget_reservations").get()).toEqual({ status: "released", charged_turns: 1 });
    } else expect(store.exportState()).toEqual(before);
    if (mode === "checkpoint") escalateInbox(reopened, input);
    const resolver = createInboxResolver(reopened, { now: f.at, allowedOperations: () => [operation] });
    resolver.resolve(f.principal.id, request(input.action.id)); resolver.resolve(f.principal.id, request(input.action.id));
    expect(store.snapshot().items.filter(item => item.queue === "queue" && item.type === "execute")).toHaveLength(1);
    expect(store.exportState().inbox_resolutions).toHaveLength(1);
  }
});

test("two real engine processes race a gated resolution and persist one follow-up", async () => {
  const f = setup(), input = f.seed(); escalateInbox(f.db, input);
  const fixture = join(f.dir, "intent.json"), gate = join(f.dir, "gate"); writeFileSync(fixture, JSON.stringify(input));
  const ready = [join(f.dir, "ready-0"), join(f.dir, "ready-1")];
  const children = ready.map(readyFile => Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/inbox-actions-worker.ts"), "race", f.path, fixture, f.dir, readyFile, gate], { stdout: "pipe", stderr: "pipe" }));
  for (const child of children) cleanup.push(async () => { if (child.exitCode === null) child.kill(); await child.exited; });
  const deadline = Date.now() + 5000;
  while (!ready.every(file => existsSync(file)) && Date.now() < deadline) await Bun.sleep(2);
  expect(ready.every(file => existsSync(file))).toBe(true);
  expect(f.store.getItem(input.itemId)).toMatchObject({ status: "blocked" });
  expect(f.store.exportState().inbox_resolutions).toEqual([]);
  writeFileSync(gate, "go");
  const results = await Promise.all(children.map(async child => {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(0); expect(err).toBe("");
    return JSON.parse(out) as { replay: boolean; followUpId: string };
  }));
  expect(results.map(result => result.replay).sort()).toEqual([false, true]);
  expect(new Set(results.map(result => result.followUpId)).size).toBe(1);
  expect(results[0]!.followUpId.length).toBeGreaterThan(0);
  expect(f.store.exportState().inbox_resolutions).toHaveLength(1);
  expect(f.store.snapshot().items.filter(item => item.queue === "queue" && item.type === "execute")).toHaveLength(1);
});

test("process death after directory removal retains a lease and replays cleanup once on restart", async () => {
  const f = setup(), input = f.seed(); escalateInbox(f.db, input);
  const staged = join(f.dir, SHARE_STAGING_DIR, input.stagingId); mkdirSync(staged, { recursive: true }); writeFileSync(join(staged, "share.txt"), "Odysseus fixture");
  f.resolver.resolve(f.principal.id, request(input.action.id, "deny"));
  const fixture = join(f.dir, "intent.json"); writeFileSync(fixture, JSON.stringify(input));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/inbox-actions-worker.ts"), "cleanup", f.path, fixture, f.dir], { stdout: "pipe", stderr: "pipe" });
  cleanup.push(async () => { if (child.exitCode === null) child.kill(); await child.exited; });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe(""); expect(code).toBe(73);
  expect(existsSync(staged)).toBe(false);
  const id = inboxIdentity("cleanup", input.stagingId);
  expect(f.store.getItem(id)).toMatchObject({ status: "claimed", attempts: 1 });
  f.advance(60_000);
  const reopened = createUiDb(f.path); cleanup.push(() => reopened.close());
  const cleaner = createInboxCleanup(reopened, f.dir, { now: f.at }); cleanup.push(() => cleaner.close());
  expect(await cleaner.sweep()).toBe(0); // recovery schedules the bounded backoff
  f.advance(60_000);
  expect(await cleaner.sweep()).toBe(1); expect(await cleaner.sweep()).toBe(0);
  expect(createInboxStore(reopened).getItem(id)).toMatchObject({ status: "done", attempts: 2 });
  expect(f.store.snapshot().items.filter(item => item.queue === "queue" && item.type === "cleanup_pending")).toHaveLength(1);
});


test("exhausted cooperative yields share one resolvable dead letter and preserve completion receipts through cleanup", () => {
  const f = setup(), input = f.seed();
  recordCompletedCall(f.db, input.escalation.runId, "harbor-write", operation, f.at());
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = f.store.getItem(input.itemId)!;
    expect(current).toMatchObject({ status: "claimed", attempts: attempt });
    if (current.queue !== "queue" || !current.runId) throw new Error("Fixture lost its claimed run");
    expect(f.budget.settle(current.runId, "released")).toBe(true);
    finishYield(f.db, current.runId, f.at());
    if (attempt < 3) f.budget.claim(input.itemId, { runId: `yield-${attempt}`, principalId: f.principal.id,
      model: "fixture", billingMode: "subscription", purpose: "retry" }, f.at() + 600_000);
  }
  expect(f.store.getItem(input.itemId)).toMatchObject({ status: "failed", attempts: 3 });
  sweepInboxLifecycle(f.db, f.at()); sweepInboxLifecycle(f.db, f.at());
  const decisions = f.store.snapshot().items.filter(item => item.queue === "actions" && item.type !== "fyi");
  expect(decisions).toHaveLength(1);
  f.resolver.resolve(f.principal.id, request(decisions[0]!.id, "dismiss"));
  expect(f.store.getItem(input.itemId)).toMatchObject({ status: "dropped" });
  expect(f.store.snapshot().items.filter(item => item.queue === "queue" && item.type === "cleanup_pending")).toHaveLength(1);
  expect(f.db.query("SELECT COUNT(*) AS n FROM inbox_completed_tool_calls").get()).toEqual({ n: 1 });
  expect(f.store.getThread(input.action.threadId)).toMatchObject({ trustClass: "untrusted", source: "share" });
});
