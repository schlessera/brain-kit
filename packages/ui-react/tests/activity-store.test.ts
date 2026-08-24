/**
 * The client activity mirror: seq-discard (AE6 client half), idempotent
 * delta application, and the selectors the timeline and drill-in render from.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";

import {
  useActivityStore,
  childSpans,
  spanForTool,
  subagentSpans,
  timingFor,
} from "../src/stores/activity-store";

function span(overrides: Partial<ActivitySpan> & { spanId: string; runId: string }): ActivitySpan {
  return {
    name: "execute_tool Read",
    kind: "tool",
    origin: "session",
    startedAt: 100,
    ...overrides,
  };
}

beforeEach(() => {
  useActivityStore.setState({
    supported: false,
    subscribed: {},
    spans: {},
    events: {},
    highWater: {},
    spanRun: {},
  });
});

describe("snapshot-then-delta (AE6 client half)", () => {
  test("a delta at or below the snapshot high-water is discarded", () => {
    const s = useActivityStore.getState();
    s.applySnapshot({
      type: "activity_snapshot",
      view: "run",
      runId: "r1",
      spans: [span({ spanId: "a", runId: "r1", outcome: "success" })],
      events: [],
      highWaterSeq: { r1: 5 },
    });
    // A replayed delta (seq 5) carrying an OLDER span state must not win.
    s.applyDelta({
      type: "activity_delta",
      runId: "r1",
      seq: 5,
      span: span({ spanId: "a", runId: "r1" }),
    });
    expect(useActivityStore.getState().spans.r1!.a!.outcome).toBe("success");

    // Seq 6 is new information and applies.
    s.applyDelta({
      type: "activity_delta",
      runId: "r1",
      seq: 6,
      span: span({ spanId: "b", runId: "r1" }),
    });
    expect(useActivityStore.getState().spans.r1!.b).toBeDefined();
  });

  test("event deltas are idempotent by (spanId, eventIndex) and stay ordered", () => {
    const s = useActivityStore.getState();
    s.applySnapshot({
      type: "activity_snapshot",
      view: "run",
      runId: "r1",
      spans: [span({ spanId: "a", runId: "r1" })],
      events: [],
      highWaterSeq: { r1: 1 },
    });
    const ev = (i: number, ts: number) => ({
      type: "activity_delta" as const,
      runId: "r1",
      seq: 1 + i + 1,
      event: { spanId: "a", eventIndex: i, ts, eventType: "transcript_assistant", payload: `e${i}` },
    });
    s.applyDelta(ev(1, 20));
    s.applyDelta(ev(0, 10));
    s.applyDelta(ev(1, 20)); // duplicate delivery
    const events = useActivityStore.getState().events.a!;
    expect(events.map((e) => e.eventIndex)).toEqual([0, 1]);
  });

  test("append snapshot frames max-merge the high-water map", () => {
    const s = useActivityStore.getState();
    s.applySnapshot({
      type: "activity_snapshot",
      view: "run",
      runId: "r1",
      spans: [],
      events: [],
      highWaterSeq: { r1: 7 },
    });
    s.applySnapshot({
      type: "activity_snapshot",
      view: "run",
      runId: "r1",
      spans: [],
      events: [],
      highWaterSeq: { r1: 7 },
      append: true,
    });
    expect(useActivityStore.getState().highWater.r1).toBe(7);
  });
});

describe("selectors", () => {
  test("childSpans and subagentSpans shape the fan-out tree", () => {
    const s = useActivityStore.getState();
    s.applySnapshot({
      type: "activity_snapshot",
      view: "session",
      sessionId: "sess",
      spans: [
        span({ spanId: "t:turn", runId: "t", kind: "turn", sessionId: "sess" }),
        span({
          spanId: "agent-1",
          runId: "t",
          kind: "subagent",
          parentSpanId: "t:turn",
          sessionId: "sess",
          startedAt: 110,
        }),
        span({ spanId: "sub-a", runId: "t", parentSpanId: "agent-1", startedAt: 130 }),
        span({ spanId: "sub-b", runId: "t", parentSpanId: "agent-1", startedAt: 120 }),
      ],
      events: [],
      highWaterSeq: { t: 4 },
    });
    const state = useActivityStore.getState();
    expect(childSpans(state, "agent-1").map((x) => x.spanId)).toEqual(["sub-b", "sub-a"]);
    expect(subagentSpans(state, "sess").map((x) => x.spanId)).toEqual(["agent-1"]);
    expect(spanForTool(state, "sub-a")!.runId).toBe("t");
  });

  test("timingFor uses the wait/execution boundary and server clock", () => {
    const s = useActivityStore.getState();
    s.applySnapshot({
      type: "activity_snapshot",
      view: "run",
      runId: "r1",
      spans: [
        span({ spanId: "gated", runId: "r1", startedAt: 100, waitUntil: 400, endedAt: 900 }),
      ],
      events: [],
      highWaterSeq: { r1: 1 },
    });
    // Approval wait (100..400) must not inflate the duration.
    expect(timingFor(useActivityStore.getState(), "gated")).toEqual({
      startedAt: 400,
      endedAt: 900,
    });
    expect(timingFor(useActivityStore.getState(), "unknown")).toBeNull();
  });
});
