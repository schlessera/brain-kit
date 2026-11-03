/**
 * Module discovery for the emitted crontab (#3381).
 *
 * `brain-ui-cron crontab` runs once, at container start, and only the module
 * jobs it finds then are scheduled until the next start. A discovery that
 * fails while the host is still settling used to fall back to core jobs
 * silently. Here each failed attempt names its cause, discovery is retried a
 * bounded number of times, and the final outcome is recorded where an
 * operator looks: a `modules` run in `cron_runs` (`/api/status` `cronJobs`)
 * and a matching `cron` root span in Activity.
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "fs";

import { createActivityStore } from "../activity/store.js";
import { assertOperationalStateOutsideBrain } from "../brain/operational-state.js";
import { createUiDb } from "../db/client.js";
import { brainCommandClass, type HostBoundary } from "../brain/host-boundary.js";
import type { BrainModuleListPayload } from "./emit.js";
import { startCronSpan } from "./activity.js";
import { recordCronRun } from "./scheduler.js";

/**
 * The job name the discovery outcome is recorded under. It has no `-`, so no
 * module job (always `<module>-<entry>`) can carry it.
 */
export const MODULE_DISCOVERY_JOB_NAME = "modules";

/**
 * Waits before the second and third attempts. Three attempts over about
 * twenty seconds cover a host whose native readiness is still settling at
 * boot, without holding the cron service's start for long.
 */
export const MODULE_DISCOVERY_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000];

/** The most of a failed `brain module list`'s stderr a cause carries. */
const DISCOVERY_STDERR_TAIL_CHARS = 500;

/** One discovery attempt: the payload, or why there is none. */
export type DiscoveryAttempt =
  | { modules: BrainModuleListPayload }
  | {
      modules: null;
      cause: string;
      /** False for a cause no retry can change, such as a missing configuration. */
      retryable: boolean;
    };

interface DiscoveryOutcome {
  modules: BrainModuleListPayload | null;
  attempts: number;
  /** The last attempt's cause; absent when discovery succeeded. */
  cause?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tail(text: string, cap: number): string {
  const trimmed = text.trim();
  return trimmed.length <= cap ? trimmed : `…${trimmed.slice(-cap)}`;
}

/** Collapse a cause to one line, so it stays one stderr line and one cron_runs error. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " | ");
}

/**
 * Run `brain module list --json` through the host boundary and say why it
 * yielded nothing when it does. The CLI imports the repository's config, so
 * this read goes through the boundary like every other CLI launch: a
 * maintenance worker while it holds, the exec wrapper otherwise.
 */
export async function readModuleList(
  env: Record<string, string | undefined>,
  boundary: HostBoundary
): Promise<DiscoveryAttempt> {
  let result: Awaited<ReturnType<HostBoundary["run"]>>;
  try {
    result = await boundary.run({ argv: ["brain", "module", "list", "--json"], env,
      ...brainCommandClass(["module", "list"]), purpose: "brain module list" });
  } catch (error) {
    return { modules: null, cause: `brain module list could not run: ${oneLine(messageOf(error))}`, retryable: true };
  }
  const stderrTail = oneLine(tail(result.stderr ?? "", DISCOVERY_STDERR_TAIL_CHARS));
  const withStderr = (cause: string) => (stderrTail ? `${cause}; stderr: ${stderrTail}` : cause);
  if (result.timedOut) return { modules: null, cause: withStderr("brain module list timed out"), retryable: true };
  if (result.exitCode !== 0) {
    return { modules: null, cause: withStderr(`brain module list exited ${result.exitCode}`), retryable: true };
  }
  if (result.stdout.trim() === "") return { modules: null, cause: withStderr("brain module list printed nothing"), retryable: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { modules: null, cause: withStderr("brain module list printed output that is not JSON"), retryable: true };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as Partial<BrainModuleListPayload>).enabled) ||
    !Array.isArray((parsed as Partial<BrainModuleListPayload>).available)
  ) {
    return { modules: null, cause: "brain module list printed JSON without enabled and available lists", retryable: true };
  }
  return { modules: parsed as BrainModuleListPayload };
}

interface DiscoverModulesOptions {
  /** One whole attempt: qualify the host, read the list, release the host. */
  attempt: () => Promise<DiscoveryAttempt>;
  /** Waits between attempts; its length plus one bounds the attempts. */
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** One line per failed attempt and for the final fallback. */
  report: (line: string) => void;
}

/**
 * Attempt discovery until it yields a payload, a cause is not retryable, or
 * the retries run out. Each failed attempt reports its cause; a final failure
 * reports that module jobs are skipped.
 */
export async function discoverModules(options: DiscoverModulesOptions): Promise<DiscoveryOutcome> {
  const delays = options.delaysMs ?? MODULE_DISCOVERY_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const limit = delays.length + 1;
  let cause = "module discovery did not run";
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    let outcome: DiscoveryAttempt;
    try {
      outcome = await options.attempt();
    } catch (error) {
      outcome = { modules: null, cause: oneLine(messageOf(error)), retryable: true };
    }
    if (outcome.modules !== null) return { modules: outcome.modules, attempts: attempt };
    cause = outcome.cause;
    const last = attempt === limit || !outcome.retryable;
    if (last) {
      options.report(`module discovery unavailable; emitting core jobs only (module cron skipped after ${attempt} attempt${attempt === 1 ? "" : "s"}). ${cause}`);
      return { modules: null, attempts: attempt, cause };
    }
    const delay = delays[attempt - 1];
    options.report(`module discovery attempt ${attempt} of ${limit} failed; retrying in ${Math.round(delay / 1000)}s. ${cause}`);
    await sleep(delay);
  }
  return { modules: null, attempts: limit, cause };
}

/**
 * Record a discovery outcome as one finished `modules` run: an error naming
 * the cause when module cron was skipped, a success otherwise, so a later
 * successful start clears the signal. Fail-open, as the cron wrapper's own
 * tracking is: the crontab is emitted whether or not this write lands.
 */
function recordModuleDiscovery(db: Database, outcome: DiscoveryOutcome): void {
  const error = outcome.modules === null ? `module cron skipped: ${outcome.cause ?? "module discovery unavailable"}` : undefined;
  const run = recordCronRun(db, MODULE_DISCOVERY_JOB_NAME);
  const store = createActivityStore(db, { writer: `cron:${process.pid}` });
  const { runId, rootSpanId } = startCronSpan(db, store, MODULE_DISCOVERY_JOB_NAME);
  run.finish(error);
  store.endSpan(rootSpanId, {
    outcome: error === undefined ? "success" : "error",
    reason: error,
    attrs: {
      "brain.module_discovery.attempts": outcome.attempts,
      "brain.module_discovery.skipped": outcome.modules === null,
    },
  });
  store.rollupRun(runId);
}

interface PersistModuleDiscoveryOptions {
  brainPath: string;
  dbPath: string | undefined;
  /**
   * Whether any attempt qualified the native host. Only then may this create
   * the UI database, as a job run does after the same qualification; an
   * unqualified host records only into a database that already exists.
   */
  hostQualified: boolean;
  outcome: DiscoveryOutcome;
  report: (line: string) => void;
}

/**
 * Record the outcome on the UI database the server shares, when there is one
 * this process may write: persistent, outside the brain, and either already
 * present or behind a qualified host. Returns whether it was recorded.
 */
export function persistModuleDiscovery(options: PersistModuleDiscoveryOptions): boolean {
  const { brainPath, dbPath, hostQualified, outcome, report } = options;
  if (!dbPath || dbPath === ":memory:") return false;
  let db: Database | undefined;
  try {
    assertOperationalStateOutsideBrain({ brainPath, dbPath });
    if (!hostQualified && !existsSync(dbPath)) return false;
    db = createUiDb(dbPath);
    recordModuleDiscovery(db, outcome);
    return true;
  } catch (error) {
    report(`module discovery outcome not recorded: ${oneLine(messageOf(error))}`);
    return false;
  } finally {
    try { db?.close(); } catch { /* Closing tracking cannot fail the crontab. */ }
  }
}
