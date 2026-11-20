/**
 * A UI sync's admission is bounded and its outcome survives the client
 * (#4257). A launch that never settles used to hold the brain's
 * `syncingRoots` entry until the server restarted, so every later Sync got
 * 409 with no process running; and a sync whose reader had disconnected left
 * its failure only in the closed stream.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, LogRecord } from "@opentelemetry/api-logs";
import { createBrainRoutes } from "../src/routes/brain";
import { createActivityStore } from "../src/activity/store.js";
import { createUiDb } from "../src/db/client.js";
import type { BrainClient } from "../src/brain/client";
import type { HostBoundary, StreamingExecution } from "../src/brain/host-boundary";
import type { KeytermSettings } from "../src/voice/keyterm-builder";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function brainRoot() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-sync-bound-"));
  roots.push(root);
  return root;
}

/** Read an SSE body to its end, or give up after `ms` with what arrived. */
async function readFor(response: Response, ms: number): Promise<{ text: string; ended: boolean }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const next = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null)]);
    if (next === null) break;
    if (next.done) return { text, ended: true };
    text += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return { text, ended: false };
}

const frames = (text: string) => text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);

/** A child process stand-in whose output and exit the test controls. */
function fakeProcess(lines: string[], exitCode: number) {
  let killed: string | undefined;
  const encoder = new TextEncoder();
  const proc: StreamingExecution & { killedWith(): string | undefined } = {
    stdout: new ReadableStream({ start(controller) { for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`)); controller.close(); } }),
    stderr: new ReadableStream({ start(controller) { controller.close(); } }),
    exited: Promise.resolve(exitCode),
    signalCode: null,
    kill(signal) { killed = signal ?? "SIGTERM"; },
    killedWith: () => killed,
  };
  return proc;
}

function routes(root: string, launch: HostBoundary["launch"], extra: Partial<Parameters<typeof createBrainRoutes>[0]> = {}) {
  return createBrainRoutes({
    brainPath: root,
    brain: { cliCommand: () => [process.execPath, "sync.ts"] } as BrainClient,
    keyterms: { brainPath: root } as KeytermSettings, exec: {},
    boundary: { launch } as HostBoundary,
    ...extra,
  });
}

describe("bounded sync launch (#4257)", () => {
  test("a launch that never settles ends with a named refusal and frees the brain for the next sync", async () => {
    const root = brainRoot();
    const signals: (AbortSignal | undefined)[] = [];
    let calls = 0;
    const app = routes(root, async execution => {
      calls++;
      signals.push(execution.signal);
      if (calls === 1) return new Promise<never>(() => {});
      execution.onExecute?.();
      return fakeProcess(["Synced Ithaca"], 0);
    }, { syncLaunchTimeoutMs: 50 });

    const first = await app.request("/brain/sync", { method: "POST" });
    expect(first.status).toBe(200);
    const stalled = await readFor(first, 2_000);
    expect(stalled.ended, "STALLED_STREAM_ENDS").toBe(true);
    const done = frames(stalled.text).find(frame => frame.type === "done");
    expect(done, "STALLED_DONE_FRAME").toMatchObject({ type: "done", success: false, reason: "launch_timeout" });
    expect(String(done!.text)).toContain("did not start");
    expect(signals[0]?.aborted, "STALLED_LAUNCH_ABORTED").toBe(true);

    const next = await app.request("/brain/sync", { method: "POST" });
    expect(next.status, "NEXT_SYNC_ADMITTED").toBe(200);
    expect(frames((await readFor(next, 2_000)).text).at(-1)).toMatchObject({ type: "done", success: true });
  });

  test("a launch that settles after its bound has its process killed", async () => {
    const root = brainRoot();
    let settle!: (proc: StreamingExecution) => void;
    const late = fakeProcess([], 0);
    const app = routes(root, () => new Promise<StreamingExecution>(resolve => { settle = resolve; }), { syncLaunchTimeoutMs: 20 });
    const response = await app.request("/brain/sync", { method: "POST" });
    expect(frames((await readFor(response, 2_000)).text).at(-1)).toMatchObject({ reason: "launch_timeout" });
    settle(late);
    await Bun.sleep(10);
    expect(late.killedWith(), "LATE_PROCESS_KILLED").toBe("SIGTERM");
  });

  test("a hosted launch that returns before its first worker starts is bounded until that start", async () => {
    const root = brainRoot();
    // A hosted sync's launch returns at once; its mirror lock, startup view and
    // origin probe follow inside the returned process. Here they never finish.
    const pending = { ...fakeProcess([], 0), exited: new Promise<number>(() => {}) };
    let killed: string | undefined;
    pending.kill = signal => { killed = signal ?? "SIGTERM"; };
    let calls = 0;
    const app = routes(root, async execution => {
      calls++;
      if (calls === 1) return pending;
      execution.onExecute?.();
      return fakeProcess(["Synced Ithaca"], 0);
    }, { syncLaunchTimeoutMs: 50 });
    const first = await readFor(await app.request("/brain/sync", { method: "POST" }), 2_000);
    expect(first.ended, "PRESTART_STREAM_ENDS").toBe(true);
    expect(frames(first.text).at(-1), "PRESTART_REFUSED").toMatchObject({ type: "done", success: false, reason: "launch_timeout" });
    expect(killed, "PRESTART_KILLED").toBe("SIGTERM");
    const next = await app.request("/brain/sync", { method: "POST" });
    expect(next.status, "PRESTART_NEXT_ADMITTED").toBe(200);
    expect(frames((await readFor(next, 2_000)).text).at(-1)).toMatchObject({ type: "done", success: true });
  });

  test("a sync whose process exited while its output pipe stays open still releases the brain", async () => {
    const root = brainRoot();
    const encoder = new TextEncoder();
    let calls = 0;
    const app = routes(root, async execution => {
      calls++;
      execution.onExecute?.();
      if (calls > 1) return fakeProcess([], 0);
      // A descendant holds stdout open after the sync itself exited.
      return {
        // Its cancel drains to EOF, as the host boundary's admission-retaining stream does.
        stdout: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode("Pulled Ithaca\n")); }, cancel: () => new Promise<void>(() => {}) }),
        stderr: new ReadableStream({ start(controller) { controller.close(); } }),
        exited: Promise.resolve(0), signalCode: null, kill() {},
      };
    }, { syncOutputGraceMs: 30 });
    const first = await readFor(await app.request("/brain/sync", { method: "POST" }), 2_000);
    expect(first.ended, "HELD_PIPE_STREAM_ENDS").toBe(true);
    expect(frames(first.text).at(-1)).toMatchObject({ type: "done", success: true });
    expect(first.text).toContain("Pulled Ithaca");
    expect((await app.request("/brain/sync", { method: "POST" })).status, "HELD_PIPE_NEXT_ADMITTED").toBe(200);
  });

  test("a 409 names how long the current sync has held the brain", async () => {
    const root = brainRoot();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const app = routes(root, async () => { await held; return fakeProcess([], 0); });
    const first = await app.request("/brain/sync", { method: "POST" });
    await Bun.sleep(30);
    const busy = await app.request("/brain/sync", { method: "POST" });
    expect(busy.status).toBe(409);
    const body = await busy.json() as { error: string; heldMs: number };
    expect(body.heldMs, "BUSY_HELD_MS").toBeGreaterThanOrEqual(25);
    expect(body.error).toMatch(/already running .*held the brain for \d+ s/);
    release();
    await readFor(first, 2_000);
  });

  test("a sync whose reader disconnected records its exit and last error lines in Activity and logs the failure", async () => {
    const root = brainRoot();
    const db = createUiDb(":memory:");
    try {
      const store = createActivityStore(db);
      const records: LogRecord[] = [];
      const log = { emit: (record: LogRecord) => { records.push(record); }, enabled: () => true } as unknown as Logger;
      let finish!: () => void;
      const gate = new Promise<void>(resolve => { finish = resolve; });
      const encoder = new TextEncoder();
      let exit!: (code: number) => void;
      const exited = new Promise<number>(resolve => { exit = resolve; });
      const app = routes(root, async execution => (execution.onExecute?.(), {
        stdout: new ReadableStream({ async start(controller) {
          controller.enqueue(encoder.encode("Pulling the Ithaca remote\n"));
          await gate;
          controller.enqueue(encoder.encode("error: maintenance output cannot change protected input context/policies/governance.md\n"));
          controller.close();
          exit(1);
        } }),
        stderr: new ReadableStream({ start(controller) { controller.close(); } }),
        exited, signalCode: null, kill() {},
      }), { activity: store, log });

      const response = await app.request("/brain/sync", { method: "POST" });
      await readFor(response, 100);
      finish();
      await exited;
      const deadline = Date.now() + 2_000;
      let root_: ReturnType<typeof store.openRootSpans>[number] | undefined;
      let ended = null as ReturnType<typeof store.getSpan>;
      while (Date.now() < deadline) {
        root_ = store.changesSince(0).flatMap(change => change.kind === "span" ? [change.span] : []).find(span => span.jobName === "ui-sync");
        ended = root_ ? store.getSpan(root_.spanId) : null;
        if (ended?.endedAt) break;
        await Bun.sleep(10);
      }
      expect(ended, "UI_SYNC_RUN_RECORDED").toMatchObject({ jobName: "ui-sync", outcome: "error" });
      expect(ended!.outcomeReason ?? "", "UI_SYNC_RUN_REASON").toContain("cannot change protected input context/policies/governance.md");
      expect(ended!.outcomeReason ?? "").toContain("exit 1");
      const output = store.snapshotRun(ended!.runId)!.events.find(event => event.eventType === "job_output");
      expect(JSON.stringify(output?.payload), "UI_SYNC_OUTPUT_TAIL").toContain("Pulling the Ithaca remote");
      const failure = records.find(record => record.body === "ui sync failed");
      expect(failure, "UI_SYNC_FAILURE_LOGGED").toBeDefined();
      expect(String(failure!.attributes?.error)).toContain("cannot change protected input context/policies/governance.md");
    } finally { db.close(); }
  });
});
