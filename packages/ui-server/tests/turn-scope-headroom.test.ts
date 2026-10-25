/** Real monitor/SQLite decisions with controlled journal observations and worker callbacks. */
import { expect, test } from "bun:test";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import type { ClientScopeDecision, TurnScopeSummary } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { createTurnScope, SCOPE_DISCONNECTED_MS } from "../src/brain/turn-scope.js";
import type { TurnJournal } from "../src/brain/turn-journal.js";

function fixture(origin: "interactive" | "voice" = "interactive") {
  const db = createUiDb(":memory:");
  db.query("INSERT INTO sessions(id,title,created_at,last_active_at) VALUES ('ithaca','Voyage',0,0)").run();
  let clock = 0, current = true, connected = true, free = 10 * 1024 ** 3;
  let observer!: Parameters<TurnJournal["onObservation"]>[0];
  let periodic!: NonNullable<Parameters<TurnJournal["onObservation"]>[1]>;
  let freezes = 0, resumes = 0, kills = 0;
  const journal = { onObservation(callback: typeof observer, lifecycle: typeof periodic) { observer = callback; periodic = lifecycle; return () => {}; }, observe: async () => {} } as unknown as TurnJournal;
  const scope = createTurnScope(db, { brainPath: "/", journal, now: () => clock, connected: () => connected, changed: () => {}, space: () => ({ total: 20 * 1024 ** 3, free }) });
  scope.begin("voyage", { sessionId: "ithaca", principalId: "athena", origin, profile: "governed", source: "policy", hardTimeoutMs: 600_000,
    policy: resolveGovernancePolicy({ schema_version: 1, scope: { max_files_changed: 1000, max_bytes_written: 1000, max_minutes: 1 } }), current: () => current, stop: () => { current = false; } });
  const worker = { freeze() { freezes++; }, resume() { resumes++; }, kill() { kills++; }, exited: new Promise<number>(() => {}) } as Parameters<NonNullable<StartTurnRequest["workerStarted"]>>[0];
  scope.workerStarted("voyage", worker);
  const summary = () => JSON.parse((db.query("SELECT summary FROM turn_scope WHERE turn_id='voyage'").get() as { summary: string }).summary) as TurnScopeSummary;
  const receipt = () => summary().receipts.at(-1)!;
  const observe = (count: number, dimension: "files_changed" | "turn_bytes" = "files_changed", partial = false) => {
    periodic.before(); observer("voyage", { changedPaths: dimension === "files_changed" ? count : 0, observedBytes: dimension === "turn_bytes" ? count : 0, partial }); periodic.after(true);
  };
  const message = (action: ClientScopeDecision["action"] = "continue", submissionId = "athena-grant"): ClientScopeDecision => ({ type: "scope_decision", sessionId: "ithaca", turnId: "voyage", eventId: receipt().eventId, submissionId, action });
  return { db, scope, summary, receipt, observe, message, get callbacks() { return { freezes, resumes, kills }; }, advance(ms: number) { clock += ms; }, disconnect() { connected = false; }, end() { current = false; }, floor() { free = 0; }, close() { scope.close(); db.close(); } };
}
for (const dimension of ["files_changed", "turn_bytes"] as const) for (const count of [1000, 1999, 2000, 5333]) test(`${dimension}: finite headroom at ${count}`, async () => {
  const f = fixture();
  try {
    f.observe(count, dimension);
    expect(f.receipt()).toMatchObject({ dimension, count, cap: 1000, overshoot: count - 1000, frozen: true, state: "paused" });
    expect(f.callbacks.freezes).toBeGreaterThanOrEqual(1);
    if (count >= 2000) {
      expect(f.receipt().newCap, "SCOPE_HEADROOM_EXHAUSTED_OFFER_STOP_ONLY").toBeUndefined();
      expect(f.receipt().reason).toContain("finite continuation ceiling");
      expect((await f.scope.decide(f.message(), true)).state).toBe("refused");
      expect(f.receipt().submissionId).toBeUndefined(); expect(f.callbacks.resumes).toBe(0);
    } else {
      expect(f.receipt().newCap).toBe(2000);
      const msg = f.message();
      for (const altered of [{ ...msg, sessionId: "ogygia" }, { ...msg, eventId: "other-event" }, { ...msg, turnId: "other-turn" }]) expect((await f.scope.decide(altered, true)).state).toBe("refused");
      expect((await f.scope.decide(msg, false)).state).toBe("refused");
      expect((await f.scope.decide(msg, true)).state).toBe("accepted"); expect((await f.scope.decide(msg, true)).state).toBe("accepted");
      expect(f.callbacks.resumes).toBe(1); expect(f.summary().limits[dimension]).toBe(2000);
      expect((await f.scope.decide({ ...msg, submissionId: "another-device" }, true)).state).toBe("answered_elsewhere");
      f.observe(2000, dimension); expect(f.receipt().newCap).toBeUndefined();
      expect((await f.scope.decide(f.message("stop", "athena-stop"), true)).state).toBe("accepted");
    }
  } finally { f.close(); }
});
for (const dimension of ["files_changed", "turn_bytes"] as const) test(`${dimension}: latest observation refuses stale submission without consuming grant`, async () => {
  const f = fixture();
  try {
    f.observe(1000, dimension); const msg = f.message(); f.observe(5333, dimension);
    expect(f.receipt()).toMatchObject({ count: 5333, overshoot: 4333 });
    expect((await f.scope.decide(msg, true)).state, "SCOPE_HEADROOM_STALE_DECISION_REFUSED").toBe("refused");
    expect((await f.scope.decide(msg, true)).state).toBe("refused");
    expect(f.summary().limits[dimension]).toBe(1000); expect(f.receipt().state).toBe("paused");
    expect(f.receipt().submissionId).toBeUndefined(); expect(f.callbacks.resumes).toBe(0);
    expect((await f.scope.decide({ ...msg, action: "readback" }, true)).state).toBe("pending");
    expect((await f.scope.decide({ ...msg, action: "stop", submissionId: "athena-stop" }, true)).state).toBe("accepted");
  } finally { f.close(); }
});
test("submission revalidates elapsed time and refuses a tampered ceiling or incomplete observation", async () => {
  for (const mode of ["time", "tampered", "partial"] as const) {
    const f = fixture();
    try {
      if (mode === "time") f.advance(60_000);
      f.observe(mode === "time" ? 0 : 1000); const msg = f.message();
      if (mode === "time") f.advance(60_000);
      if (mode === "partial") f.observe(5333, "files_changed", true);
      if (mode === "tampered") {
        const altered = f.summary(); altered.receipts[0]!.newCap = 9000;
        f.db.query("UPDATE turn_scope SET summary=? WHERE turn_id='voyage'").run(JSON.stringify(altered));
      }
      expect((await f.scope.decide(msg, true)).state, `SCOPE_HEADROOM_${mode.toUpperCase()}_REFUSED`).toBe("refused");
      expect(f.receipt().submissionId).toBeUndefined(); expect(f.callbacks.resumes).toBe(0);
    } finally { f.close(); }
  }
});
test("headroom never overrides voice, free-space floor, ended authority or disconnected lifetime", async () => {
  for (const mode of ["voice", "floor", "ended", "disconnected"] as const) {
    const f = fixture(mode === "voice" ? "voice" : "interactive");
    try {
      f.observe(1000); const msg = f.message();
      if (mode === "floor") f.floor();
      if (mode === "ended") f.end();
      if (mode === "disconnected") { f.disconnect(); f.observe(1000); f.advance(SCOPE_DISCONNECTED_MS); }
      expect((await f.scope.decide(msg, true)).state).not.toBe("accepted");
      expect(f.callbacks.resumes).toBe(0); expect(f.summary().hardTimeoutMs).toBe(600_000);
    } finally { f.close(); }
  }
});
