import { describe, expect, test } from "bun:test";

import {
  OUTPUT_TAIL_CHARS,
  SPAN_SINK_ENV,
  STDERR_TAIL_CHARS,
  runJob,
} from "../src/cron/run-job";

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
