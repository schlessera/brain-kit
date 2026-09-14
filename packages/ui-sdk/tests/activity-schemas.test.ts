/**
 * Activity stream frames (rev 3, additive): round-trips, unknown-key
 * preservation, and rejection of malformed subscriptions.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { parseClientMessage, parseServerMessage } from "../src/schemas.js";

describe("activity client frames", () => {
  test("subscribe/unsubscribe round-trip through parseClientMessage", () => {
    for (const type of ["activity_subscribe", "activity_unsubscribe"] as const) {
      const res = parseClientMessage(
        JSON.stringify({ type, view: "run", runId: "run-1" })
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.message.type).toBe(type);
        expect((res.message as any).runId).toBe("run-1");
      }
    }
  });

  test("unknown view value is rejected with the standard error path", () => {
    const res = parseClientMessage(
      JSON.stringify({ type: "activity_subscribe", view: "everything" })
    );
    expect(res.ok).toBe(false);
  });

  test("unknown keys are preserved (additive contract)", () => {
    const res = parseClientMessage(
      JSON.stringify({ type: "activity_subscribe", view: "index", futureFlag: true })
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.message as any).futureFlag).toBe(true);
  });
});

describe("activity server frames", () => {
  const span = {
    spanId: "s1",
    runId: "r1",
    name: "invoke_agent",
    kind: "turn",
    origin: "session",
    sessionId: "sess",
    startedAt: 1,
    usage: { inputTokens: 10, costUsd: 0.1, model: "claude-fable-5" },
  };

  test("snapshot round-trips with high-water map and events", () => {
    const res = parseServerMessage(
      JSON.stringify({
        type: "activity_snapshot",
        view: "run",
        runId: "r1",
        spans: [{ ...span, principalId: "principal-a" }],
        events: [{ spanId: "s1", eventIndex: 0, ts: 2, eventType: "text", payload: "hi" }],
        highWaterSeq: { r1: 4 },
      })
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.message.type === "activity_snapshot") {
      expect(res.message.highWaterSeq.r1).toBe(4);
      expect(res.message.spans[0]!.kind).toBe("turn");
      expect(res.message.spans[0]!.principalId).toBe("principal-a");
      expect(res.message.events[0]!.payload).toBe("hi");
    }
  });

  test("a pre-attribution span without principalId still parses", () => {
    const res = parseServerMessage(
      JSON.stringify({ type: "activity_delta", runId: "r1", seq: 1, span })
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.message.type === "activity_delta") {
      expect(res.message.span!.principalId).toBeUndefined();
    }
  });

  test("an invalid principalId is rejected", () => {
    const res = parseServerMessage(
      JSON.stringify({
        type: "activity_delta",
        runId: "r1",
        seq: 1,
        span: { ...span, principalId: 42 },
      })
    );
    expect(res.ok).toBe(false);
  });

  test("the legacy loose span schema ignores the additive principal field", () => {
    const legacySpanSchema = z.looseObject({
      spanId: z.string(),
      runId: z.string(),
      name: z.string(),
      kind: z.enum(["turn", "tool", "subagent", "cron"]),
      origin: z.enum(["session", "cron"]),
      startedAt: z.number(),
    });
    expect(
      legacySpanSchema.safeParse({ ...span, principalId: "principal-a" }).success
    ).toBe(true);
  });

  test("delta carries span or event with seq", () => {
    const res = parseServerMessage(
      JSON.stringify({ type: "activity_delta", runId: "r1", seq: 5, span })
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.message.type === "activity_delta") {
      expect(res.message.seq).toBe(5);
      expect(res.message.span!.outcome).toBeUndefined();
    }
  });

  test("result frame usage block round-trips with per-model breakdown", () => {
    const res = parseServerMessage(
      JSON.stringify({
        type: "result",
        sessionId: "sess",
        durationMs: 100,
        numTurns: 1,
        isError: false,
        usage: {
          inputTokens: 1200,
          outputTokens: 300,
          cacheReadTokens: 5000,
          perModel: { "claude-fable-5": { inputTokens: 1200, costUsd: 1.02 } },
        },
        outcomeDetail: "timeout",
      })
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.message.type === "result") {
      expect(res.message.usage!.perModel!["claude-fable-5"]!.costUsd).toBe(1.02);
      expect(res.message.outcomeDetail).toBe("timeout");
    }
  });

  test("tool_use_start carries optional subagent parent linkage", () => {
    const res = parseServerMessage(
      JSON.stringify({
        type: "tool_use_start",
        toolUseId: "t1",
        toolName: "Read",
        parentToolUseId: "agent-call-1",
        sessionId: "sess",
      })
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.message.type === "tool_use_start") {
      expect(res.message.parentToolUseId).toBe("agent-call-1");
    }
  });
});
