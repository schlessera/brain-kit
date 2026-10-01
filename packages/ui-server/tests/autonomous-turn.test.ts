import { describe, expect, test } from "bun:test";
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
import { createInboxStore } from "../src/inbox/store.js";
import { runAutonomousTurn } from "../src/inbox/autonomous-turn.js";

function setup(startTurn: AgentBackend["startTurn"], autonomous: boolean | undefined = true) {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "autonomous-test" });
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const backend: AgentBackend = { id: "fixture", capabilities: { autonomous, resume: false, permissions: true,
    thinking: false, attachments: false, askUser: false, costReporting: false, concurrentSessions: true, followUp: false },
    startTurn, listProfiles: () => [], listSessions: async () => [], getHistory: async () => [] };
  const input = { turnId: "run", principalId: principal.id, prompt: "Odysseus fixture", allowedTools: ["read"],
    systemPromptAppend: "Server selected instructions", signal: new AbortController().signal };
  const now = Date.now();
  createInboxStore(db).ingest({ threadId: "odysseus", itemId: "odysseus", dedupKey: "odysseus", stagingId: "odysseus", source: "share", stakes: 2, expiresAt: now + 86_400_000 });
  const budget = createInboxBudget(db, { config: { spendUsd: 5, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 }, pricing: { resolve: () => null } });
  budget.claim("odysseus", { runId: input.turnId, principalId: principal.id, model: "fixture", billingMode: "subscription", purpose: "execute" }, now + 600_000);
  return { db, store, principal, backend, input, budget };
}
const permission = { toolUseId: "tool", toolName: "write", input: { path: "notes/harbor.md" } };

describe("server-selected autonomous turn", () => {
  test("unsupported backends and revoked principals reject before runtime acquisition", async () => {
    let starts = 0;
    const f = setup(async () => { starts++; }, undefined);
    // setup's default enables the capability; make the absent legacy field explicit.
    delete f.backend.capabilities.autonomous;
    try {
      await expect(runAutonomousTurn({ ...f, checkpoint: () => {} }, f.input)).rejects.toBeInstanceOf(BackendRequestError);
      f.backend.capabilities.autonomous = true;
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
