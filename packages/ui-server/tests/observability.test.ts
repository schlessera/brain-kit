/**
 * The observability consumers, and the property that makes them worth having:
 * instrumentation is written ONCE, against the OpenTelemetry API, and the
 * consumer is chosen per environment. A test asserts against the same emission
 * path production uses — only the sink differs.
 */
import { describe, expect, test } from "bun:test";
import { metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

import {
  createConsoleLoggerProvider,
  createInMemoryMeterProvider,
  createRecordingLoggerProvider,
  createObservability,
  createRecordingObservability,
  createSilentObservability,
  seriesKey,
  severityRank,
  type Observability,
  type Severity,
} from "../src/observability/index.js";

/**
 * A piece of instrumentation, written the way real code will write it: it
 * receives an Observability and knows nothing about where anything goes.
 */
function reportDroppedFrame(obs: Observability, reason: string, frameType: string): void {
  obs.logger("ws").emit({
    severityText: "WARN",
    body: "frame dropped",
    attributes: { reason, "frame.type": frameType },
  });
  obs.meter("ws").createCounter("ws.frames.dropped").add(1, { reason, direction: "inbound" });
}

describe("recording consumer", () => {
  test("captures what instrumentation emitted, queryably", () => {
    const obs = createRecordingObservability();

    reportDroppedFrame(obs, "parse_error", "chat_message");
    reportDroppedFrame(obs, "parse_error", "tool_approval");
    reportDroppedFrame(obs, "too_large", "chat_message");

    expect(obs.logs.count()).toBe(3);
    expect(obs.logs.count({ attributes: { reason: "parse_error" } })).toBe(2);
    expect(obs.logs.count({ scope: "ws", severity: "WARN" })).toBe(3);
    expect(obs.logs.count({ scope: "auth" })).toBe(0);

    const [first] = obs.logs.find({ attributes: { "frame.type": "tool_approval" } });
    expect(first.body).toBe("frame dropped");
    expect(first.attributes.reason).toBe("parse_error");
    expect(first.timestamp).toBeGreaterThan(0);
  });

  test("counters are readable per attribute set and in total", () => {
    const obs = createRecordingObservability();

    reportDroppedFrame(obs, "parse_error", "chat_message");
    reportDroppedFrame(obs, "parse_error", "tool_approval");
    reportDroppedFrame(obs, "too_large", "chat_message");

    expect(obs.metrics.value("ws.frames.dropped", { reason: "parse_error", direction: "inbound" })).toBe(2);
    expect(obs.metrics.value("ws.frames.dropped", { reason: "too_large", direction: "inbound" })).toBe(1);
    expect(obs.metrics.total("ws.frames.dropped")).toBe(3);
    expect(obs.metrics.value("ws.frames.dropped", { reason: "never" })).toBeUndefined();
  });

  test("a snapshot is JSON-safe, which is what /api/status needs", () => {
    const obs = createRecordingObservability();
    reportDroppedFrame(obs, "parse_error", "chat_message");

    const snapshot = obs.metrics.snapshot();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot[0]).toEqual({
      name: "ws.frames.dropped",
      attributes: { direction: "inbound", reason: "parse_error" },
      value: 1,
      kind: "counter",
    });
  });

  test("reset clears both signals, so tests do not leak into each other", () => {
    const obs = createRecordingObservability();
    reportDroppedFrame(obs, "parse_error", "chat_message");
    obs.reset();
    expect(obs.logs.count()).toBe(0);
    expect(obs.metrics.snapshot()).toEqual([]);
  });

  test("retention is bounded", () => {
    const obs = createObservability({
      loggerProvider: createRecordingLoggerProvider({ limit: 2 }),
    });
    for (const n of [1, 2, 3]) obs.logger("ws").emit({ severityText: "INFO", body: `m${n}` });
    expect(obs.logs!.records().map((r) => r.body)).toEqual(["m2", "m3"]);
  });
});

describe("console consumer", () => {
  test("formats to the [scope] message key=value shape the repo already uses", () => {
    const lines: string[] = [];
    const obs = createObservability({
      loggerProvider: createConsoleLoggerProvider({
        write: (_severity, line) => lines.push(line),
      }),
    });

    reportDroppedFrame(obs, "parse_error", "chat_message");

    expect(lines).toEqual([
      '[ws] frame dropped reason="parse_error" frame.type="chat_message"',
    ]);
  });

  test("severity routes to the matching console channel", () => {
    const seen: Array<[Severity, string]> = [];
    const obs = createObservability({
      loggerProvider: createConsoleLoggerProvider({
        minSeverity: "TRACE",
        write: (severity, line) => seen.push([severity, line]),
      }),
    });

    for (const severity of ["DEBUG", "INFO", "WARN", "ERROR"] as Severity[]) {
      obs.logger("x").emit({ severityText: severity, body: severity });
    }
    expect(seen.map(([s]) => s)).toEqual(["DEBUG", "INFO", "WARN", "ERROR"]);
  });

  test("records below the threshold never reach the writer", () => {
    const lines: string[] = [];
    const obs = createObservability({
      loggerProvider: createConsoleLoggerProvider({
        minSeverity: "WARN",
        write: (_s, line) => lines.push(line),
      }),
    });

    obs.logger("ws").emit({ severityText: "DEBUG", body: "noisy" });
    obs.logger("ws").emit({ severityText: "INFO", body: "also noisy" });
    obs.logger("ws").emit({ severityText: "ERROR", body: "kept" });

    expect(lines).toEqual(["[ws] kept"]);
  });
});

describe("swappability", () => {
  test("the same instrumentation feeds any consumer, unchanged", () => {
    // The point of the whole design: reportDroppedFrame is written once.
    const lines: string[] = [];
    const console_ = createObservability({
      loggerProvider: createConsoleLoggerProvider({ write: (_s, l) => lines.push(l) }),
    });
    const recording = createRecordingObservability();
    const silent = createSilentObservability();

    for (const obs of [console_, recording, silent]) {
      reportDroppedFrame(obs, "parse_error", "chat_message");
    }

    expect(lines.length).toBe(1);
    expect(recording.logs.count()).toBe(1);
    // Silent discards logs but still counts — metrics remain readable.
    expect(silent.logs).toBeUndefined();
    expect(silent.metrics!.total("ws.frames.dropped")).toBe(1);
  });

  test("two observabilities never share state", () => {
    // The regression the rest of this codebase keeps fixing: process-global
    // sinks that make two instances, or two tests, contaminate each other.
    const a = createRecordingObservability();
    const b = createRecordingObservability();

    reportDroppedFrame(a, "parse_error", "chat_message");

    expect(a.logs.count()).toBe(1);
    expect(b.logs.count()).toBe(0);
    expect(b.metrics.total("ws.frames.dropped")).toBe(0);
  });
});

describe("global installation", () => {
  test("is opt-in and reversible", () => {
    const obs = createRecordingObservability();

    // Before installing, the OTel globals are no-ops and record nothing.
    logs.getLogger("stray").emit({ severityText: "WARN", body: "before" });
    metrics.getMeter("stray").createCounter("stray.count").add(1);
    expect(obs.logs.count()).toBe(0);

    const restore = obs.installGlobally();
    try {
      // Code that cannot be handed an argument still reports somewhere.
      logs.getLogger("stray").emit({ severityText: "WARN", body: "during" });
      metrics.getMeter("stray").createCounter("stray.count").add(1);
      expect(obs.logs.count({ body: "during" })).toBe(1);
      expect(obs.metrics.total("stray.count")).toBe(1);
    } finally {
      restore();
    }

    // Restored: the process is back to no-ops, so one test cannot strand a
    // sink for the next one.
    logs.getLogger("stray").emit({ severityText: "WARN", body: "after" });
    expect(obs.logs.count({ body: "after" })).toBe(0);
  });
});

describe("primitives", () => {
  test("series keys are attribute-order independent", () => {
    expect(seriesKey("m", { b: 2, a: 1 })).toBe(seriesKey("m", { a: 1, b: 2 }));
    expect(seriesKey("m", {})).toBe("m");
    expect(seriesKey("m", { a: undefined })).toBe("m");
  });

  test("an unknown severity is treated as INFO rather than dropped", () => {
    expect(severityRank("NONSENSE")).toBe(severityRank("INFO"));
    expect(severityRank(undefined)).toBe(severityRank("INFO"));
  });

  test("non-scalar attributes are flattened, not printed as [object Object]", () => {
    const lines: string[] = [];
    const obs = createObservability({
      loggerProvider: createConsoleLoggerProvider({ write: (_s, l) => lines.push(l) }),
    });
    obs.logger("ws").emit({
      severityText: "INFO",
      body: "nested",
      attributes: { detail: { a: 1 } as never, gone: null as never },
    });
    expect(lines[0]).toBe('[ws] nested detail="{\\"a\\":1}"');
  });

  test("a gauge is a level, a counter accumulates", () => {
    const provider = createInMemoryMeterProvider();
    const meter = provider.getMeter("x");
    const gauge = meter.createGauge("queue.depth");
    const counter = meter.createCounter("queue.enqueued");

    gauge.record(5);
    gauge.record(2);
    counter.add(5);
    counter.add(2);

    expect(provider.value("queue.depth")).toBe(2);
    expect(provider.value("queue.enqueued")).toBe(7);
  });
});
