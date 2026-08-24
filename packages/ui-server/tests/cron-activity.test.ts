/**
 * Cron runs as activity: the wrapper's root span, the span-sink JSONL ingest
 * (AE7 — fixture-verified until core grows an agent loop), and the closed
 * cron-status name gap.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { createActivityStore } from "../src/activity/store";
import { ingestSpanSink } from "../src/activity/span-sink";
import { createUiDb } from "../src/db/client";
import { createCronScheduler, recordCronRun } from "../src/cron/scheduler";
import { createBrainClient } from "../src/brain/client";

function sinkDir(): string {
  return mkdtempSync(join(tmpdir(), "span-sink-"));
}

describe("span-sink ingest (AE7)", () => {
  test("a fixture sink produces child spans with usage under the cron root", () => {
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "cron" });
    store.startSpan({
      spanId: "root",
      runId: "run-1",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
      jobName: "sync",
    });
    const path = join(sinkDir(), "sink.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "span_start", spanId: "a1", name: "invoke_agent sync-step", kind: "subagent", ts: 100 }),
        JSON.stringify({ type: "span_start", spanId: "t1", parentSpanId: "a1", name: "execute_tool Read", ts: 110 }),
        JSON.stringify({ type: "event", spanId: "a1", eventType: "text", payload: "reading notes", ts: 115 }),
        JSON.stringify({ type: "span_end", spanId: "t1", outcome: "success", ts: 120 }),
        JSON.stringify({
          type: "span_end",
          spanId: "a1",
          outcome: "success",
          ts: 130,
          usage: { inputTokens: 500, outputTokens: 100, costUsd: 0.02, model: "claude-fable-5" },
        }),
        "",
      ].join("\n")
    );

    const result = ingestSpanSink(store, path, { runId: "run-1", rootSpanId: "root", jobName: "sync" });
    expect(result.ingested).toBe(5);
    expect(result.skipped).toBe(0);

    const snap = store.snapshotRun("run-1")!;
    expect(snap.spans).toHaveLength(3);
    const agent = store.getSpan("run-1:a1")!;
    expect(agent.parentSpanId).toBe("root");
    expect(agent.kind).toBe("subagent");
    expect(agent.usage.inputTokens).toBe(500);
    const tool = store.getSpan("run-1:t1")!;
    expect(tool.parentSpanId).toBe("run-1:a1");
    expect(tool.outcome).toBe("success");
    expect(snap.events).toHaveLength(1);
  });

  test("incremental ingest consumes only complete lines and resumes by offset", () => {
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "cron" });
    store.startSpan({
      spanId: "root",
      runId: "run-1",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
    });
    const path = join(sinkDir(), "sink.jsonl");
    writeFileSync(
      path,
      JSON.stringify({ type: "span_start", spanId: "a1", name: "step" }) +
        "\n" +
        '{"type":"span_end","spanId":"a1","outc' // torn write
    );
    const first = ingestSpanSink(store, path, { runId: "run-1", rootSpanId: "root" });
    expect(first.ingested).toBe(1);
    expect(store.getSpan("run-1:a1")!.outcome).toBeNull();

    appendFileSync(path, 'ome":"success"}\n');
    const second = ingestSpanSink(store, path, { runId: "run-1", rootSpanId: "root" }, first.offset);
    expect(second.ingested).toBe(1);
    expect(store.getSpan("run-1:a1")!.outcome).toBe("success");
  });

  test("malformed lines and unknown outcomes are skipped, never fatal", () => {
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "cron" });
    store.startSpan({
      spanId: "root",
      runId: "run-1",
      name: "cron sync",
      kind: "cron",
      origin: "cron",
    });
    const path = join(sinkDir(), "sink.jsonl");
    writeFileSync(
      path,
      [
        "not json at all",
        JSON.stringify({ type: "span_end", spanId: "ghost", outcome: "exploded" }),
        JSON.stringify({ type: "span_start", spanId: "ok", name: "step" }),
        "",
      ].join("\n")
    );
    const result = ingestSpanSink(store, path, { runId: "run-1", rootSpanId: "root" });
    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(2);
    expect(store.getSpan("run-1:ok")).not.toBeNull();
  });

  test("a missing sink file is an empty result", () => {
    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "cron" });
    const result = ingestSpanSink(store, "/nonexistent/sink.jsonl", {
      runId: "r",
      rootSpanId: "root",
    });
    expect(result).toEqual({ offset: 0, ingested: 0, skipped: 0 });
  });
});

describe("cron status name gap", () => {
  test("status lists every recorded job name, in-process names included", () => {
    const db = createUiDb(":memory:");
    // Module jobs and maintain arrive only through the external recorder.
    recordCronRun(db, "maintain").finish();
    recordCronRun(db, "jobs-scrape").finish("boom");
    const cron = createCronScheduler({
      db,
      brain: createBrainClient({ brainPath: "/nonexistent" }),
    });
    const status = cron.getCronStatus();
    const names = status.map((s) => s.name);
    expect(names).toContain("sync");
    expect(names).toContain("validate");
    expect(names).toContain("maintain");
    expect(names).toContain("jobs-scrape");
    expect(status.find((s) => s.name === "jobs-scrape")!.lastStatus).toBe("error");
    expect(status.find((s) => s.name === "sync")!.lastRunAt).toBeNull();
  });
});
