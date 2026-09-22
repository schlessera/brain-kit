/**
 * TurnRecorder terminal precedence: the buffered result frame refines the
 * host's disposition (a max_turns error result lands as timeout), while
 * host-owned facts (cancel/timeout) always win over the backend's outcome.
 */
import { describe, expect, test } from "bun:test";

import { createTurnRecorder } from "../src/activity/recorder";
import { createActivityStore, rowToRunRollup } from "../src/activity/store";
import { createUiDb } from "../src/db/client";

function setup(
  turnId: string,
  extra: {
    profileId?: string;
    billingMode?: "subscription" | "api";
    principalId?: string;
  } = {}
) {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "test" });
  const recorder = createTurnRecorder(
    { store },
    { turnId, sessionId: "sess-1", ...extra }
  );
  return { db, store, recorder };
}

function insertPrincipal(
  db: ReturnType<typeof createUiDb>,
  id: string,
  label: string,
  kind: "owner" | "agent" = "owner"
) {
  db.query(
    `INSERT INTO principals
       (id, kind, auth_method, label, created_at, expires_at)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(
    id,
    kind,
    kind === "agent" ? "delegated" : "password",
    label,
    Number.MAX_SAFE_INTEGER
  );
}

describe("principal attribution", () => {
  test("the initiator is stamped on the root and snapshotted onto the durable rollup", () => {
    const { db, store, recorder } = setup("turn-actor", { principalId: "principal-a" });
    insertPrincipal(db, "principal-a", "Alex Example's laptop");

    recorder.finish("success");
    db.query("UPDATE principals SET label = 'Renamed device' WHERE id = 'principal-a'").run();
    store.rollupRun("turn-actor");

    expect(store.getSpan("turn-actor:turn")!.principalId).toBe("principal-a");
    expect(
      rowToRunRollup(
        db.query("SELECT * FROM activity_run_rollups WHERE run_id = 'turn-actor'").get()
      )
    ).toMatchObject({
      principalId: "principal-a",
      principalLabel: "Alex Example's laptop",
      principalKind: "owner",
    });
  });

  test("the rollup keeps the actor snapshot after principal and span pruning", () => {
    const { db, store, recorder } = setup("turn-pruned", { principalId: "principal-agent" });
    insertPrincipal(db, "principal-agent", "Research agent", "agent");
    recorder.finish("success");

    db.query("DELETE FROM principals WHERE id = 'principal-agent'").run();
    const pruned = store.prune({
      digestFloorAt: Date.now() + 1,
      detailRetentionMs: 0,
      hardCeilingMs: 0,
      now: Date.now() + 1,
    });

    expect(pruned.runsPruned).toBe(1);
    expect(store.snapshotRun("turn-pruned")).toBeNull();
    expect(
      rowToRunRollup(
        db.query("SELECT * FROM activity_run_rollups WHERE run_id = 'turn-pruned'").get()
      )
    ).toMatchObject({
      principalId: "principal-agent",
      principalLabel: "Research agent",
      principalKind: "agent",
      detailPruned: true,
    });
  });
});

describe("turn recorder terminal precedence", () => {
  test("a max_turns error result refines finish('error') into a timeout outcome", () => {
    const { store, recorder } = setup("turn-mt");
    recorder.observeFrame({ type: "session_info", sessionId: "sess-1", isNew: true });
    recorder.observeFrame({
      type: "result",
      sessionId: "sess-1",
      outcome: "error",
      durationMs: 10,
      numTurns: 1,
      isError: true,
      outcomeDetail: "max_turns",
    });
    recorder.finish("error");

    const root = store.getSpan("turn-mt:turn")!;
    expect(root.outcome).toBe("timeout");
    expect(root.attrs["outcome.detail"]).toBe("max_turns");
  });

  test("a host-owned cancellation beats a success result frame", () => {
    const { store, recorder } = setup("turn-cx");
    recorder.observeFrame({ type: "session_info", sessionId: "sess-1", isNew: true });
    recorder.observeFrame({
      type: "result",
      sessionId: "sess-1",
      outcome: "success",
      durationMs: 10,
      numTurns: 1,
      isError: false,
    });
    recorder.finish("cancelled");

    expect(store.getSpan("turn-cx:turn")!.outcome).toBe("cancelled");
  });
});

describe("tool payload capture (AE7)", () => {
  function startTool(recorder: ReturnType<typeof setup>["recorder"], toolUseId: string) {
    recorder.observeFrame({ type: "session_info", sessionId: "sess-1", isNew: true });
    recorder.observeFrame({
      type: "tool_use_start",
      sessionId: "sess-1",
      toolUseId,
      toolName: "Read",
    });
  }

  function eventsOf(store: ReturnType<typeof setup>["store"], runId: string, spanId: string) {
    return (store.snapshotRun(runId)?.events ?? []).filter((e) => e.spanId === spanId);
  }

  test("tool_use_complete and tool_result record tool_input/tool_output events", () => {
    const { store, recorder } = setup("turn-io");
    startTool(recorder, "tool-1");
    recorder.observeFrame({
      type: "tool_use_complete",
      sessionId: "sess-1",
      toolUseId: "tool-1",
      toolName: "Read",
      input: { file_path: "/tmp/a.txt" },
    });
    recorder.observeFrame({
      type: "tool_result",
      sessionId: "sess-1",
      toolUseId: "tool-1",
      output: "file contents",
      isError: false,
    });

    const events = eventsOf(store, "turn-io", "tool-1");
    expect(events.map((e) => e.eventType)).toEqual(["tool_input", "tool_output"]);
    expect(events[0]!.payload).toBe(JSON.stringify({ file_path: "/tmp/a.txt" }));
    expect(events[1]!.payload).toBe("file contents");
  });

  test("an error tool_result records its output too", () => {
    const { store, recorder } = setup("turn-err");
    startTool(recorder, "tool-1");
    recorder.observeFrame({
      type: "tool_result",
      sessionId: "sess-1",
      toolUseId: "tool-1",
      output: "ENOENT: no such file",
      isError: true,
    });

    const events = eventsOf(store, "turn-err", "tool-1");
    expect(events.map((e) => e.eventType)).toEqual(["tool_output"]);
    expect(events[0]!.payload).toBe("ENOENT: no such file");
  });

  test("a payload over the cap is clipped and flagged truncated", () => {
    const { store, recorder } = setup("turn-clip");
    startTool(recorder, "tool-1");
    recorder.observeFrame({
      type: "tool_result",
      sessionId: "sess-1",
      toolUseId: "tool-1",
      output: "x".repeat(5000),
      isError: false,
    });

    const [event] = eventsOf(store, "turn-clip", "tool-1");
    expect(event!.truncated).toBe(true);
    expect((event!.payload as string).length).toBe(4096);
  });

  test("a denied tool records its input but no output", () => {
    const { store, recorder } = setup("turn-deny");
    startTool(recorder, "tool-1");
    recorder.observeFrame({
      type: "tool_use_complete",
      sessionId: "sess-1",
      toolUseId: "tool-1",
      toolName: "Read",
      input: { file_path: "/etc/passwd" },
    });
    recorder.onApprovalDecision("tool-1", "deny", "tool");
    recorder.finish("success");

    const events = eventsOf(store, "turn-deny", "tool-1");
    expect(events.map((e) => e.eventType)).toEqual(["tool_input"]);
    expect(store.getSpan("tool-1")!.outcome).toBe("denied");
  });

  test("a tool_result for an unknown span id neither throws nor records", () => {
    const { store, recorder } = setup("turn-unknown");
    recorder.observeFrame({ type: "session_info", sessionId: "sess-1", isNew: true });
    recorder.observeFrame({
      type: "tool_result",
      sessionId: "sess-1",
      toolUseId: "never-started",
      output: "orphan",
      isError: false,
    });

    expect(store.snapshotRun("turn-unknown")?.events ?? []).toEqual([]);
  });

  test("an unserializable input falls back without breaking capture", () => {
    const { store, recorder } = setup("turn-bigint");
    startTool(recorder, "tool-1");
    recorder.observeFrame({
      type: "tool_use_complete",
      sessionId: "sess-1",
      toolUseId: "tool-1",
      toolName: "Read",
      input: { size: BigInt(42) },
    });

    const events = eventsOf(store, "turn-bigint", "tool-1");
    expect(events.map((e) => e.eventType)).toEqual(["tool_input"]);
    expect(typeof events[0]!.payload).toBe("string");
  });
});

describe("root span profile and billing attrs", () => {
  test("the root span carries the resolved profile and billing mode when given", () => {
    const { store, recorder } = setup("turn-bill", {
      profileId: "claude",
      billingMode: "subscription",
    });
    recorder.observeFrame({ type: "session_info", sessionId: "sess-1", isNew: true });
    recorder.finish("success");

    const root = store.getSpan("turn-bill:turn")!;
    expect(root.attrs["brain.profile_id"]).toBe("claude");
    expect(root.attrs["brain.billing_mode"]).toBe("subscription");
  });

  test("without the options the root span carries no billing attrs", () => {
    const { store, recorder } = setup("turn-nobill");
    recorder.observeFrame({ type: "session_info", sessionId: "sess-1", isNew: true });
    recorder.finish("success");

    const root = store.getSpan("turn-nobill:turn")!;
    expect("brain.profile_id" in root.attrs).toBe(false);
    expect("brain.billing_mode" in root.attrs).toBe(false);
  });
});

describe("a denial the host never saw (#110)", () => {
  function startTool(
    recorder: ReturnType<typeof setup>["recorder"],
    toolUseId: string,
    toolName = "Bash"
  ) {
    recorder.observeFrame({ type: "session_info", sessionId: "sess-1", isNew: true });
    recorder.observeFrame({
      type: "tool_use_start",
      sessionId: "sess-1",
      toolUseId,
      toolName,
    });
  }

  test("a backend-reported refusal lands the same denied span a user's refusal does", () => {
    // A turn with no grant surface refuses before the request reaches the
    // host, so onApprovalDecision — where a user's denial is recorded — never
    // runs. The span must still read as denied rather than as a call that
    // errored, which is all the backend's error tool_result would say.
    const refused = setup("turn-refused");
    startTool(refused.recorder, "tool-1");
    refused.recorder.observeActivity({
      kind: "permission_denied",
      toolUseId: "tool-1",
      requestKind: "command",
      reason: "This turn has no way to ask anyone for permission.",
    });
    refused.recorder.observeFrame({
      type: "tool_result",
      sessionId: "sess-1",
      toolUseId: "tool-1",
      output: "This turn has no way to ask anyone for permission.",
      isError: true,
    });
    refused.recorder.finish("success");

    const declined = setup("turn-declined");
    startTool(declined.recorder, "tool-1");
    declined.recorder.onApprovalDecision("tool-1", "deny", "command");
    declined.recorder.finish("success");

    // Write-once: the error tool_result that follows does not relabel it.
    expect(refused.store.getSpan("tool-1")!.outcome).toBe("denied");
    expect(refused.store.getSpan("tool-1")!.outcome).toBe(
      declined.store.getSpan("tool-1")!.outcome
    );
    expect(
      (refused.store.snapshotRun("turn-refused")?.events ?? []).map((e) => e.eventType)
    ).toContain("approval_decision");
  });
});
