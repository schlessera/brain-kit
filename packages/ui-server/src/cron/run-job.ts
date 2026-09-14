/**
 * Execute one container-cron job while recording its status and activity.
 * Tracking is fail-open: database or activity failures never prevent the job
 * from running, and the wrapper always returns the child's exit code.
 */
import { unlinkSync } from "fs";

import { ingestSpanSink } from "../activity/span-sink.js";
import { createActivityStore } from "../activity/store.js";
import { createUiDb } from "../db/client.js";
import { recordCronRun } from "./scheduler.js";

/** Tail of stderr retained for the cron_runs error row. */
export const STDERR_TAIL_CHARS = 2_000;
/** Tail of combined stdout/stderr retained as the job_output activity event. */
export const OUTPUT_TAIL_CHARS = 8_000;
/** Heartbeat cadence, comfortably inside the activity store's stale threshold. */
export const HEARTBEAT_MS = 30_000;
/** Child-visible path where span-sink JSONL may be appended. */
export const SPAN_SINK_ENV = "BRAIN_ACTIVITY_SPAN_SINK";

interface TextSink {
  write(text: string): unknown;
}

interface SpawnedJob {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  signalCode: string | null;
}

interface RunRecorder {
  finish(error: string | undefined, output: string, exitCode: number): void;
  close(): void;
}

export interface RunJobOptions {
  jobName: string;
  command: string[];
  dbPath: string;
  childEnv: Record<string, string | undefined>;
  stdout?: TextSink;
  stderr?: TextSink;
}

export interface RunJobDependencies {
  spawn?: (
    command: string[],
    options: {
      stdin: "inherit";
      stdout: "pipe";
      stderr: "pipe";
      env: Record<string, string | undefined>;
    }
  ) => SpawnedJob;
  sinkPath?: string;
  startRecord?: (
    name: string,
    sinkPath: string,
    command: string[],
    dbPath: string,
    stderr: TextSink
  ) => Promise<RunRecorder | null>;
  removeSink?: (path: string) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeLine(sink: TextSink, text: string): void {
  try { sink.write(`${text}\n`); } catch { /* Logging cannot stop the job. */ }
}

/** Forward a stream verbatim while exposing decoded chunks for tail capture. */
export async function teeStream(
  stream: ReadableStream<Uint8Array>,
  sink: TextSink,
  onText: (text: string) => void
): Promise<void> {
  const decoder = new TextDecoder();
  let forwarding = true;
  const forward = async (text: string) => {
    onText(text);
    if (!forwarding) return;
    try { await sink.write(text); } catch { forwarding = false; }
  };
  for await (const chunk of stream) {
    await forward(decoder.decode(chunk, { stream: true }));
  }
  const trailing = decoder.decode();
  if (trailing) await forward(trailing);
}

/** Keep the last `cap` characters, never the head. */
export function appendTail(current: string, text: string, cap: number): string {
  return (current + text).slice(-cap);
}

async function startRecord(
  name: string,
  sinkPath: string,
  command: string[],
  dbPath: string,
  stderr: TextSink
): Promise<RunRecorder | null> {
  let db: ReturnType<typeof createUiDb> | undefined;
  try {
    db = createUiDb(dbPath);
    const openedDb = db;
    const record = recordCronRun(db, name);
    const store = createActivityStore(db, { writer: `cron:${process.pid}` });
    const runId = `cron-${name}-${Date.now()}`;
    const rootSpanId = `${runId}:root`;
    store.startSpan({
      spanId: rootSpanId,
      runId,
      name: `cron ${name}`,
      kind: "cron",
      origin: "cron",
      jobName: name,
    });

    let sinkOffset = 0;
    const ingest = () => {
      try {
        const result = ingestSpanSink(
          store,
          sinkPath,
          { runId, rootSpanId, jobName: name },
          sinkOffset
        );
        sinkOffset = result.offset;
      } catch {
        // Sink lines are best-effort enrichment.
      }
    };

    const heartbeat = setInterval(() => {
      try {
        store.heartbeat(rootSpanId);
      } catch {
        // Tracking remains fail-open after startup too.
      }
      ingest();
    }, HEARTBEAT_MS);

    return {
      finish(error, output, exitCode) {
        record.finish(error);
        try {
          ingest();
          if (output) {
            try {
              store.appendEvent(rootSpanId, "job_output", output, undefined, OUTPUT_TAIL_CHARS);
            } catch {
              // Output capture is enrichment; never fail a run over it.
            }
          }
          store.endSpan(rootSpanId, {
            outcome: error === undefined ? "success" : "error",
            reason: error,
            attrs: {
              "cron.command": command.join(" "),
              "cron.exit_code": exitCode,
            },
          });
          store.cascadeClose(runId, "cancelled", "job finished");
          store.rollupRun(runId);
        } catch (error) {
          writeLine(stderr, `[cron-run] failed to close activity span: ${messageOf(error)}`);
        } finally {
          clearInterval(heartbeat);
        }
      },
      close() {
        clearInterval(heartbeat);
        openedDb.close();
      },
    };
  } catch (error) {
    try { db?.close(); } catch { /* Preserve fail-open tracking. */ }
    writeLine(
      stderr,
      `[cron-run] tracking unavailable (job runs anyway): ${messageOf(error)}`
    );
    return null;
  }
}

/** Run a job as argv (never through a shell) and return its exact exit code. */
export async function runJob(
  options: RunJobOptions,
  dependencies: RunJobDependencies = {}
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const sinkPath =
    dependencies.sinkPath ??
    `/tmp/brain-activity-sink-${process.pid}-${Date.now()}.jsonl`;
  const beginRecord = dependencies.startRecord ?? startRecord;
  let recorder: RunRecorder | null = null;
  try {
    recorder = await beginRecord(options.jobName, sinkPath, options.command, options.dbPath, stderr);
  } catch (error) {
    writeLine(stderr, `[cron-run] tracking unavailable (job runs anyway): ${messageOf(error)}`);
  }

  let exitCode: number;
  let errorMessage: string | undefined;
  let outputTail = "";

  try {
    const spawn = dependencies.spawn ?? ((command, spawnOptions) => Bun.spawn(command, spawnOptions));
    const proc = spawn(options.command, {
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...options.childEnv, [SPAN_SINK_ENV]: sinkPath },
    });

    let stderrTail = "";
    const outcomes = await Promise.allSettled([
      teeStream(proc.stdout, stdout, (text) => {
        outputTail = appendTail(outputTail, text, OUTPUT_TAIL_CHARS);
      }),
      teeStream(proc.stderr, stderr, (text) => {
        stderrTail = appendTail(stderrTail, text, STDERR_TAIL_CHARS);
        outputTail = appendTail(outputTail, text, OUTPUT_TAIL_CHARS);
      }),
      proc.exited,
    ]);
    for (const outcome of outcomes.slice(0, 2)) {
      if (outcome.status === "rejected") {
        writeLine(stderr, `[cron-run] output capture failed: ${messageOf(outcome.reason)}`);
      }
    }
    const child = outcomes[2]!;
    if (child.status === "rejected") throw child.reason;
    exitCode = child.value;
    if (exitCode !== 0) {
      const cause = proc.signalCode ? `killed by ${proc.signalCode}` : `exit code ${exitCode}`;
      const trimmedTail = stderrTail.trim();
      errorMessage = trimmedTail ? `${cause}; stderr tail: ${trimmedTail}` : cause;
    }
  } catch (error) {
    exitCode = 127;
    errorMessage = messageOf(error);
    writeLine(stderr, `[cron-run] failed to start job command: ${errorMessage}`);
  }

  if (recorder) {
    try {
      recorder.finish(errorMessage, outputTail.trim(), exitCode);
    } catch (error) {
      writeLine(stderr, `[cron-run] failed to record run outcome: ${messageOf(error)}`);
    } finally {
      try { recorder.close(); } catch (error) {
        writeLine(stderr, `[cron-run] failed to close tracking: ${messageOf(error)}`);
      }
    }
  }

  try {
    (dependencies.removeSink ?? unlinkSync)(sinkPath);
  } catch {
    // Never emitted, or already gone.
  }

  return exitCode;
}
