import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createInboxStore } from "../src/inbox/store.js";
import { exportInboxSnapshot, restoreInboxSnapshot, writeInboxSnapshot, type InboxBackup } from "../src/inbox/snapshot.js";
import { createInboxIntake } from "../src/inbox/intake.js";
import { createInboxBudget, acquireInboxBudgetRun } from "../src/inbox/budget.js";
import { createPrincipal } from "../src/db/principals.js";
import { createActivityStore } from "../src/activity/store.js";
import { escalateInbox } from "../src/inbox/escalate.js";
import { createInboxResolver } from "../src/inbox/resolve.js";
import { recordCompletedCall } from "../src/inbox/yield.js";
import { createInboxRuntime } from "../src/inbox/runtime.js";
import { createInboxCleanup } from "../src/inbox/cleanup.js";
import { runAutonomousTurn } from "../src/inbox/autonomous-turn.js";
import { isCompletedAutonomousToolCall, type AgentBackend, type InboxActionItem, type InboxOperation } from "@schlessera/brain-ui-sdk/server";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import { createApp } from "../src/app.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import * as modelPricing from "../src/pricing/model-pricing.js";

const cleanup: (() => void | Promise<void>)[] = [];
const AT = Date.UTC(2026, 6, 12, 12), YEAR = 365 * 86_400_000;
const operation: InboxOperation = { toolName: "write", targetPath: "notes/harbor.md", input: { path: "notes/harbor.md", content: "Odysseus returned." } };
beforeEach(() => { const clock = spyOn(Date, "now").mockReturnValue(AT); cleanup.push(() => clock.mockRestore()); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function directory() {
  const root = mkdtempSync(join(tmpdir(), "brain-snapshot-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function connect(path: string) { const db = createUiDb(path); cleanup.push(() => db.close()); return db; }
const config = { spendUsd: 100, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 };
const pricing = { resolve: () => ({ input: 0.001, output: 0.001, cacheRead: 0.001, cacheWrite: 0.001, estimate: false, source: "snapshot" as const }) };
async function world() {
  const root = directory(), path = join(root, "ui.sqlite"), db = connect(path), store = createInboxStore(db);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: YEAR / 1000 });
  const intake = createInboxIntake(db, root); cleanup.push(() => intake.close());
  const budget = createInboxBudget(db, { config, pricing, maxAutonomousRuns: 20 });
  const activity = createActivityStore(db, { pricing });
  const records = new Map<string, { itemId: string; threadId: string; stagingId: string; actionId?: string }>();
  for (const name of ["ready", "scheduled", "claimed", "blocked", "snoozed", "resolved", "settled"]) {
    const result = await intake.share({ title: `Odysseus: ${name}`, files: [new File([new Uint8Array([137,80,78,71,13,10,26,10])], "harbor.png", { type: "image/png" })] }, principal);
    const record = { itemId: result.itemId, threadId: result.threadId, stagingId: result.result.id, actionId: `action-${name}` };
    records.set(name, record);
    if (name === "ready") continue;
    if (name === "scheduled") {
      const old = store.getItem(record.itemId)!;
      store.commit([{ kind: "transition", itemId: old.id, expectedVersion: old.version, to: "dropped" },
        { kind: "item", item: { ...old, id: "scheduled", dedupKey: "scheduled", queue: "queue", type: "triage", status: "scheduled", attempts: 0, maxAttempts: 3, waitUntil: AT + 86_400_000, payload: { stagingId: record.stagingId } } }]);
      continue;
    }
    const runId = `run-${name}`;
    expect(budget.claim(record.itemId, { runId, principalId: principal.id, model: "fixture", billingMode: "api", purpose: "execute",
      maximumTokens: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } }, AT + 600_000)).not.toBeNull();
    activity.startSpan({ spanId: runId, runId, name: "Odysseus fixture", kind: "turn", origin: "autonomous", startedAt: AT,
      attrs: { "brain.billing_mode": "api", "gen_ai.usage.per_model": { fixture: { inputTokens: name === "claimed" ? 1500 : 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } } } });
    if (name === "claimed") { recordCompletedCall(db, runId, "finished-write", operation); continue; }
    if (name === "settled") {
      store.commit([{ kind: "transition", itemId: record.itemId, expectedVersion: 2, to: "done" }]);
    } else {
      const action: InboxActionItem = { id: record.actionId, dedupKey: record.actionId, threadId: record.threadId, queue: "actions", type: "approve", status: "pending", version: 1, createdAt: AT, updatedAt: AT, expiresAt: AT + YEAR,
        payload: { title: "Write Odysseus's harbor note?", detail: "Write one exact note." }, options: [
          { id: "approve", label: "Write once", effect: { kind: "enqueue", payload: { instruction: "Write the note", operation } } },
          { id: "later", label: "Later", effect: { kind: "snooze" } },
          { id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } },
        ] };
      escalateInbox(db, { itemId: record.itemId, expectedVersion: 2, action, allowedOperations: [operation], escalation: {
        kind: "permission", runId, principalId: principal.id, stateMd: "Odysseus inspected the harbor.", request: { toolUseId: "proposal", toolName: operation.toolName, input: operation.input } } });
      const resolver = createInboxResolver(db, { allowedOperations: () => [operation] });
      if (name === "snoozed") resolver.snooze(principal.id, action.id);
      if (name === "resolved") resolver.resolve(principal.id, { type: "inbox_resolve", itemId: action.id, optionId: "approve" });
    }
    activity.endSpan(runId, { outcome: "success" }); activity.rollupRun(runId);
  }
  store.commit([{ kind: "suppress", classKey: "harbor-seen", evidenceBoundary: "arrival", expiresAt: AT + YEAR, reraiseCondition: "New arrival" },
    { kind: "heartbeat", name: "inbox-drain", tickAt: AT, changeCursor: store.snapshot().cursor }]);
  writeFileSync(join(root, "content.md"), "Odysseus's content stays in git.");
  return { root, path, db, store, principal, budget, records };
}
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function resign(snapshot: InboxBackup): InboxBackup { const { checksum: _, ...body } = snapshot; return { ...body, checksum: hash(JSON.stringify(body)) }; }
function editImage(snapshot: InboxBackup, edit: (db: Database) => void): InboxBackup {
  const db = Database.deserialize(Buffer.from(snapshot.database.data, "base64"));
  try { edit(db); const bytes = db.serialize(); return resign({ ...snapshot, database: { data: bytes.toString("base64"), sha256: hash(bytes) } }); }
  finally { db.close(); }
}

test("operational backup includes a versioned database image instead of audit-only rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-snapshot-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = createUiDb(join(root, "ui.sqlite")); cleanup.push(() => db.close());
  const store = createInboxStore(db, { now: () => 1000 });
  store.commit([{ kind: "heartbeat", name: "inbox-drain", tickAt: 1000, changeCursor: 0 }]);
  expect(store.exportState().inbox_scheduler_heartbeats).toHaveLength(1);
  const snapshot = await exportInboxSnapshot(db, root, 1000);
  expect(snapshot.format).toBe("brain-ui-operational-backup");
});

test("populated image restores all logical tables, staging, principals and settled counters", async () => {
  const f = await world(), partial = join(f.root, SHARE_STAGING_DIR, `.${f.records.get("ready")!.stagingId}.partial`);
  mkdirSync(partial); writeFileSync(join(partial, "bytes.tmp"), "Odysseus's interrupted intake bytes");
  const snapshot = await exportInboxSnapshot(f.db, f.root, AT), target = directory(), path = join(target, "ui.sqlite");
  writeFileSync(join(target, "content.md"), "Odysseus's separately recovered Git content.");
  const archived = Database.deserialize(Buffer.from(snapshot.database.data, "base64"));
  cleanup.push(() => archived.close());
  const expected = f.store.exportState();
  for (const key of Object.keys(expected)) {
    expect(expected[key as keyof typeof expected].length).toBeGreaterThan(0);
    expect(archived.query(`SELECT * FROM ${key} ORDER BY rowid`).all()).toEqual(expected[key as keyof typeof expected]);
  }
  expect(snapshot.files.filter(file => file.path.endsWith("harbor.png"))).toHaveLength(7);
  expect(await exportInboxSnapshot(f.db, f.root, AT)).toEqual(snapshot);
  expect(await restoreInboxSnapshot(snapshot, path, target, AT)).toEqual({ recovered: 1, resumed: false });
  const restored = connect(path), actual = createInboxStore(restored).exportState();
  const claim = f.records.get("claimed")!;
  expect(actual.inbox_items.filter(row => row.id !== claim.itemId)).toEqual(expected.inbox_items.filter(row => row.id !== claim.itemId));
  expect(actual.inbox_changes.slice(0, expected.inbox_changes.length)).toEqual(expected.inbox_changes);
  expect(actual.inbox_changes).toHaveLength(expected.inbox_changes.length + 2);
  for (const row of actual.inbox_changes.slice(-2))
    expect(row).toMatchObject({ kind: "upsert_item", thread_id: claim.threadId, item_id: claim.itemId });
  expect(actual.inbox_thread_sequences.filter(row => row.thread_id !== claim.threadId))
    .toEqual(expected.inbox_thread_sequences.filter(row => row.thread_id !== claim.threadId));
  for (const key of Object.keys(expected)) {
    if (["inbox_items", "inbox_changes", "inbox_thread_sequences", "inbox_budget_reservations"].includes(key)) continue;
    expect(actual[key as keyof typeof actual]).toEqual(expected[key as keyof typeof expected]);
  }
  expect(restored.query("SELECT status, charged_cost_usd, charged_turns, local_day FROM inbox_budget_reservations WHERE run_id = 'run-claimed'").get())
    .toEqual({ status: "released", charged_cost_usd: 1.5, charged_turns: 1, local_day: "2026-07-12" });
  expect(restored.query("SELECT * FROM principals").all()).toEqual(f.db.query("SELECT * FROM principals").all());
  expect(restored.query("SELECT * FROM activity_spans ORDER BY rowid").all()).toEqual(f.db.query("SELECT * FROM activity_spans ORDER BY rowid").all());
  expect(restored.query("SELECT * FROM activity_run_rollups ORDER BY rowid").all()).toEqual(f.db.query("SELECT * FROM activity_run_rollups ORDER BY rowid").all());
  for (const file of snapshot.files) expect(hash(readFileSync(join(target, SHARE_STAGING_DIR, file.path)))).toBe(file.sha256);
  expect(readFileSync(join(f.root, "content.md"), "utf8")).toBe("Odysseus's content stays in git.");
  expect(readFileSync(join(target, "content.md"), "utf8")).toBe("Odysseus's separately recovered Git content.");
  expect(existsSync(join(target, "brain.db"))).toBe(false);
  expect(restored.query("SELECT * FROM inbox_budget_reservations WHERE status = 'settled' ORDER BY id").all())
    .toEqual(f.db.query("SELECT * FROM inbox_budget_reservations WHERE status = 'settled' ORDER BY id").all());
});

test("restored resolution replay mints no second follow-up and a fixture dispatch cannot repeat a completed write", async () => {
  const f = await world();
  expect(f.store.exportState().inbox_completed_tool_calls).toHaveLength(1);
  const snapshot = await exportInboxSnapshot(f.db, f.root, AT), target = directory(), path = join(target, "ui.sqlite");
  await restoreInboxSnapshot(snapshot, path, target, AT);
  const db = connect(path), store = createInboxStore(db), resolved = f.records.get("resolved")!;
  const resolver = createInboxResolver(db, { allowedOperations: () => [operation] });
  const before = store.exportState();
  expect(resolver.resolve(f.principal.id, { type: "inbox_resolve", itemId: resolved.actionId!, optionId: "approve" }).replay).toBe(true);
  expect(store.exportState()).toEqual(before);
  let starts = 0, writes = 0;
  const backend: AgentBackend = { id: "fixture", capabilities: { autonomous: true, resume: false, permissions: true, thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false }, listProfiles: () => [], listSessions: async () => [], getHistory: async () => [], startTurn: async request => {
    starts++;
    if (!isCompletedAutonomousToolCall(request.autonomous, operation.toolName, operation.input)) {
      writes++; writeFileSync(join(target, "duplicate-effect.md"), "An unwanted repeated write.");
    }
    request.bridge.emit({ type: "result", sessionId: "ephemeral", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  } };
  const id = f.records.get("claimed")!.itemId;
  const at = AT + 60_000;
  const budget = createInboxBudget(db, { config, pricing, now: () => at });
  expect(budget.claim(id, { runId: "restored-run", principalId: f.principal.id, model: "fixture", billingMode: "subscription", purpose: "retry" }, at + 600_000)).not.toBeNull();
  await runAutonomousTurn({ db, store: createActivityStore(db), backend, checkpoint() {} }, { turnId: "restored-run", principalId: f.principal.id, prompt: "Inspect the recovered harbor", billingMode: "subscription", allowedTools: ["write"], systemPromptAppend: "Server instructions", signal: new AbortController().signal });
  expect(starts).toBe(1); expect(writes).toBe(0); expect(existsSync(join(target, "duplicate-effect.md"))).toBe(false);
  expect(store.exportState().inbox_resolutions).toHaveLength(1);
});

test.each([
  ["unsupported", "inbox_snapshot_version"], ["database", "inbox_snapshot_checksum"],
  ["staging", "inbox_snapshot_checksum"], ["outer-checksum", "inbox_snapshot_checksum"],
  ["missing-staging", "inbox_snapshot_missing_staging"],
  ["relation", "inbox_snapshot_relations"], ["reservation", "inbox_snapshot_reservation"],
  ["follow-up", "inbox_snapshot_relations"], ["sequence", "inbox_snapshot_relations"],
  ["missing-sequence", "inbox_snapshot_relations"], ["missing-resolution", "inbox_snapshot_relations"],
  ["schema", "inbox_snapshot_schema"],
])("refuses %s snapshot before writing a target", async (kind, error) => {
  const f = await world(); let snapshot = await exportInboxSnapshot(f.db, f.root, AT);
  if (kind === "unsupported") snapshot = { ...snapshot, version: 2 } as unknown as InboxBackup;
  if (kind === "database") snapshot.database.data = snapshot.database.data.slice(0, -4);
  if (kind === "staging") snapshot.files[0]!.data = Buffer.from("tampered").toString("base64");
  if (kind === "outer-checksum") snapshot.createdAt--;
  if (kind === "missing-staging") snapshot = resign({ ...snapshot, files: snapshot.files.filter(file => !file.path.endsWith("harbor.png")) });
  if (kind === "relation") snapshot = editImage(snapshot, db => { db.exec("PRAGMA foreign_keys = OFF; DELETE FROM inbox_threads WHERE id = (SELECT thread_id FROM inbox_items LIMIT 1)"); });
  if (kind === "reservation") snapshot = editImage(snapshot, db => { db.exec("DELETE FROM inbox_budget_reservations WHERE status = 'active'"); });
  if (kind === "follow-up") snapshot = editImage(snapshot, db => { db.exec("DELETE FROM inbox_items WHERE type = 'execute'"); });
  if (kind === "sequence") snapshot = editImage(snapshot, db => { db.exec("UPDATE inbox_thread_sequences SET seq = seq + 1"); });
  if (kind === "missing-sequence") snapshot = editImage(snapshot, db => { db.exec("DELETE FROM inbox_thread_sequences"); });
  if (kind === "missing-resolution") snapshot = editImage(snapshot, db => {
    const trigger = db.query("SELECT sql FROM sqlite_master WHERE name = 'inbox_resolution_no_delete'").get() as { sql: string };
    db.exec("DROP TRIGGER inbox_resolution_no_delete; DELETE FROM inbox_resolutions"); db.exec(trigger.sql);
  });
  if (kind === "schema") snapshot = editImage(snapshot, db => { db.exec("DROP TRIGGER inbox_thread_provenance_immutable"); });
  const target = directory(), path = join(target, "ui.sqlite");
  await expect(restoreInboxSnapshot(snapshot, path, target, AT)).rejects.toThrow(error);
  expect(existsSync(path)).toBe(false); expect(existsSync(join(target, SHARE_STAGING_DIR))).toBe(false);
});

test("nonempty targets and staging symlinks are refused without changing existing bytes", async () => {
  const f = await world(), snapshot = await exportInboxSnapshot(f.db, f.root, AT), target = directory(), path = join(target, "ui.sqlite");
  writeFileSync(path, "Keep this database destination");
  await expect(restoreInboxSnapshot(snapshot, path, target, AT)).rejects.toThrow();
  expect(readFileSync(path, "utf8")).toBe("Keep this database destination");
  rmSync(path); const foreign = directory(); mkdirSync(join(target, ".brain-ui")); symlinkSync(foreign, join(target, SHARE_STAGING_DIR));
  await expect(restoreInboxSnapshot(snapshot, path, target, AT)).rejects.toThrow("inbox_staging_symlink");
  expect(existsSync(path)).toBe(false); expect((await fs.readdir(foreign))).toEqual([]);
});

test("a populated UI target and an edited pending database are both preserved on refusal", async () => {
  const f = await world(), snapshot = await exportInboxSnapshot(f.db, f.root, AT), target = directory(), path = join(target, "ui.sqlite");
  const db = connect(path), store = createInboxStore(db);
  store.commit([{ kind: "heartbeat", name: "Preserve Odysseus", tickAt: AT, changeCursor: 0 }]);
  const before = store.exportState();
  await expect(restoreInboxSnapshot(snapshot, path, target, AT)).rejects.toThrow("inbox_restore_nonempty");
  expect(store.exportState()).toEqual(before);
  const interrupted = directory(), interruptedPath = join(interrupted, "ui.sqlite");
  const copy = Database.deserialize(Buffer.from(snapshot.database.data, "base64"));
  try {
    copy.query("INSERT INTO inbox_recovery_state VALUES (1, ?, ?, 'pending', NULL)").run(snapshot.checksum, interrupted);
    copy.query("UPDATE inbox_scheduler_heartbeats SET change_cursor = 999").run();
    writeFileSync(interruptedPath, copy.serialize());
  } finally { copy.close(); }
  const edited = connect(interruptedPath), prior = createInboxStore(edited).exportState();
  await expect(restoreInboxSnapshot(snapshot, interruptedPath, interrupted, AT)).rejects.toThrow("inbox_restore_nonempty");
  expect(createInboxStore(edited).exportState()).toEqual(prior);
  expect(existsSync(join(interrupted, SHARE_STAGING_DIR))).toBe(false);
});

test("an absent database with surviving SQLite sidecars is not an empty restore target", async () => {
  const f = await world(), snapshot = await exportInboxSnapshot(f.db, f.root, AT);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const target = directory(), path = join(target, "ui.sqlite"), sidecar = path + suffix;
    writeFileSync(sidecar, "Odysseus's existing SQLite sidecar");
    await expect(restoreInboxSnapshot(snapshot, path, target, AT)).rejects.toThrow("inbox_restore_nonempty");
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(sidecar, "utf8")).toBe("Odysseus's existing SQLite sidecar");
  }
});

test("expired leases and legacy runless reservations reconcile without moving admission days or erasing charges", async () => {
  const f = await world();
  const row = f.db.query("SELECT * FROM inbox_budget_reservations WHERE run_id = 'run-claimed'").get() as Record<string, string | number | null>;
  const legacy = { ...row, id: "legacy", operation_key: "legacy", run_id: null, item_id: f.records.get("ready")!.itemId,
    attempt: 0, local_day: "2026-07-11", reserved_cost_usd: 2, reserved_turns: 2, pricing_json: null, runtime_acquired_at: null };
  const keys = Object.keys(legacy);
  f.db.query(`INSERT INTO inbox_budget_reservations (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(legacy));
  const snapshot = await exportInboxSnapshot(f.db, f.root, AT), target = directory(), path = join(target, "ui.sqlite");
  expect(await restoreInboxSnapshot(snapshot, path, target, AT + 600_001)).toEqual({ recovered: 1, resumed: false });
  const db = connect(path);
  expect(db.query("SELECT status, charged_cost_usd, charged_turns, local_day FROM inbox_budget_reservations WHERE id = 'legacy'").get())
    .toEqual({ status: "released", charged_cost_usd: 2, charged_turns: 2, local_day: "2026-07-11" });
  expect(db.query("SELECT status, charged_cost_usd, charged_turns, local_day FROM inbox_budget_reservations WHERE run_id = 'run-claimed'").get())
    .toEqual({ status: "released", charged_cost_usd: 1.5, charged_turns: 1, local_day: "2026-07-12" });
  expect(createInboxStore(db).getItem(f.records.get("claimed")!.itemId)).toMatchObject({ status: "ready", attempts: 1 });
});

test("missing source staging and concurrent database/staging writes never replace the last good backup", async () => {
  const f = await world(), output = join(directory(), "backup.json");
  await writeInboxSnapshot(f.db, f.root, output); const previous = readFileSync(output);
  const missing = join(f.root, SHARE_STAGING_DIR, f.records.get("ready")!.stagingId, "harbor.png");
  rmSync(missing);
  await expect(writeInboxSnapshot(f.db, f.root, output)).rejects.toThrow("inbox_snapshot_missing_staging");
  expect(readFileSync(output)).toEqual(previous);
  writeFileSync(missing, new Uint8Array([137,80,78,71,13,10,26,10]));
  const original = fs.open; let changed = false;
  const race = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (!changed) { changed = true; f.store.commit([{ kind: "heartbeat", name: "racing-writer", tickAt: AT + 1, changeCursor: 0 }]); }
    return original(...args);
  });
  try { await expect(writeInboxSnapshot(f.db, f.root, output)).rejects.toThrow("inbox_snapshot_changed"); }
  finally { race.mockRestore(); }
  expect(changed).toBe(true); expect(readFileSync(output)).toEqual(previous);
  expect(statSync(output).mode & 0o777).toBe(0o600);
});

test.each(["database", "staging"])("export refuses a %s destination reached through a directory alias", async kind => {
  const f = await world(), alias = join(directory(), "alias");
  const parent = kind === "database" ? f.root : join(f.root, SHARE_STAGING_DIR, f.records.get("ready")!.stagingId);
  symlinkSync(parent, alias);
  const name = kind === "database" ? "ui.sqlite" : "harbor.png", original = readFileSync(join(parent, name));
  await expect(writeInboxSnapshot(f.db, f.root, join(alias, name))).rejects.toThrow("inbox_snapshot_destination");
  expect(readFileSync(join(parent, name))).toEqual(original);
});

test("export protects both a linked source entry and its physical database", async () => {
  const f = await world(), link = join(f.root, "linked.sqlite"); symlinkSync(f.path, link);
  const db = new Database(link, { readonly: true }); cleanup.push(() => db.close());
  for (const target of [link, f.path])
    await expect(writeInboxSnapshot(db, f.root, target)).rejects.toThrow("inbox_snapshot_destination");
  expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  expect(f.store.exportState().inbox_completed_tool_calls).toHaveLength(1);
});

test("interrupted staging holds runtime, claim and acquisition gates, then resumes exactly once", async () => {
  const f = await world(), snapshot = await exportInboxSnapshot(f.db, f.root, AT), target = directory(), path = join(target, "ui.sqlite");
  const original = fs.link; let interrupted = false;
  const crash = spyOn(fs, "link").mockImplementation(async (from, to) => {
    if (String(to).endsWith("harbor.png")) { interrupted = true; throw new Error("fixture interrupted staging"); }
    return original(from, to);
  });
  try { await expect(restoreInboxSnapshot(snapshot, path, target, AT)).rejects.toThrow("fixture interrupted staging"); }
  finally { crash.mockRestore(); }
  expect(interrupted).toBe(true);
  const db = connect(path), before = createInboxStore(db).exportState();
  expect(db.query("SELECT status FROM inbox_recovery_state").get()).toEqual({ status: "pending" });
  let starts = 0;
  expect(() => createInboxRuntime(db, { log: { emit() {}, enabled: () => false }, dispatch: async () => { starts++; } })).toThrow("inbox_restore_pending");
  const budget = createInboxBudget(db, { config, pricing });
  expect(() => budget.claim(f.records.get("ready")!.itemId, { runId: "premature", principalId: f.principal.id, model: "fixture", billingMode: "subscription", purpose: "execute" }, AT + 600_000)).toThrow("inbox_restore_pending");
  expect(() => acquireInboxBudgetRun(db, "run-claimed", f.principal.id, AT)).toThrow("inbox_restore_pending");
  expect(starts).toBe(0); expect(createInboxStore(db).exportState()).toEqual(before);
  expect(await restoreInboxSnapshot(snapshot, path, target, AT)).toEqual({ resumed: true, recovered: 1 });
  expect(db.query("SELECT status FROM inbox_recovery_state").get()).toEqual({ status: "ready" });
  const after = createInboxStore(db).exportState();
  await expect(restoreInboxSnapshot(snapshot, path, target, AT)).rejects.toThrow("inbox_restore_nonempty");
  expect(createInboxStore(db).exportState()).toEqual(after);
  const cleaner = createInboxCleanup(db, target); cleanup.push(() => cleaner.close());
  expect(await cleaner.sweep()).toBe(0);
});

test("app boot closes a pending restore database before allocating pricing or background resources", async () => {
  const f = await world();
  f.db.query("INSERT INTO inbox_recovery_state VALUES (1, ?, ?, 'pending', NULL)").run("a".repeat(64), f.root);
  const factory = spyOn(modelPricing, "createModelPricing"), close = Database.prototype.close;
  let closed = 0, error: unknown;
  const closing = spyOn(Database.prototype, "close").mockImplementation(function(this: Database, ...args: Parameters<Database["close"]>) {
    if (this.filename === f.path) closed++;
    return close.apply(this, args);
  });
  const backend = makeFakeBackend({ id: "fixture" });
  try {
    try {
      const app = await createApp({ config: resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", DB_PATH: f.path,
        BRAIN_PATH: f.root, BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0" }),
        registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
      await app.close();
    } catch (caught) { error = caught; }
    expect(factory.mock.calls).toHaveLength(0);
    expect(closed).toBe(1);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe("inbox_restore_pending");
  } finally { closing.mockRestore(); factory.mockRestore(); }
});

test("a pending gate stops a live drain and compensation before changing ledgers or staged bytes", async () => {
  const f = await world(), runtime = createInboxRuntime(f.db, { log: { emit() {}, enabled: () => false } });
  cleanup.push(() => runtime.close()); await runtime.ready;
  const record = f.records.get("ready")!, old = f.store.getItem(record.itemId)!;
  f.store.commit([{ kind: "transition", itemId: old.id, expectedVersion: old.version, to: "dropped" },
    { kind: "item", item: { ...old, id: "compensate", dedupKey: "compensate", queue: "queue", type: "cleanup_pending",
      payload: { stagingId: record.stagingId }, status: "ready", attempts: 0, maxAttempts: 3 } }]);
  f.db.query("INSERT INTO inbox_recovery_state VALUES (1, ?, ?, 'pending', NULL)").run("a".repeat(64), f.root);
  const before = f.store.exportState(), file = join(f.root, SHARE_STAGING_DIR, record.stagingId, "harbor.png"), bytes = readFileSync(file);
  const result = await runtime.tick();
  expect(f.store.exportState()).toEqual(before);
  expect(result).toMatchObject({ failed: true, claimed: 0, recovered: 0 });
  const cleaner = createInboxCleanup(f.db, f.root); cleanup.push(() => cleaner.close());
  await expect(cleaner.sweep()).rejects.toThrow("inbox_restore_pending");
  expect(readFileSync(file)).toEqual(bytes); expect(f.store.exportState()).toEqual(before);
});

test.each(["export", "restore-image", "staging", "reconcile", "committed"])("SIGKILL at %s leaves a usable backup or a resumable closed restore", async mode => {
  const f = await world(), snapshot = await exportInboxSnapshot(f.db, f.root, AT), output = join(directory(), "backup.json");
  writeFileSync(output, JSON.stringify(snapshot));
  const previous = readFileSync(output), source = f.store.exportState();
  const target = directory(), path = join(target, "ui.sqlite"), ready = join(target, "ready");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/inbox-snapshot-worker.ts"), mode,
    mode === "export" ? f.path : path, mode === "export" ? f.root : target, output, ready, String(AT)],
    { stdout: "pipe", stderr: "pipe" });
  cleanup.push(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; });
  const deadline = performance.now() + 10_000;
  while (!existsSync(ready)) {
    if (child.exitCode !== null || performance.now() > deadline) {
      child.kill("SIGKILL"); await child.exited;
      throw new Error(`Crash boundary ${mode} not reached: ${await new Response(child.stderr).text()}`);
    }
    await Bun.sleep(10);
  }
  expect(readFileSync(ready, "utf8")).toBe(mode);
  child.kill("SIGKILL"); await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
  expect(f.store.exportState()).toEqual(source);
  if (mode === "export") {
    expect(readFileSync(output)).toEqual(previous);
    expect(await restoreInboxSnapshot(JSON.parse(readFileSync(output, "utf8")), path, target, AT)).toEqual({ recovered: 1, resumed: false });
  } else {
    const db = connect(path), store = createInboxStore(db);
    if (mode === "committed") {
      expect(db.query("SELECT status FROM inbox_recovery_state").get()).toEqual({ status: "ready" });
      const before = store.exportState();
      await expect(restoreInboxSnapshot(snapshot, path, target, AT)).rejects.toThrow("inbox_restore_nonempty");
      expect(store.exportState()).toEqual(before);
    } else {
      // Even death after settlements/claim transitions but before COMMIT leaves
      // the entire original ledger and projections intact, with dispatch shut.
      expect(store.exportState()).toEqual(source);
      expect(db.query("SELECT status FROM inbox_recovery_state").get()).toEqual({ status: "pending" });
      expect(() => createInboxRuntime(db, { log: { emit() {}, enabled: () => false }, dispatch: async () => {} })).toThrow("inbox_restore_pending");
      expect(await restoreInboxSnapshot(snapshot, path, target, AT)).toEqual({ recovered: 1, resumed: true });
    }
    expect(store.getItem(f.records.get("claimed")!.itemId)).toMatchObject({ status: "ready", attempts: 1, waitUntil: AT + 60_000 });
    expect(db.query("SELECT status, charged_cost_usd, charged_turns FROM inbox_budget_reservations WHERE run_id = 'run-claimed'").get())
      .toEqual({ status: "released", charged_cost_usd: 1.5, charged_turns: 1 });
    expect(store.exportState().inbox_resolutions).toHaveLength(1);
    expect(store.exportState().inbox_items.filter(row => row.type === "execute")).toHaveLength(1);
    expect(store.exportState().inbox_completed_tool_calls).toEqual(source.inbox_completed_tool_calls);
    for (const file of snapshot.files) expect(hash(readFileSync(join(target, SHARE_STAGING_DIR, file.path)))).toBe(file.sha256);
  }
});
