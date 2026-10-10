import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBackend, BackendBridge, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { assertTurnPosture, BackendRequestError, requestToolPermission } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createActivityStore } from "../src/activity/store.js";
import { createActivityRoutes } from "../src/routes/activity.js";
import { createInboxBudget } from "../src/inbox/budget.js";
import { createInboxStore, InboxStore } from "../src/inbox/store.js";
import { runAutonomousTurn } from "../src/inbox/autonomous-turn.js";
import { WsHost } from "../src/ws/host.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { handleChatMessage } from "../src/ws/run-session.js";
import { testAuthorization } from "./helpers/principal.js";

function setup(startTurn: AgentBackend["startTurn"], autonomous: boolean | undefined = true, options: { dbPath?: string; api?: boolean } = {}) {
  const db = createUiDb(options.dbPath ?? ":memory:");
  const store = createActivityStore(db, { writer: "autonomous-test" });
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const backend: AgentBackend = { id: "fixture", capabilities: { autonomous, restrictedAutonomous: autonomous, resume: false, permissions: true,
    thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    startTurn, listProfiles: () => [], listSessions: async () => [], getHistory: async () => [] };
  const input = { turnId: "run", principalId: principal.id, prompt: "Odysseus fixture", allowedTools: ["read"],
    systemPromptAppend: "Server selected instructions", signal: new AbortController().signal,
    ...(options.api ? { billingMode: "api" as const } : {}) };
  const now = Date.now();
  createInboxStore(db).ingest({ threadId: "odysseus", itemId: "odysseus", dedupKey: "odysseus", stagingId: "odysseus", source: "share", stakes: 2, expiresAt: now + 86_400_000 });
  const budget = createInboxBudget(db, { config: { spendUsd: 5, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 }, pricing: { resolve: () => ({ input: 0.003, output: 0.003, cacheRead: 0.003, cacheWrite: 0.003, estimate: false, source: "snapshot" }) } });
  budget.claim("odysseus", { runId: input.turnId, principalId: principal.id, model: "fixture", billingMode: options.api ? "api" : "subscription", purpose: "execute",
    ...(options.api ? { maximumTokens: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } } : {}) }, now + 600_000);
  return { db, store, principal, backend, input, budget };
}
const permission = { toolUseId: "tool", toolName: "write", input: { path: "notes/harbor.md" } };

describe("server-selected autonomous turn", () => {
  test("two active autonomous turns stop further claims while the real interactive dispatch still starts", async () => {
    let starts = 0, interactiveStarts = 0, release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = setup(async (req) => {
      if (req.autonomous) { starts++; await gate; }
      else { interactiveStarts++; req.bridge.emit({ type: "session_info", sessionId: "interactive", isNew: true, backendId: "fixture" }); }
      req.bridge.emit({ type: "result", sessionId: "runtime", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
    });
    f.backend.listProfiles = () => [{ id: "fixture", label: "Fixture" }];
    const store = createInboxStore(f.db), now = Date.now();
    for (const id of ["penelope", "telemachus"]) store.ingest({ threadId: id, itemId: id, dedupKey: id,
      stagingId: id, source: "share", stakes: 2, expiresAt: now + 86_400_000 });
    expect(f.budget.claim("penelope", { runId: "run-2", principalId: f.principal.id, model: "fixture", billingMode: "subscription", purpose: "execute" }, now + 600_000)).not.toBeNull();
    const first = runAutonomousTurn({ ...f, checkpoint: () => {} }, f.input);
    const second = runAutonomousTurn({ ...f, checkpoint: () => {} }, { ...f.input, turnId: "run-2" });
    const frames: string[] = [], ws = { send: (data: string) => { frames.push(data); } };
    const host = new WsHost({ registry: createStaticBackendRegistry([f.backend], "fixture"),
      catalog: createSessionCatalog(() => f.db), maxConcurrentSessions: () => 1 });
    host.clients.add(ws, f.principal.id);
    try {
      expect(starts).toBe(2);
      expect(f.budget.claim("telemachus", { runId: "run-3", principalId: f.principal.id, model: "fixture", billingMode: "subscription", purpose: "execute" }, now + 600_000)).toBeNull();
      expect(store.getItem("telemachus")).toMatchObject({ status: "ready", attempts: 0 });
      await handleChatMessage(host, ws, { authorization: testAuthorization(f.principal.id), text: "Odysseus interactive request", attachments: [] });
      await Bun.sleep(0);
      expect(interactiveStarts).toBe(1);
      expect(frames.some((frame) => frame.includes("SESSION_LIMIT"))).toBe(false);
      expect(starts).toBe(2);
    } finally { release(); await Promise.allSettled([first, second]); host.close(); f.db.close(); }
  });
  test("yield checkpoints before abort and makes work ready only after backend unwind", async () => {
    let statusAtUnwind = "", callbacks = 0;
    let signal: AbortSignal | undefined, abortedAtCheckpoint: boolean | undefined;
    const f = setup(async (req) => {
      signal = req.signal;
      req.bridge.emit({ type: "text_delta", text: "Odysseus checkpoint" });
      req.autonomous?.onYield?.("path:harbor");
      callbacks++;
      statusAtUnwind = createInboxStore(f.db).getItem("odysseus")!.status;
      expect(req.signal.aborted).toBe(true);
      expect(createInboxStore(f.db).checkpoints("odysseus")).toHaveLength(1);
      req.autonomous?.onYield?.("path:harbor");
      req.bridge.emit({ type: "result", sessionId: "runtime", outcome: "cancelled", isError: false, durationMs: 1, numTurns: 1 });
    });
    const original = InboxStore.prototype.commit;
    const receipt = spyOn(InboxStore.prototype, "commit").mockImplementation(function (this: InboxStore, mutations) {
      if (mutations.some((mutation) => mutation.kind === "checkpoint" && mutation.id.startsWith("yield-")))
        abortedAtCheckpoint = signal!.aborted;
      return original.call(this, mutations);
    });
    try {
      await runAutonomousTurn({ ...f, checkpoint: () => {} }, f.input);
      expect(abortedAtCheckpoint).toBe(false);
      expect(callbacks).toBe(1);
      expect(statusAtUnwind).toBe("claimed");
      expect(createInboxStore(f.db).getItem("odysseus")).toMatchObject({ status: "ready", attempts: 1 });
      expect(createInboxStore(f.db).checkpoints("odysseus").filter((entry) => entry.id.startsWith("yield-"))).toHaveLength(1);
    } finally { receipt.mockRestore(); f.db.close(); }
  });
  test("repeated yields consume attempts and create exactly one dead-letter Action", async () => {
    const f = setup(async (req) => {
      req.autonomous!.onYield!("path:harbor");
      req.bridge.emit({ type: "result", sessionId: "runtime", outcome: "cancelled", isError: false, durationMs: 1, numTurns: 1 });
    });
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const turnId = attempt === 1 ? "run" : `run-${attempt}`;
        if (attempt > 1) expect(f.budget.claim("odysseus", { runId: turnId, principalId: f.principal.id,
          model: "fixture", billingMode: "subscription", purpose: "retry" }, Date.now() + 600_000)).not.toBeNull();
        expect(await runAutonomousTurn({ ...f, checkpoint: () => {} }, { ...f.input, turnId })).toMatchObject({ yielded: true, outcome: "cancelled" });
      }
      const store = createInboxStore(f.db);
      expect(store.getItem("odysseus")).toMatchObject({ status: "failed", attempts: 3 });
      expect(store.snapshot().items.filter((item) => item.queue === "actions")).toHaveLength(1);
      expect(f.budget.claim("odysseus", { runId: "run-4", principalId: f.principal.id, model: "fixture",
        billingMode: "subscription", purpose: "retry" }, Date.now() + 600_000)).toBeNull();
      expect(f.budget.totals().normal.turns).toBe(3);
    } finally { f.db.close(); }
  });
  test("completed tool receipts survive yield and reach the fresh attempt without granting authority", async () => {
    let attempt = 0;
    const completed = { toolName: "write", input: { path: "notes/harbor.md", content: "Odysseus" } };
    const f = setup(async (req) => {
      attempt++;
      if (attempt === 1) {
        req.bridge.emit({ type: "tool_use_start", toolUseId: "read-1", toolName: "Read" });
        req.bridge.emit({ type: "tool_use_complete", toolUseId: "read-1", toolName: "Read", input: { file_path: "notes/harbor.md" } });
        req.bridge.emit({ type: "tool_result", toolUseId: "read-1", output: "Odysseus", isError: false });
        req.bridge.emit({ type: "tool_use_start", toolUseId: "write-1", toolName: completed.toolName });
        req.bridge.emit({ type: "tool_use_complete", toolUseId: "write-1", ...completed });
        req.bridge.emit({ type: "tool_result", toolUseId: "write-1", output: "Written", isError: false });
        req.autonomous!.onYield!("path:harbor");
      } else {
        expect(req.autonomous!.completedToolCalls).toEqual([completed]);
        expect(req.autonomous!.allowedTools).toEqual(["read"]);
        req.bridge.emit({ type: "result", sessionId: "runtime", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
      }
    });
    try {
      await runAutonomousTurn({ ...f, checkpoint: () => {} }, f.input);
      expect(f.budget.claim("odysseus", { runId: "run-2", principalId: f.principal.id, model: "fixture", billingMode: "subscription", purpose: "retry" }, Date.now() + 600_000)).not.toBeNull();
      await runAutonomousTurn({ ...f, checkpoint: () => {} }, { ...f.input, turnId: "run-2" });
      expect(attempt).toBe(2);
    } finally { f.db.close(); }
  });
  test("a failed yield checkpoint aborts visibly and retains the lease for recovery", async () => {
    const errors: string[] = [];
    const f = setup(async (req) => {
      req.autonomous!.onYield!("path:harbor");
      expect(req.signal.aborted).toBe(true);
    });
    f.db.exec("CREATE TRIGGER fixture_failed_yield BEFORE INSERT ON inbox_checkpoints BEGIN SELECT RAISE(ABORT, 'yield storage failure'); END");
    try {
      expect(await runAutonomousTurn({ ...f, checkpoint: () => {}, emit: (frame) => { if (frame.type === "error") errors.push(frame.code); } }, f.input))
        .toMatchObject({ outcome: "error", yielded: false });
      expect(errors).toContain("AUTONOMOUS_YIELD_FAILED");
      expect(createInboxStore(f.db).getItem("odysseus")).toMatchObject({ status: "claimed", attempts: 1 });
      expect(createInboxStore(f.db).checkpoints("odysseus")).toEqual([]);
    } finally { f.db.close(); }
  });
  test("yield settles actual API usage, frees unused reserves and retains completion receipts after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-yield-restart-")), dbPath = join(dir, "ui.db");
    let attempt = 0;
    const call = { toolName: "write", input: { path: "notes/harbor.md", content: "Odysseus" } };
    const f = setup(async (req) => {
      attempt++;
      if (attempt === 1) {
        req.bridge.emit({ type: "tool_use_start", toolUseId: "write", toolName: "write" });
        req.bridge.emit({ type: "tool_use_complete", toolUseId: "write", ...call });
        req.bridge.emit({ type: "tool_result", toolUseId: "write", isError: false, output: "Written" });
        req.autonomous!.onYield!("path:harbor");
      } else expect(req.autonomous!.completedToolCalls).toEqual([call]);
      req.bridge.emit({ type: "result", sessionId: "runtime", outcome: "success", isError: false,
        durationMs: 1, numTurns: 1, costUsd: 0.3,
        usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
          perModel: { fixture: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.3 } } } });
    }, true, { dbPath, api: true });
    let db = f.db;
    try {
      expect(await runAutonomousTurn({ ...f, checkpoint: () => {} }, f.input)).toMatchObject({ yielded: true, outcome: "cancelled" });
      expect(db.query("SELECT status, reserved_cost_usd, observed_cost_usd, charged_cost_usd, charged_turns FROM inbox_budget_reservations WHERE run_id = 'run'").get())
        .toEqual({ status: "settled", reserved_cost_usd: 3, observed_cost_usd: 0.3, charged_cost_usd: 0.3, charged_turns: 1 });
      db.close(); db = createUiDb(dbPath);
      expect(createInboxStore(db).getItem("odysseus")).toMatchObject({ status: "ready", attempts: 1 });
      expect(createInboxStore(db).checkpoints("odysseus")).toHaveLength(1);
      const budget = createInboxBudget(db, { config: { spendUsd: 5, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 },
        pricing: { resolve: () => ({ input: 0.003, output: 0.003, cacheRead: 0.003, cacheWrite: 0.003, estimate: false, source: "snapshot" }) } });
      expect(budget.totals().normal).toEqual({ cost: 300_000, turns: 1 });
      expect(budget.claim("odysseus", { runId: "run-2", principalId: f.principal.id, model: "fixture", billingMode: "api", purpose: "retry",
        maximumTokens: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } }, Date.now() + 600_000)).not.toBeNull();
      await runAutonomousTurn({ ...f, db, store: createActivityStore(db), checkpoint: () => {} }, { ...f.input, turnId: "run-2" });
      expect(attempt).toBe(2);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  test("unsupported backends and revoked principals reject before runtime acquisition", async () => {
    let starts = 0;
    const f = setup(async () => { starts++; }, undefined);
    // setup's default enables the capability; make the absent legacy field explicit.
    delete f.backend.capabilities.autonomous;
    delete f.backend.capabilities.restrictedAutonomous;
    try {
      await expect(runAutonomousTurn({ ...f, checkpoint: () => {} }, f.input)).rejects.toBeInstanceOf(BackendRequestError);
      f.backend.capabilities.autonomous = true;
      // An autonomous backend without the restricted envelope is unsupported too (#676).
      await expect(runAutonomousTurn({ ...f, checkpoint: () => {} }, f.input)).rejects.toThrow("cannot run the restricted autonomous envelope");
      f.backend.capabilities.restrictedAutonomous = true;
      revokePrincipal(f.db, f.principal.id, Date.now());
      await expect(runAutonomousTurn({ ...f, checkpoint: () => {} }, f.input)).rejects.toBeInstanceOf(BackendRequestError);
      expect(starts).toBe(0);
      expect(f.store.openRootSpans()).toEqual([]);
    } finally { f.db.close(); }
  });
  test("checkpoints once, before abort; callback cannot widen tools or retain a live bridge", async () => {
    let bridge: BackendBridge | undefined;
    const snapshots: unknown[] = [];
    let observedAbort = false;
    let runtimeSignal: AbortSignal | undefined;
    const f = setup(async (req) => {
      runtimeSignal = req.signal;
      bridge = req.bridge;
      expect(Object.isFrozen(req.autonomous!.allowedTools)).toBe(true);
      req.bridge.emit({ type: "text_delta", text: "Odysseus found a harbor." });
      await requestToolPermission(req.bridge, permission, { noGrantSurface: true });
      expect(req.signal.aborted).toBe(true);
      await requestToolPermission(req.bridge, permission, { noGrantSurface: true });
      req.bridge.emit({ type: "result", sessionId: "runtime", outcome: "cancelled", isError: false, durationMs: 1, numTurns: 1 });
    });
    try {
      const result = await runAutonomousTurn({ ...f, checkpoint: (snapshot) => {
        snapshots.push(snapshot);
        observedAbort = runtimeSignal!.aborted;
      } }, f.input);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ stateMd: "Odysseus found a harbor.", runId: "run", principalId: f.principal.id });
      expect(observedAbort).toBe(false);
      expect(result).toMatchObject({ escalated: true, outcome: "cancelled" });
      bridge!.checkpointPermission!(permission);
      expect(snapshots).toHaveLength(1);
      expect(f.store.openRootSpans()).toEqual([]);
    } finally { f.db.close(); }
  });
  test("checkpoint failure is visible and never becomes a grant or a success", async () => {
    const errors: string[] = [];
    let granted = false;
    const f = setup(async (req) => {
      try { const decision = await requestToolPermission(req.bridge, permission, { noGrantSurface: true }); granted = decision.behavior === "allow"; } catch { /* adapter tool error */ }
      req.bridge.emit({ type: "result", sessionId: "runtime", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
    });
    try {
      const result = await runAutonomousTurn({ ...f, checkpoint: () => { throw new Error("Store refused checkpoint"); },
        emit: (frame) => { if (frame.type === "error") errors.push(frame.code); } }, f.input);
      expect(granted).toBe(false);
      expect(errors).toContain("AUTONOMOUS_CHECKPOINT_FAILED");
      expect(result).toMatchObject({ outcome: "error", escalated: false });
      expect(f.store.getSpan("run:turn")!.outcome).toBe("error");
    } finally { f.db.close(); }
  });
  test("a checkpoint stays within 4096 UTF-8 bytes with complete code points", async () => {
    let stateMd = "";
    const f = setup(async (req) => {
      req.bridge.emit({ type: "text_delta", text: "⚓".repeat(2000) });
      await requestToolPermission(req.bridge, permission, { noGrantSurface: true });
    });
    try {
      await runAutonomousTurn({ ...f, checkpoint: (snapshot) => { stateMd = snapshot.stateMd; } }, f.input);
      expect(stateMd.length).toBeGreaterThan(0);
      expect(new TextEncoder().encode(stateMd).length).toBeLessThanOrEqual(4096);
      expect(stateMd).not.toContain("\uFFFD");
    } finally { f.db.close(); }
  });
  test("the declared mode rejects resume, persistence, missing policy and missing capture", () => {
    const bridge: BackendBridge = { emit: () => {}, requestPermission: async () => ({ behavior: "allow" }), checkpointPermission: () => {} };
    const req: StartTurnRequest = { prompt: "fixture", signal: new AbortController().signal, bridge,
      enforceAllowedTools: true, noGrantSurface: true,
      autonomous: { origin: "autonomous", persistence: "none", allowedTools: [], systemPromptAppend: "" } };
    expect(() => assertTurnPosture(req, true)).not.toThrow();
    expect(() => assertTurnPosture(req)).toThrow(BackendRequestError);
    expect(() => assertTurnPosture({ ...req, sessionId: "ordinary-session" }, true)).toThrow(BackendRequestError);
    expect(() => assertTurnPosture({ ...req, noGrantSurface: false }, true)).toThrow(BackendRequestError);
    expect(() => assertTurnPosture({ ...req, autonomous: { ...req.autonomous!, persistence: "disk" } } as unknown as StartTurnRequest, true)).toThrow(BackendRequestError);
    expect(() => assertTurnPosture({ ...req, autonomous: { ...req.autonomous!, allowedTools: undefined } } as unknown as StartTurnRequest, true)).toThrow(BackendRequestError);
    expect(() => assertTurnPosture({ ...req, bridge: { ...bridge, checkpointPermission: undefined } }, true)).toThrow(BackendRequestError);
  });
});

test("Activity origin filtering separates live and settled autonomous runs", async () => {
  const f = setup(async () => {});
  try {
    for (const origin of ["session", "cron", "autonomous"] as const) {
      for (const phase of ["live", "settled"] as const) {
        const id = `${origin}-${phase}`;
        f.store.startSpan({ spanId: id, runId: id, name: "Odysseus fixture", kind: "turn", origin });
        if (phase === "settled") {
          f.store.endSpan(id, { outcome: "success" });
          f.store.rollupRun(id);
        }
      }
    }
    expect(f.store.openRootSpans()).toHaveLength(3);
    const response = await createActivityRoutes(f).request("/activity/runs?origin=autonomous");
    expect(response.status).toBe(200);
    const body = await response.json() as { live: Array<{ runId: string }>; history: Array<{ runId: string }> };
    expect(body.live.map((run) => run.runId)).toEqual(["autonomous-live"]);
    expect(body.history.map((run) => run.runId)).toEqual(["autonomous-settled"]);
  } finally { f.db.close(); }
});

test("Activity origin migration preserves populated spans, events, cursors and indexes", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-autonomous-migration-"));
  const path = join(dir, "ui.sqlite");
  let db = new Database(path);
  try {
    const migrations = join(import.meta.dir, "../migrations");
    db.exec("CREATE TABLE _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL)");
    for (const file of readdirSync(migrations).filter((file) => file.endsWith(".sql") && file < "023_autonomous_activity.sql").sort()) {
      db.exec(readFileSync(join(migrations, file), "utf8"));
      db.query("INSERT INTO _migrations (filename, applied_at) VALUES (?, 1)").run(file);
    }
    const old = createActivityStore(db, { writer: "fixture" });
    old.startSpan({ spanId: "old", runId: "old", name: "Old turn", kind: "turn", origin: "session", principalId: "owner" });
    old.appendEvent("old", "fixture", { detail: "Odysseus" });
    const before = old.snapshotRun("old")!;
    expect(before.spans).toHaveLength(1);
    expect(before.events).toHaveLength(1);
    db.close();
    db = createUiDb(path);
    const current = createActivityStore(db, { writer: "fixture" });
    expect(current.snapshotRun("old")).toEqual(before);
    current.startSpan({ spanId: "new", runId: "new", name: "Autonomous", kind: "turn", origin: "autonomous" });
    expect(current.getSpan("new")!.origin).toBe("autonomous");
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='activity_spans'").all()).toContainEqual({ name: "idx_activity_spans_open" });
    expect(current.sweepOwnOrphans()).toBe(2);
    expect(current.getSpan("new")!.outcome).toBe("interrupted");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("missing, expired and reused reservations refuse actual backend starts", async () => {
  let starts = 0;
  const f = setup(async (request) => {
    starts++;
    request.bridge.emit({ type: "result", sessionId: "runtime", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  });
  try {
    const unreservedError = await runAutonomousTurn({ ...f, checkpoint: () => {} }, { ...f.input, turnId: "unreserved" }).catch((error) => error);
    expect(starts).toBe(0);
    expect(unreservedError).toBeInstanceOf(BackendRequestError);
    await runAutonomousTurn({ ...f, checkpoint: () => {} }, f.input);
    expect(starts).toBe(1);
    await expect(runAutonomousTurn({ ...f, checkpoint: () => {} }, f.input)).rejects.toBeInstanceOf(BackendRequestError);
    expect(starts).toBe(1);
    const s = createInboxStore(f.db);
    s.commit([{ kind: "transition", itemId: "odysseus", expectedVersion: 2, to: "ready" }]);
    f.budget.claim("odysseus", { runId: "expired", principalId: f.principal.id, model: "fixture", billingMode: "subscription", purpose: "retry" }, Date.now() + 600_000);
    s.commit([{ kind: "transition", itemId: "odysseus", expectedVersion: 4, to: "ready" }]);
    await expect(runAutonomousTurn({ ...f, checkpoint: () => {} }, { ...f.input, turnId: "expired" })).rejects.toBeInstanceOf(BackendRequestError);
    expect(starts).toBe(1);
  } finally { f.db.close(); }
});
