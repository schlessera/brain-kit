/**
 * The client activity mirror: seq-discard (AE6 client half), idempotent
 * delta application, and the selectors the timeline and drill-in render from.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";

import {
  useActivityStore,
  childSpans,
  narrativeEventsFor,
  payloadEventsFor,
  runEvents,
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
    deltaSeq: {},
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

  test("a stale snapshot (lower high-water) does not regress a newer span", () => {
    const s = useActivityStore.getState();
    s.applySnapshot({
      type: "activity_snapshot",
      view: "run",
      runId: "r1",
      spans: [span({ spanId: "a", runId: "r1", outcome: "success" })],
      events: [],
      highWaterSeq: { r1: 10 },
    });
    // A frame from before the reconnect races in with older state.
    s.applySnapshot({
      type: "activity_snapshot",
      view: "run",
      runId: "r1",
      spans: [span({ spanId: "a", runId: "r1" })],
      events: [{ spanId: "a", eventIndex: 0, ts: 50, eventType: "transcript_assistant" }],
      highWaterSeq: { r1: 5 },
    });
    const state = useActivityStore.getState();
    expect(state.spans.r1!.a!.outcome).toBe("success");
    expect(state.highWater.r1).toBe(10);
    expect(state.events.a).toBeUndefined();
  });

  test("an index snapshot evicts a ghost-running run it omits", () => {
    const s = useActivityStore.getState();
    // A run the store believes is live…
    s.applySnapshot({
      type: "activity_snapshot",
      view: "session",
      sessionId: "sess",
      spans: [span({ spanId: "ghost-root", runId: "rg", sessionId: "sess" })],
      events: [],
      highWaterSeq: { rg: 3 },
    });
    // …and one that finished properly (terminal state is history, not a ghost).
    s.applySnapshot({
      type: "activity_snapshot",
      view: "run",
      runId: "rt",
      spans: [span({ spanId: "done-root", runId: "rt", outcome: "success" })],
      events: [],
      highWaterSeq: { rt: 2 },
    });
    // The index snapshot omits rg: the server says it is not live any more.
    s.applySnapshot({
      type: "activity_snapshot",
      view: "index",
      spans: [],
      events: [],
      highWaterSeq: {},
    });
    const state = useActivityStore.getState();
    expect(state.spans.rg).toBeUndefined();
    expect(state.highWater.rg).toBeUndefined();
    expect(state.spanRun["ghost-root"]).toBeUndefined();
    expect(state.spans.rt!["done-root"]).toBeDefined();
  });

  test("newer-delta state survives a subsequent equal-high-water append frame", () => {
    const s = useActivityStore.getState();
    s.applySnapshot({
      type: "activity_snapshot",
      view: "session",
      sessionId: "sess",
      spans: [span({ spanId: "a", runId: "r1", sessionId: "sess" })],
      events: [],
      highWaterSeq: { r1: 5 },
    });
    s.applyDelta({
      type: "activity_delta",
      runId: "r1",
      seq: 6,
      span: span({ spanId: "a", runId: "r1", sessionId: "sess", outcome: "success" }),
    });
    // A chunked continuation of the ORIGINAL snapshot repeats its map and
    // stale span state; it must not roll the delta back.
    s.applySnapshot({
      type: "activity_snapshot",
      view: "session",
      sessionId: "sess",
      spans: [span({ spanId: "a", runId: "r1", sessionId: "sess" })],
      events: [],
      highWaterSeq: { r1: 5 },
      append: true,
    });
    expect(useActivityStore.getState().spans.r1!.a!.outcome).toBe("success");
  });

  test("the terminal-run cap evicts the oldest finished runs, never live ones", () => {
    const s = useActivityStore.getState();
    s.applySnapshot({
      type: "activity_snapshot",
      view: "run",
      runId: "live",
      spans: [span({ spanId: "live-root", runId: "live", startedAt: 1 })],
      events: [],
      highWaterSeq: { live: 1 },
    });
    for (let i = 0; i < 52; i++) {
      s.applySnapshot({
        type: "activity_snapshot",
        view: "run",
        runId: `term-${i}`,
        spans: [
          span({
            spanId: `term-${i}-root`,
            runId: `term-${i}`,
            startedAt: 100 + i,
            outcome: "success",
          }),
        ],
        events: [],
        highWaterSeq: { [`term-${i}`]: 1 },
      });
    }
    const state = useActivityStore.getState();
    expect(state.spans["term-0"]).toBeUndefined();
    expect(state.spans["term-1"]).toBeUndefined();
    expect(state.spans["term-51"]).toBeDefined();
    expect(state.spans.live).toBeDefined();
    expect(Object.keys(state.spans)).toHaveLength(51);
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
      highWaterSeq: { r1: 3 },
      append: true,
    });
    expect(useActivityStore.getState().highWater.r1).toBe(7);
    s.applySnapshot({
      type: "activity_snapshot", view: "run", runId: "r1",
      spans: [], events: [], highWaterSeq: { r1: 9 }, append: true,
    });
    expect(useActivityStore.getState().highWater.r1).toBe(9);
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

  test("childSpans resolves each level of a nested subagent tree", () => {
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
        span({
          spanId: "sub-a",
          runId: "t",
          kind: "subagent",
          parentSpanId: "agent-1",
          sessionId: "sess",
          startedAt: 120,
        }),
        span({ spanId: "sub-a-1", runId: "t", parentSpanId: "sub-a", startedAt: 130 }),
      ],
      events: [],
      highWaterSeq: { t: 4 },
    });
    const state = useActivityStore.getState();
    expect(childSpans(state, "agent-1").map((x) => x.spanId)).toEqual(["sub-a"]);
    expect(childSpans(state, "sub-a").map((x) => x.spanId)).toEqual(["sub-a-1"]);
  });

  test("a delta cancelling a live subagent lands in spanForTool", () => {
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
        }),
      ],
      events: [],
      highWaterSeq: { t: 2 },
    });
    // The drill-in's `running` flag reads span.outcome via spanForTool.
    expect(spanForTool(useActivityStore.getState(), "agent-1")!.outcome).toBeUndefined();
    s.applyDelta({
      type: "activity_delta",
      runId: "t",
      seq: 3,
      span: span({
        spanId: "agent-1",
        runId: "t",
        kind: "subagent",
        parentSpanId: "t:turn",
        sessionId: "sess",
        outcome: "cancelled",
        endedAt: 500,
      }),
    });
    const after = spanForTool(useActivityStore.getState(), "agent-1")!;
    expect(after.outcome).toBe("cancelled");
    expect(after.endedAt).toBe(500);
  });

  test("payloadEventsFor returns a child tool span's recorded input/output (AE7)", () => {
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
        }),
        span({ spanId: "tool-1", runId: "t", parentSpanId: "agent-1", startedAt: 120 }),
      ],
      events: [
        { spanId: "tool-1", eventIndex: 0, ts: 121, eventType: "tool_input", payload: '{"a":1}' },
      ],
      highWaterSeq: { t: 4 },
    });
    // The output lands later as a delta, like the live stream delivers it.
    s.applyDelta({
      type: "activity_delta",
      runId: "t",
      seq: 5,
      event: { spanId: "tool-1", eventIndex: 1, ts: 130, eventType: "tool_output", payload: "ok" },
    });
    // A transcript event on the same span must not leak into the payload view.
    s.applyDelta({
      type: "activity_delta",
      runId: "t",
      seq: 6,
      event: {
        spanId: "tool-1",
        eventIndex: 2,
        ts: 140,
        eventType: "transcript_assistant",
        payload: "thinking",
      },
    });
    const state = useActivityStore.getState();
    expect(payloadEventsFor(state, "tool-1").map((e) => [e.eventType, e.payload])).toEqual([
      ["tool_input", '{"a":1}'],
      ["tool_output", "ok"],
    ]);
    // A span with no payload events (pre-feature run) yields the empty result.
    expect(payloadEventsFor(state, "agent-1")).toHaveLength(0);
  });

  test("narrativeEventsFor and runEvents cover everything the payload view filters out", () => {
    const s = useActivityStore.getState();
    s.applySnapshot({
      type: "activity_snapshot",
      view: "run",
      runId: "cron-1",
      spans: [
        span({ spanId: "cron-1:root", runId: "cron-1", kind: "cron", origin: "cron" }),
        span({ spanId: "tool-9", runId: "cron-1", parentSpanId: "cron-1:root", startedAt: 110 }),
      ],
      events: [
        { spanId: "tool-9", eventIndex: 0, ts: 130, eventType: "tool_input", payload: "{}" },
        { spanId: "cron-1:root", eventIndex: 0, ts: 120, eventType: "job_output", payload: "done" },
        // An event type no client version knows about must still be reachable.
        { spanId: "cron-1:root", eventIndex: 1, ts: 140, eventType: "sink_note", payload: "hi" },
      ],
      highWaterSeq: { "cron-1": 1 },
    });
    const state = useActivityStore.getState();
    // The cron root has no tool payloads — without the narrative selector its
    // recorded output would render nowhere.
    expect(payloadEventsFor(state, "cron-1:root")).toHaveLength(0);
    expect(narrativeEventsFor(state, "cron-1:root").map((e) => e.eventType)).toEqual([
      "job_output",
      "sink_note",
    ]);
    // Tool payloads stay with the payload expander, out of the narrative.
    expect(narrativeEventsFor(state, "tool-9")).toHaveLength(0);
    // The run-wide view is every event, in time order across spans.
    expect(runEvents(state, "cron-1").map((e) => [e.ts, e.eventType])).toEqual([
      [120, "job_output"],
      [130, "tool_input"],
      [140, "sink_note"],
    ]);
    expect(runEvents(state, "unknown-run")).toHaveLength(0);
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
