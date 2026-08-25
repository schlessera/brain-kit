/**
 * TurnRecorder terminal precedence: the buffered result frame refines the
 * host's disposition (a max_turns error result lands as timeout), while
 * host-owned facts (cancel/timeout) always win over the backend's outcome.
 */
import { describe, expect, test } from "bun:test";

import { createTurnRecorder } from "../src/activity/recorder";
import { createActivityStore } from "../src/activity/store";
import { createUiDb } from "../src/db/client";

function setup(
  turnId: string,
  extra: { profileId?: string; billingMode?: "subscription" | "api" } = {}
) {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "test" });
  const recorder = createTurnRecorder(
    { store },
    { turnId, sessionId: "sess-1", ...extra }
  );
  return { db, store, recorder };
}

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

  test("a payload over the cap is clipped with the truncation marker", () => {
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
    const payload = event!.payload as string;
    expect(payload.endsWith("\n… [truncated]")).toBe(true);
    expect(payload.length).toBe(4096 + "\n… [truncated]".length);
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
    recorder.onApprovalDecision("tool-1", false);
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
