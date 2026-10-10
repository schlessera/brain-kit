/**
 * Execute one container-cron job while recording its status and activity.
 * Tracking is fail-open: database or activity failures never prevent the job
 * from running, and the wrapper always returns the child's exit code.
 */
import { unlinkSync } from "fs";

import { ingestSpanSink } from "../activity/span-sink.js";
import { createActivityStore } from "../activity/store.js";
import { createUiDb } from "../db/client.js";
import { startCronSpan } from "./activity.js";
import { recordCronRun } from "./scheduler.js";
import type { ExecWrapperConfig } from "@schlessera/brain-ui-sdk/server";
import { isSyncJob, TRUSTED_JOB_NAMES } from "./emit.js";
import { parseSyncResult, syncActivityAttrs, syncMessage } from "../brain/sync-result.js";
import { execWrapperSpawnOptions, wrapCommand } from "@schlessera/brain-ui-sdk/internal";

/** Tail of stderr retained for the cron_runs error row. */
export const STDERR_TAIL_CHARS = 2_000;
/** Tail of combined stdout/stderr retained as the job_output activity event. */
export const OUTPUT_TAIL_CHARS = 8_000;
/** Heartbeat cadence, comfortably inside the activity store's stale threshold. */
export const HEARTBEAT_MS = 30_000;
/** Child-visible path where span-sink JSONL may be appended. */
export const SPAN_SINK_ENV = "BRAIN_ACTIVITY_SPAN_SINK";
/**
 * The most stdout the `sync` job's result may hold. Past it the output is
 * passed through as it arrives and no result is read from it.
 */
export const SYNC_RESULT_MAX_CHARS = 8_000_000;

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
  /** `attrs` join the root span's own on its terminal write. */
  finish(error: string | undefined, output: string, exitCode: number, attrs?: Record<string, string>): void;
  close(): void;
}

export interface RunJobOptions {
  jobName: string;
  command: string[];
  dbPath: string;
  childEnv: Record<string, string | undefined>;
  /** The exec wrapper, resolved once at the cron bin's edge (`CronConfig.exec`). */
  exec: ExecWrapperConfig;
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

/**
 * A stdout sink that holds what the sync job prints until it has exited, so
 * the result can be read whole. Past {@link SYNC_RESULT_MAX_CHARS} it writes
 * everything through and `release` returns null: nothing is read from it.
 */
function holdStdout(sink: TextSink): TextSink & { release(): string | null } {
  let held = "";
  let passthrough = false;
  return {
    write(text: string) {
      if (passthrough) return sink.write(text);
      held += text;
      if (held.length <= SYNC_RESULT_MAX_CHARS) return undefined;
      passthrough = true;
      const out = held;
      held = "";
      return sink.write(out);
    },
    release: () => (passthrough ? null : held),
  };
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
    const { runId, rootSpanId } = startCronSpan(db, store, name);

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
      finish(error, output, exitCode, attrs) {
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
              ...attrs,
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
  // The base `sync` job, and only it, prints a sync result (#290): held here,
  // read, and logged as its readable report. Any other job's stdout, and a
  // sync line someone wrote by hand, is passed through untouched.
  const syncJob = isSyncJob(options.jobName, options.command);
  const held = syncJob ? holdStdout(stdout) : null;
  let spanAttrs: Record<string, string> | undefined = syncJob ? syncActivityAttrs(null) : undefined;

  try {
    const spawn = dependencies.spawn ?? ((command, spawnOptions) => Bun.spawn(command, spawnOptions));
    // Through the exec wrapper like every other child. A scheduled job runs a
    // command out of the brain repository, which makes it the same class of
    // input as an agent tool call — and the recorder around it stays outside
    // the wrapper, because it writes the server's own database.
    //
    // Except for the trusted jobs below, which ARE the server: the digest
    // opens and writes the UI database, so running it as a user that dropped
    // out of reach of that database breaks it. Wrapping is about repository
    // code, and the digest is not repository code.
    //
    // Trust is matched by NAME, which is only safe because the repository
    // cannot produce one: `emitCrontab` refuses a module job whose name is
    // in TRUSTED_JOB_NAMES (#81), and module jobs are namespaced
    // `<module>-<entry>` on top of that.
    const cronExec = TRUSTED_JOB_NAMES.has(options.jobName) ? {} : options.exec;
    const proc = spawn(wrapCommand(options.command, cronExec.wrapper), {
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...options.childEnv, [SPAN_SINK_ENV]: sinkPath },
      ...execWrapperSpawnOptions(cronExec.wrapper),
    });

    let stderrTail = "";
    let stdoutTail = "";
    const outcomes = await Promise.allSettled([
      teeStream(proc.stdout, held ?? stdout, (text) => {
        if (held) stdoutTail = appendTail(stdoutTail, text, OUTPUT_TAIL_CHARS);
        else outputTail = appendTail(outputTail, text, OUTPUT_TAIL_CHARS);
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
    if (held) {
      const text = held.release();
      const result = text === null ? null : parseSyncResult(text);
      const readable = result ? `${syncMessage(result)}\n` : text ?? "";
      if (readable) {
        try { await stdout.write(readable); } catch { /* Logging cannot stop the job. */ }
      }
      // Past the cap it was written as it came; its tail still belongs in the record.
      outputTail = appendTail(outputTail, text === null ? stdoutTail : readable, OUTPUT_TAIL_CHARS);
      spanAttrs = syncActivityAttrs(result);
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
      recorder.finish(errorMessage, outputTail.trim(), exitCode, spanAttrs);
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
