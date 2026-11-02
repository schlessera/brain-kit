/**
 * `brain compute` — external compute (#3107). A thin wrapper over the shared
 * operation set in lib/ops/compute.ts: it parses arguments into the same
 * strict input the MCP tools take, prints the envelope and maps exit codes.
 * The caller is the operating-system user; nothing on the command line can
 * name another caller.
 *
 * `run` stays attached by default: it advances the job through `status`
 * with backoff until the job ends and its cleanup settles, and on SIGINT or
 * SIGTERM (handled from before admission) cancels it and reports whether
 * release was confirmed. `--detach` returns once the command has started.
 *
 * Exit codes: 0 success; 1 usage error or refusal; 2 internal failure, an
 * attached run that could not advance its job, or a job that ended with its
 * cleanup not confirmed; 3 a job that ended other than `succeeded`; 130 or
 * 143 a second SIGINT or SIGTERM during `run`.
 */

import { emit, UsageError } from "../io.js";
import type { CoreCommand } from "../types.js";
import type {
  ComputeEnvelope,
  ComputeJobEnvelope,
  ComputeJobOutput,
  ComputeOps,
  ComputeRequestInput,
} from "../../lib/ops/compute.js";

const USAGE = `brain compute health [--provider ID] [--json]
brain compute plan --provider ID [run options] -- COMMAND [ARGS...]
brain compute run --provider ID [run options] [--detach] -- COMMAND [ARGS...]
brain compute status JOB [--json]
brain compute cancel JOB [--json]
brain compute collect JOB [--json]
brain compute abandon JOB --confirm [--json]
brain compute reconcile [--json]

Run options:
  --provider ID          configured instance (compute.providers key); required, no default
  --cwd PATH             working directory relative to the staged source root
  --env NAME=VALUE       non-secret sandbox variable (repeatable); credential names are refused
  --source PATH          repository-relative file to upload (repeatable); nothing else is uploaded
  --artifact PATH[:MAX]  file to fetch back, with an optional byte cap (repeatable; default 1 MiB)
  --lease SECONDS        lease length; default and maximum is the instance's lease.maxSeconds
  --retain               keep the sandbox's data on release (provider retention applies)
  --detach               run only: return once the command has started

Nothing runs remotely unless --provider names an instance. Job ids belong to
the operating-system user that started them through the CLI. Exit 1 is a usage
error or a refusal (nothing allocated); exit 2 a job whose cleanup was not
confirmed (run \`brain compute reconcile\`); exit 3 a job that ended other
than succeeded. A second Ctrl-C leaves an attached run at once (exit 130).`;

const VALUE_FLAGS = new Set(["provider", "cwd", "env", "source", "artifact", "lease"]);
const BOOLEAN_FLAGS = new Set(["retain", "detach", "confirm", "json", "human"]);
const REPEATABLE = new Set(["env", "source", "artifact"]);
const OUTPUT = ["json", "human"];
const ALLOWED: Record<string, string[]> = {
  health: [...OUTPUT, "provider"],
  plan: [...OUTPUT, "provider", "cwd", "env", "source", "artifact", "lease", "retain"],
  run: [...OUTPUT, "provider", "cwd", "env", "source", "artifact", "lease", "retain", "detach"],
  status: OUTPUT,
  cancel: OUTPUT,
  collect: OUTPUT,
  abandon: [...OUTPUT, "confirm"],
  reconcile: OUTPUT,
};
const JOB_VERBS = new Set(["status", "cancel", "collect", "abandon"]);

interface Parsed {
  verb: string;
  positional: string[];
  values: Map<string, string[]>;
  booleans: Set<string>;
  command: string[] | undefined;
}

/** Strict parsing: repeatable flags, a bare `--` before the command, unknown flags refused. */
export function parseComputeArgs(rest: string[]): Parsed {
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  let command: string[] | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--") {
      command = rest.slice(i + 1);
      break;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        booleans.add(key);
        continue;
      }
      if (!VALUE_FLAGS.has(key)) throw new UsageError(`Unknown flag: --${key}`);
      const value = rest[i + 1];
      if (value === undefined || value === "--") throw new UsageError(`--${key} needs a value`);
      i++;
      const list = values.get(key) ?? [];
      if (list.length > 0 && !REPEATABLE.has(key)) throw new UsageError(`--${key} may be given once`);
      values.set(key, [...list, value]);
      continue;
    }
    positional.push(arg);
  }
  const verb = positional.shift();
  if (!verb || !Object.hasOwn(ALLOWED, verb)) throw new UsageError(`Usage:\n${USAGE}`);
  for (const key of [...values.keys(), ...booleans]) {
    if (!ALLOWED[verb]!.includes(key)) throw new UsageError(`Unsupported compute ${verb} flag: --${key}`);
  }
  if (command !== undefined && verb !== "plan" && verb !== "run") throw new UsageError(`compute ${verb} takes no command`);
  return { verb, positional, values, booleans, command };
}

const one = (p: Parsed, key: string) => p.values.get(key)?.[0];

function wholeNumber(text: string, flag: string): number {
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new UsageError(`${flag} must be a positive whole number`);
  return Number(text);
}

/** The strict request both surfaces take, from `plan`/`run` arguments. */
export async function requestFromArgs(p: Parsed): Promise<ComputeRequestInput> {
  const provider = one(p, "provider");
  if (provider === undefined) throw new UsageError("--provider is required: no compute instance is a default");
  if (!p.command || p.command.length === 0) throw new UsageError(`compute ${p.verb} needs a command after --`);
  const env: Record<string, string> = {};
  for (const pair of p.values.get("env") ?? []) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new UsageError(`--env takes NAME=VALUE: ${pair}`);
    const name = pair.slice(0, at);
    if (Object.hasOwn(env, name)) throw new UsageError(`--env ${name} is given twice`);
    env[name] = pair.slice(at + 1);
  }
  const artifacts = (p.values.get("artifact") ?? []).map((spec) => {
    const match = /^(.*):([0-9]+)$/.exec(spec);
    return match ? { path: match[1]!, max_bytes: wholeNumber(match[2]!, "--artifact's byte cap") } : { path: spec };
  });
  const lease = one(p, "lease");
  const raw = {
    provider,
    argv: p.command,
    ...(one(p, "cwd") !== undefined ? { cwd: one(p, "cwd") } : {}),
    ...(p.values.has("env") ? { env } : {}),
    ...(p.values.has("source") ? { source: p.values.get("source") } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(lease !== undefined ? { lease_seconds: wholeNumber(lease, "--lease") } : {}),
    ...(p.booleans.has("retain") ? { retain: true } : {}),
  };
  const { computeRequestInput } = await import("../../lib/ops/compute.js");
  const parsed = computeRequestInput.safeParse(raw);
  if (!parsed.success) throw new UsageError(`Invalid compute request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

const usd = (value: number | null) => (value === null ? "unknown" : `$${value.toFixed(4)}`);

/** Human cost: unknown stays unknown, never $0. */
export function describeCost(job: Pick<ComputeJobOutput, "cost">): string {
  const { estimate, actual } = job.cost;
  const est = estimate.usd === null ? "no estimate" : `estimate ${usd(estimate.usd)} (${estimate.basis})`;
  return `${usd(actual.usd)} (${actual.coverage}); ${est}`;
}

function printJob(job: ComputeJobOutput): void {
  console.log(`job ${job.id}: ${job.state} on ${job.instance} (${job.provider})`);
  const exit = job.exit === null ? "none yet" : `${job.exit.code ?? "-"}${job.exit.signal ? ` ${job.exit.signal}` : ""} (${job.exit.reason})`;
  console.log(`  exit: ${exit}`);
  console.log(`  cleanup: ${job.cleanup.state}${job.cleanup.retainedUntil ? ` until ${job.cleanup.retainedUntil}` : ""}${job.cleanup.lastError ? ` — ${job.cleanup.lastError}` : ""}`);
  console.log(`  cost: ${describeCost(job)}`);
  console.log(`  source: ${job.source.hash.slice(0, 12)} (${job.source.files} file(s)); lease ${job.lease.seconds}s until ${job.lease.deadline}`);
  if (job.terminal) console.log(`  ended: ${job.terminal.reason}`);
  if (job.uncertain) console.log(`  uncertain: ${job.uncertain.reason}`);
  if (job.blocked) console.log(`  blocked: ${job.blocked}`);
}

function human(envelope: ComputeEnvelope): void {
  if (!envelope.ok) {
    console.error(`compute refused (${envelope.error.code}): ${envelope.error.message}`);
    return;
  }
  if ("instances" in envelope) {
    if (!envelope.enabled) console.log("External compute is not configured (no `compute` key in brain.config).");
    for (const i of envelope.instances) console.log(`${i.id}: ${i.status}${i.provider ? ` (${i.provider})` : ""}${i.reason ? ` — ${i.reason}` : ""}`);
    return;
  }
  if ("plan" in envelope) {
    const p = envelope.plan;
    console.log(`plan on ${p.instance} (${p.provider}): lease ${p.lease.seconds}s, ${p.source.files.length} source file(s) ${p.source.hash.slice(0, 12)}`);
    console.log(`  estimate: ${p.estimate.usd === null ? "unknown" : usd(p.estimate.usd)}; slots ${p.slots.used}/${p.slots.max}; retain ${p.retain}`);
    for (const f of p.source.files) console.log(`  upload ${f.path} (${f.bytes} bytes)`);
    for (const a of p.artifacts) console.log(`  collect ${a.path} (at most ${a.maxBytes} bytes)`);
    return;
  }
  if ("visited" in envelope) {
    for (const v of envelope.visited) console.log(`${v.id}: ${v.state}, cleanup ${v.cleanup}`);
    for (const s of envelope.skipped) console.log(`${s.id}: skipped — ${s.reason}`);
    if (envelope.visited.length + envelope.skipped.length === 0) console.log("Nothing to reconcile.");
    return;
  }
  printJob(envelope.job);
  if ("output" in envelope) {
    if (envelope.output.stdout) console.log(`--- stdout${envelope.output.truncated ? " (truncated)" : ""}\n${envelope.output.stdout}`);
    if (envelope.output.stderr) console.log(`--- stderr\n${envelope.output.stderr}`);
    for (const a of envelope.artifacts) console.log(`  artifact ${a.path}: ${a.status}${a.file ? ` → ${a.file}` : ""}`);
  }
}

/** Poll waits for an attached run: quick at first, then at most every five seconds. */
export const ATTACH_BACKOFF = { initialMs: 250, factor: 1.5, maxMs: 5_000 };

/**
 * Visits an attached run makes after its job has ended while cleanup is not
 * yet settled. A failed release is retried on a backoff of 30 s or more, so
 * waiting longer cannot help; `brain compute reconcile` takes over from here.
 */
export const ATTACH_CLEANUP_VISITS = 3;

/** Cleanup facts that leave a sandbox possibly running after the job ended. */
const UNCONFIRMED_CLEANUP = new Set(["pending", "release_failed", "unknown"]);

/**
 * SIGINT and SIGTERM for one `run`, installed before admission so a signal
 * that arrives while the job is allocated, staged or started is not lost:
 * the first one is remembered and the job is cancelled as soon as it can be;
 * a second one leaves at once (exit 130 or 143), naming the job on stderr.
 */
export class RunSignals {
  signal: NodeJS.Signals | null = null;
  jobId: string | undefined;
  private wakeUp: (() => void) | undefined;
  private readonly onSignal = (signal: NodeJS.Signals) => {
    if (this.signal) {
      console.error(
        this.jobId
          ? `brain compute: left ${this.jobId} without confirming cancellation; run \`brain compute cancel ${this.jobId}\``
          : "brain compute: left before a job was recorded; `brain compute reconcile` settles anything left behind"
      );
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
    this.signal = signal;
    this.log(
      this.jobId
        ? `brain compute: ${signal} received, cancelling ${this.jobId}`
        : `brain compute: ${signal} received, cancelling the job as soon as it has started`
    );
    this.wakeUp?.();
  };

  constructor(private readonly log: (line: string) => void) {
    process.on("SIGINT", this.onSignal);
    process.on("SIGTERM", this.onSignal);
  }

  /** Wait `ms`, or less if a signal arrives. */
  sleep(ms: number): Promise<void> {
    if (this.signal) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = done;
    }).finally(() => {
      this.wakeUp = undefined;
    });
  }

  dispose(): void {
    process.off("SIGINT", this.onSignal);
    process.off("SIGTERM", this.onSignal);
  }
}

/**
 * Drive one job through `status` until it is settled: ended, with its
 * cleanup no longer pending or failing (the predicate the MCP driver uses),
 * or ATTACH_CLEANUP_VISITS visits after it ended. A signal stops the wait and
 * the job is cancelled; the cancel result is then the answer.
 */
export async function attach(
  ops: ComputeOps,
  started: ComputeJobOutput,
  log: (line: string) => void,
  signals: Pick<RunSignals, "signal" | "sleep">,
  options: { cleanupVisits?: number } = {}
): Promise<ComputeJobEnvelope> {
  const cleanupVisits = options.cleanupVisits ?? ATTACH_CLEANUP_VISITS;
  const { jobSettled } = await import("../../lib/ops/compute.js");
  let current: ComputeJobEnvelope = { ok: true, job: started };
  let delay = ATTACH_BACKOFF.initialMs;
  let afterEnd = 0;
  while (!signals.signal && current.ok && !jobSettled(current.job) && current.job.blocked === null) {
    if (current.job.terminal !== null && afterEnd++ >= cleanupVisits) break;
    await signals.sleep(delay);
    if (signals.signal) break;
    delay = Math.min(ATTACH_BACKOFF.maxMs, Math.ceil(delay * ATTACH_BACKOFF.factor));
    const before = current.ok ? current.job.state : undefined;
    current = await ops.status({ job: started.id });
    if (current.ok && current.job.state !== before) log(`brain compute: ${started.id} ${current.job.state}`);
  }
  if (signals.signal && (!current.ok || current.job.terminal === null)) current = await ops.cancel({ job: started.id });
  return current;
}

/**
 * `run`'s exit code: 1 a refusal; 2 a job an attached run could not finish
 * (still active, or blocked), or one that ended with its cleanup not
 * confirmed (`pending`, `release_failed` or `unknown`); 3 a job that ended
 * other than `succeeded`; else 0.
 */
export function runExitCode(envelope: ComputeJobEnvelope, attached: boolean): number {
  if (!envelope.ok) return 1;
  const job = envelope.job;
  if (job.terminal === null) return attached ? 2 : 0;
  if (UNCONFIRMED_CLEANUP.has(job.cleanup.state)) return 2;
  return job.state === "succeeded" ? 0 : 3;
}

/**
 * `run`: admit and start the job with signal handlers already installed,
 * name it on stderr (human mode) as soon as it is recorded, then follow it
 * unless detached. A signal before the job has started cancels it once
 * `ops.run` returns.
 */
export async function runJob(
  ops: ComputeOps,
  request: ComputeRequestInput,
  options: { detach: boolean; human: boolean; log: (line: string) => void; cleanupVisits?: number }
): Promise<{ envelope: ComputeJobEnvelope; code: number }> {
  const { log } = options;
  const signals = new RunSignals(log);
  try {
    const started = await ops.run(request, {
      onCreated(id) {
        signals.jobId = id;
        if (options.human) log(`brain compute: recorded ${id}; Ctrl-C cancels it`);
      },
    });
    if (!started.ok) return { envelope: started, code: 1 };
    signals.jobId = started.job.id;
    if (signals.signal) {
      const final = started.job.terminal === null ? await ops.cancel({ job: started.job.id }) : started;
      return { envelope: final, code: runExitCode(final, true) };
    }
    if (options.detach) return { envelope: started, code: runExitCode(started, false) };
    if (options.human && started.job.terminal === null) log(`brain compute: started ${started.job.id} (${started.job.state})`);
    const final = await attach(ops, started.job, log, signals, { cleanupVisits: options.cleanupVisits });
    return { envelope: final, code: runExitCode(final, true) };
  } finally {
    signals.dispose();
  }
}

export const computeCommand: CoreCommand = {
  summary: "External compute: plan, run, inspect, cancel and collect jobs on a configured provider",
  helpBlock: USAGE,
  async run(rest, cli) {
    const p = parseComputeArgs(rest);
    if (JOB_VERBS.has(p.verb) ? p.positional.length !== 1 : p.positional.length !== 0) {
      throw new UsageError(JOB_VERBS.has(p.verb) ? `Usage: brain compute ${p.verb} JOB` : `compute ${p.verb} takes no positional argument`);
    }
    if (p.verb === "abandon" && !p.booleans.has("confirm")) {
      throw new UsageError("abandon accepts an unresolved outcome for good; repeat with --confirm");
    }
    const { createComputeOps, localPrincipal } = await import("../../lib/ops/compute.js");
    const ops = createComputeOps({ root: cli.brain.root, config: cli.brain.config, caller: { kind: "cli", principal: localPrincipal() } });
    const job = { job: p.positional[0]! };
    const out = (envelope: ComputeEnvelope) => emit(cli.json, envelope, () => human(envelope));

    let envelope: ComputeEnvelope;
    switch (p.verb) {
      case "health": {
        const provider = one(p, "provider");
        envelope = await ops.health(provider === undefined ? {} : { provider });
        break;
      }
      case "plan":
        envelope = await ops.plan(await requestFromArgs(p));
        break;
      case "run": {
        const log = (line: string) => console.error(line);
        const { envelope: final, code } = await runJob(ops, await requestFromArgs(p), { detach: p.booleans.has("detach"), human: !cli.json, log });
        out(final);
        if (final.ok && code === 2 && final.job.terminal !== null) {
          console.error(
            `brain compute: ${final.job.id} ended but its cleanup is ${final.job.cleanup.state}: a sandbox may still be running. Run \`brain compute reconcile\` to retry the release.`
          );
        }
        return code;
      }
      case "status":
        envelope = await ops.status(job);
        break;
      case "cancel":
        envelope = await ops.cancel(job);
        break;
      case "collect":
        envelope = await ops.collect(job);
        break;
      case "abandon":
        envelope = await ops.abandon(job);
        break;
      default:
        envelope = await ops.reconcile();
    }
    out(envelope);
    return envelope.ok ? 0 : 1;
  },
};
