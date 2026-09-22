import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  OUTPUT_TAIL_CHARS,
  SPAN_SINK_ENV,
  STDERR_TAIL_CHARS,
  runJob,
} from "../src/cron/run-job";
import { createUiDb } from "../src/db/client";

function textSink() {
  let text = "";
  return {
    sink: { write(chunk: string) { text += chunk; } },
    read: () => text,
  };
}

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

// The names and sizes below are the contract with the deployed crontab and the
// activity store, not implementation detail. Asserting them through the
// module's own exported constants would move the expectation along with the
// code, so pin the literals once here and check the exports against them.
const WIRE_SPAN_SINK_ENV = "BRAIN_ACTIVITY_SPAN_SINK";
const WIRE_STDERR_TAIL_CHARS = 2000;
const WIRE_OUTPUT_TAIL_CHARS = 8000;

describe("cron wrapper constants", () => {
  test("the span-sink variable and both tail caps keep their published values", () => {
    expect(SPAN_SINK_ENV).toBe(WIRE_SPAN_SINK_ENV);
    expect(STDERR_TAIL_CHARS).toBe(WIRE_STDERR_TAIL_CHARS);
    expect(OUTPUT_TAIL_CHARS).toBe(WIRE_OUTPUT_TAIL_CHARS);
  });
});

describe("cron runJob", () => {
  test("attributes recorded cron activity to the system principal, never an owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-ui-cron-principal-"));
    const dbPath = join(dir, "brain-ui.db");
    try {
      expect(
        await runJob(
          {
            jobName: "maintain",
            command: ["job"],
            dbPath,
            childEnv: {},
            stdout: textSink().sink,
            stderr: textSink().sink,
          },
          {
            sinkPath: join(dir, "sink.jsonl"),
            spawn: () => ({
              stdout: stream(),
              stderr: stream(),
              exited: Promise.resolve(0),
              signalCode: null,
            }),
          }
        )
      ).toBe(0);

      const db = createUiDb(dbPath);
      const rollup = db.query("SELECT * FROM activity_run_rollups").get() as any;
      const principal = db
        .query("SELECT id, kind, label FROM principals WHERE id = ?")
        .get(rollup.principal_id) as any;
      expect(principal).toEqual({
        id: rollup.principal_id,
        kind: "system",
        label: "Scheduled jobs",
      });
      expect(rollup.principal_kind).toBe("system");
      expect(rollup.principal_label).toBe("Scheduled jobs");
      expect(
        db.query("SELECT COUNT(*) AS count FROM principals WHERE kind = 'owner'").get()
      ).toEqual({ count: 0 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DB-open failure warns but still runs and propagates the child exit code", async () => {
    const stdout = textSink();
    const stderr = textSink();
    const exitCode = await runJob(
      {
        jobName: "untracked",
        command: ["job"],
        dbPath: `/tmp/brain-ui-cron-missing-${process.pid}-${Date.now()}/brain-ui.db`,
        childEnv: {},
        stdout: stdout.sink,
        stderr: stderr.sink,
      },
      {
        sinkPath: `/tmp/brain-ui-cron-no-sink-${process.pid}.jsonl`,
        spawn: () => ({
          stdout: stream("job stdout\n"),
          stderr: stream("job stderr\n"),
          exited: Promise.resolve(23),
          signalCode: null,
        }),
      }
    );

    expect(exitCode).toBe(23);
    expect(stdout.read()).toBe("job stdout\n");
    expect(stderr.read()).toContain("[cron-run] tracking unavailable (job runs anyway):");
    expect(stderr.read().endsWith("job stderr\n")).toBe(true);
  });

  test("tees both streams verbatim and exports the span sink to the argv child", async () => {
    const stdout = textSink();
    const stderr = textSink();
    let childEnv: Record<string, string | undefined> | undefined;
    let recorded: { error: string | undefined; output: string; exitCode: number } | undefined;

    const exitCode = await runJob(
      {
        jobName: "tee",
        command: ["first", "two words"],
        dbPath: ":memory:",
        childEnv: { PRESERVED: "yes" },
        stdout: stdout.sink,
        stderr: stderr.sink,
      },
      {
        sinkPath: "/tmp/brain-ui-cron-test-sink.jsonl",
        startRecord: async () => ({
          finish(error, output, code) {
            recorded = { error, output, exitCode: code };
          },
          close() {},
        }),
        spawn: (_command, options) => {
          childEnv = options.env;
          return {
            stdout: stream("out", "put\n"),
            stderr: stream("err", "or\n"),
            exited: Promise.resolve(0),
            signalCode: null,
          };
        },
        removeSink() {},
      }
    );

    expect(exitCode).toBe(0);
    expect(stdout.read()).toBe("output\n");
    expect(stderr.read()).toBe("error\n");
    expect(childEnv?.PRESERVED).toBe("yes");
    expect(childEnv?.[WIRE_SPAN_SINK_ENV]).toBe("/tmp/brain-ui-cron-test-sink.jsonl");
    expect(recorded?.exitCode).toBe(0);
    expect(recorded?.error).toBeUndefined();
    // The combined tail is what Activity shows for the run, so it must carry
    // BOTH streams. The two streams are read concurrently and the tail is
    // appended per chunk, so their interleaving is not deterministic here —
    // the length is: every byte of both streams is present, and dropping
    // either one would show up immediately. The tail is trimmed before it is
    // recorded (as the original wrapper did), which is why the trailing
    // newline is not counted.
    expect(recorded?.output).toHaveLength("output\nerror\n".trim().length);
  });

  test("keeps capped tails, not heads, for stderr and combined output", async () => {
    const stderrText =
      "stderr-head:" + "s".repeat(WIRE_OUTPUT_TAIL_CHARS + 50) + ":stderr-tail";
    let recorded: { error: string | undefined; output: string } | undefined;

    const exitCode = await runJob(
      {
        jobName: "tails",
        command: ["job"],
        dbPath: ":memory:",
        childEnv: {},
        stdout: textSink().sink,
        stderr: textSink().sink,
      },
      {
        startRecord: async () => ({
          finish(error, output) {
            recorded = { error, output };
          },
          close() {},
        }),
        spawn: () => ({
          stdout: stream(),
          stderr: stream(stderrText),
          exited: Promise.resolve(9),
          signalCode: null,
        }),
        removeSink() {},
      }
    );

    expect(exitCode).toBe(9);
    const stderrTail = stderrText.slice(-WIRE_STDERR_TAIL_CHARS);
    expect(recorded?.error).toBe(`exit code 9; stderr tail: ${stderrTail}`);
    expect(recorded?.error).not.toContain("stderr-head:");
    expect(recorded?.output).toHaveLength(WIRE_OUTPUT_TAIL_CHARS);
    expect(recorded?.output?.endsWith(":stderr-tail")).toBe(true);
    expect(recorded?.output).not.toContain("stderr-head:");
  });

  test("a stdout-only job overflows the combined tail from its own stream", async () => {
    // Without this case, a wrapper that only ever captured stderr into the
    // combined tail would pass every other assertion in this file.
    const stdoutText =
      "stdout-head:" + "o".repeat(WIRE_OUTPUT_TAIL_CHARS + 50) + ":stdout-tail";
    let recorded: { error: string | undefined; output: string } | undefined;

    const exitCode = await runJob(
      {
        jobName: "stdout-tail",
        command: ["job"],
        dbPath: ":memory:",
        childEnv: {},
        stdout: textSink().sink,
        stderr: textSink().sink,
      },
      {
        startRecord: async () => ({
          finish(error, output) {
            recorded = { error, output };
          },
          close() {},
        }),
        spawn: () => ({
          stdout: stream(stdoutText),
          stderr: stream(),
          exited: Promise.resolve(0),
          signalCode: null,
        }),
        removeSink() {},
      }
    );

    expect(exitCode).toBe(0);
    expect(recorded?.error).toBeUndefined();
    expect(recorded?.output).toHaveLength(WIRE_OUTPUT_TAIL_CHARS);
    expect(recorded?.output).toBe(stdoutText.slice(-WIRE_OUTPUT_TAIL_CHARS));
    expect(recorded?.output).not.toContain("stdout-head:");
  });

  test("both streams land in the combined tail, in arrival order", async () => {
    // Ordering is only deterministic when the two streams do not interleave, so
    // stdout is fully drained before stderr produces anything.
    let releaseStderr: () => void = () => {};
    const stderrGate = new Promise<void>((resolve) => {
      releaseStderr = resolve;
    });
    let recorded: { error: string | undefined; output: string } | undefined;

    const exitCode = await runJob(
      {
        jobName: "mixed",
        command: ["job"],
        dbPath: ":memory:",
        childEnv: {},
        stdout: textSink().sink,
        stderr: textSink().sink,
      },
      {
        startRecord: async () => ({
          finish(error, output) {
            recorded = { error, output };
          },
          close() {},
        }),
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first-out\n"));
              controller.close();
              releaseStderr();
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            async start(controller) {
              await stderrGate;
              controller.enqueue(new TextEncoder().encode("then-err\n"));
              controller.close();
            },
          }),
          exited: Promise.resolve(3),
          signalCode: null,
        }),
        removeSink() {},
      }
    );

    expect(exitCode).toBe(3);
    expect(recorded?.output).toContain("first-out");
    expect(recorded?.output).toContain("then-err");
    expect(recorded!.output.indexOf("first-out")).toBeLessThan(
      recorded!.output.indexOf("then-err")
    );
  });
});


describe("cron lifecycle recovery", () => {
  test("a broken output sink does not finish before the real child exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "cron-lifecycle-"));
    const marker = join(root, "finished");
    let closed = false;
    let recorded: { finished: boolean; code: number; error?: string; output: string } | undefined;
    try {
      const code = await runJob({
        jobName: "fixture", dbPath: ":memory:", childEnv: {},
        command: [process.execPath, "-e", `console.log('start'); await Bun.sleep(50); await Bun.write(${JSON.stringify(marker)}, 'done'); console.log('end'); process.exit(7);`],
        stdout: { write() { throw new Error("disconnected"); } }, stderr: textSink().sink,
      }, {
        startRecord: async () => ({
          finish(error, output, exitCode) {
            recorded = { finished: existsSync(marker), code: exitCode, error, output };
          },
          close() { closed = true; },
        }), removeSink() {},
      });
      expect(code).toBe(7);
      expect(recorded?.finished).toBe(true);
      expect(recorded?.code).toBe(7);
      expect(recorded?.error).toContain("exit code 7");
      expect(recorded?.output).toContain("end");
      expect(closed).toBe(true);
      expect(existsSync(marker)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("stream and recorder errors preserve the exit code and still clean up", async () => {
    let closed = false;
    let removed = false;
    const code = await runJob({ jobName: "fixture", command: ["job"], dbPath: ":memory:", childEnv: {}, stderr: textSink().sink }, {
      startRecord: async () => ({ finish() { throw new Error("DB failure"); }, close() { closed = true; } }),
      spawn: () => ({ stdout: new ReadableStream({ start(c) { c.error(new Error("read failed")); } }), stderr: stream(), exited: Promise.resolve(9), signalCode: null }),
      removeSink() { removed = true; },
    });
    expect(code).toBe(9);
    expect(closed).toBe(true);
    expect(removed).toBe(true);
  });
});

/**
 * Scheduled jobs run commands out of the brain repository, which is the same
 * class of input as an agent tool call. A review of the exec-wrapper branch
 * found cron still launching them directly — a path around the boundary that
 * the rest of the work had just closed.
 */
describe("cron runs jobs through the exec wrapper", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.BRAIN_UI_EXEC_WRAPPER;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.BRAIN_UI_EXEC_WRAPPER;
    else process.env.BRAIN_UI_EXEC_WRAPPER = previous;
  });

  async function commandSeenBySpawn(command: string[]): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "brain-ui-cron-wrapper-"));
    let seen: string[] = [];
    try {
      await runJob(
        {
          jobName: "maintain",
          command,
          dbPath: join(dir, "brain-ui.db"),
          childEnv: {},
          stdout: textSink().sink,
          stderr: textSink().sink,
        },
        {
          sinkPath: join(dir, "sink.jsonl"),
          spawn: (cmd) => {
            seen = [...cmd];
            return {
              stdout: stream(),
              stderr: stream(),
              exited: Promise.resolve(0),
              signalCode: null,
            };
          },
        }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return seen;
  }

  test("prepends the wrapper and makes the command absolute", async () => {
    process.env.BRAIN_UI_EXEC_WRAPPER = "/opt/run-as-agent";
    expect(await commandSeenBySpawn(["/bin/echo", "hello"])).toEqual([
      "/opt/run-as-agent",
      "/bin/echo",
      "hello",
    ]);
  });

  test("leaves the command untouched when no wrapper is configured", async () => {
    delete process.env.BRAIN_UI_EXEC_WRAPPER;
    expect(await commandSeenBySpawn(["job", "--flag"])).toEqual(["job", "--flag"]);
  });
});
