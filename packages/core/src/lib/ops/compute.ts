/**
 * The external compute operations behind `brain compute` and the
 * `brain_compute_*` MCP tools (#3107): one input schema, one call into the
 * job service and one JSON envelope per operation. The CLI and MCP wrappers
 * only parse arguments, print and map exit codes; neither reads job state or
 * calls the service on its own. The caller identity always comes from the
 * host (`localPrincipal`), never from input.
 *
 * Contract: docs/integration-contract/cli.md#external-compute-additive-0450-3107
 * and docs/integration-contract/mcp.md#external-compute-tools-additive-0450-3107.
 */

import { userInfo } from "node:os";
import { z } from "zod";

import type { BrainConfig } from "../config.js";
import { maintenanceConfigRoots } from "../../config/env.js";
import { checkGovernancePolicy } from "../governance-policy.js";
import {
  createComputeService,
  type ComputeCollection,
  type ComputeHealthReport,
  type ComputeReconcileReport,
  type ComputeRunHooks,
} from "../compute/service.js";
import type {
  ComputeCaller,
  ComputeJobView,
  ComputePlan,
  ComputeRefusal,
  ComputeRunRequest,
  ComputeServiceOptions,
} from "../compute/types.js";
import type { ComputeCapabilities, ComputeRefusalCode, JobCost } from "../seams.js";

/** The six MCP tools, in registration order. Registered whatever the config says. */
export const COMPUTE_TOOL_NAMES = [
  "brain_compute_health",
  "brain_compute_plan",
  "brain_compute_run",
  "brain_compute_status",
  "brain_compute_cancel",
  "brain_compute_collect",
] as const;

/** An artifact's byte cap when the caller names none. */
export const DEFAULT_ARTIFACT_MAX_BYTES = 1024 * 1024;

const instanceId = z.string().min(1).max(63);

/** `brain compute health` / `brain_compute_health`. */
export const computeHealthInput = z.strictObject({
  provider: instanceId.optional().describe("One configured instance id; omit for every instance"),
});

/** `brain compute plan|run` / `brain_compute_plan|run`. Strict: no caller, no provider identity, no credential. */
export const computeRequestInput = z.strictObject({
  provider: instanceId.describe("The configured compute instance id (a `compute.providers` key). Required: no instance is a default"),
  argv: z.array(z.string().max(8192)).min(1).max(256).describe("The command and its arguments, run without a shell"),
  cwd: z.string().max(1024).optional().describe("Working directory relative to the staged source root"),
  env: z
    .record(z.string().max(128), z.string().max(8192))
    .refine((env) => Object.keys(env).length <= 64, "at most 64 variables")
    .optional()
    .describe("Non-secret sandbox variables. Credential-shaped names are refused; values are recorded and may be kept by the provider"),
  source: z.array(z.string().max(1024)).max(1000).optional().describe("Repository-relative files to upload. Nothing else is uploaded"),
  artifacts: z
    .array(
      z.strictObject({
        path: z.string().max(1024).describe("Path relative to the staged source root"),
        max_bytes: z.number().int().positive().optional().describe(`Byte cap; default ${DEFAULT_ARTIFACT_MAX_BYTES}`),
      })
    )
    .max(64)
    .optional()
    .describe("Files to fetch back after the command exits"),
  lease_seconds: z.number().int().positive().optional().describe("Lease length; default and maximum is the instance's lease.maxSeconds"),
  retain: z
    .boolean()
    .optional()
    .describe("Keep the sandbox's data on release; default is the instance's retainOnRelease. false is always allowed; true only where the instance sets retainOnRelease"),
});

/** `brain compute status|cancel|collect|abandon JOB` / `brain_compute_status|cancel|collect`. */
export const computeJobInput = z.strictObject({
  job: z.string().min(1).max(128).describe("The opaque job id returned by run"),
});

export type ComputeHealthInput = z.infer<typeof computeHealthInput>;
export type ComputeRequestInput = z.infer<typeof computeRequestInput>;
export type ComputeJobInput = z.infer<typeof computeJobInput>;
export type { ComputeRunHooks };

/** A refusal: nothing was allocated or changed. */
export interface ComputeErrorEnvelope {
  ok: false;
  error: { code: ComputeRefusalCode; message: string };
}

/** A job as callers see it. Times are ISO 8601; no sandbox or command ids, no environment values. */
export interface ComputeJobOutput {
  id: string;
  instance: string;
  provider: string;
  state: ComputeJobView["state"];
  createdAt: string;
  updatedAt: string;
  lease: { seconds: number; deadline: string };
  source: { hash: string; files: number };
  exit: ComputeJobView["exit"];
  artifacts: ComputeJobView["artifacts"];
  cleanup: { state: ComputeJobView["cleanup"]["state"]; retainedUntil: string | null; lastError: string | null };
  cost: JobCost;
  cancelRequested: boolean;
  uncertain: ComputeJobView["uncertain"];
  terminal: { state: NonNullable<ComputeJobView["terminal"]>["state"]; at: string; reason: string } | null;
  blocked: string | null;
}

export type ComputeHealthEnvelope =
  | {
      ok: true;
      enabled: boolean;
      instances: { id: string; provider: string | null; status: ComputeHealthReport["instances"][number]["status"]; reason: string | null; capabilities: ComputeCapabilities | null }[];
    }
  | ComputeErrorEnvelope;
export type ComputePlanEnvelope = { ok: true; plan: ComputePlan } | ComputeErrorEnvelope;
export type ComputeJobEnvelope = { ok: true; job: ComputeJobOutput } | ComputeErrorEnvelope;
export type ComputeCollectEnvelope =
  | { ok: true; job: ComputeJobOutput; output: ComputeCollection["output"]; artifacts: ComputeCollection["artifacts"] }
  | ComputeErrorEnvelope;
export type ComputeReconcileEnvelope =
  | { ok: true; visited: ComputeReconcileReport["visited"]; skipped: ComputeReconcileReport["skipped"] }
  | ComputeErrorEnvelope;

export type ComputeEnvelope =
  | ComputeHealthEnvelope
  | ComputePlanEnvelope
  | ComputeJobEnvelope
  | ComputeCollectEnvelope
  | ComputeReconcileEnvelope;

export interface ComputeOps {
  readonly caller: ComputeCaller;
  health(input: ComputeHealthInput): Promise<ComputeHealthEnvelope>;
  plan(input: ComputeRequestInput): Promise<ComputePlanEnvelope>;
  /** `hooks.onCreated` hears the job id as soon as its record exists, before the provider is called. */
  run(input: ComputeRequestInput, hooks?: ComputeRunHooks): Promise<ComputeJobEnvelope>;
  status(input: ComputeJobInput): Promise<ComputeJobEnvelope>;
  cancel(input: ComputeJobInput): Promise<ComputeJobEnvelope>;
  collect(input: ComputeJobInput): Promise<ComputeCollectEnvelope>;
  /** CLI only: accept an unresolved `uncertain` outcome. */
  abandon(input: ComputeJobInput): Promise<ComputeJobEnvelope>;
  /** CLI only: visit every unfinished job of this brain not held by a live process. */
  reconcile(): Promise<ComputeReconcileEnvelope>;
}

export interface ComputeOpsOptions {
  root: string;
  config: BrainConfig | null | undefined;
  /** Supplied by the host: the CLI or MCP process, never tool input. */
  caller: ComputeCaller;
  /** Defaults to the process environment, read through core's env chokepoint. */
  env?: NodeJS.ProcessEnv;
  /** Test and host overrides (state directory, clock, transport, timeouts). */
  serviceOptions?: Partial<Omit<ComputeServiceOptions, "root" | "config" | "env">>;
  /**
   * A host that admits on its callers' behalf (#3108): it owns the budget
   * ledger, the approval and the caller's live authority, and it passes the
   * data-to-provider rules frozen at its turn's admission. With it, plan and
   * run neither apply the inside-a-worker refusal nor re-read the brain's
   * policy file: the host's own process is not a worker, and its turn's
   * policy is the one its other effects are judged by.
   */
  hosted?: {
    sourcePolicy: NonNullable<ComputeServiceOptions["sourcePolicy"]>;
    approve: NonNullable<ComputeServiceOptions["approve"]>;
    budget: NonNullable<ComputeServiceOptions["budget"]>;
    recheck?: ComputeServiceOptions["recheck"];
  };
}

/** The operating-system user this process runs as: the CLI and MCP caller principal. */
export function localPrincipal(): string {
  try {
    const name = userInfo().username;
    if (name) return name;
  } catch {
    /* no passwd entry: fall back to the numeric id */
  }
  return typeof process.getuid === "function" ? `uid:${process.getuid()}` : "local";
}

const iso = (ms: number) => new Date(ms).toISOString();

const refusal = (r: ComputeRefusal): ComputeErrorEnvelope => ({ ok: false, error: { code: r.code, message: r.reason } });

export function jobOutput(view: ComputeJobView): ComputeJobOutput {
  return {
    id: view.id,
    instance: view.instance,
    provider: view.provider,
    state: view.state,
    createdAt: iso(view.createdAt),
    updatedAt: iso(view.updatedAt),
    lease: { seconds: view.lease.seconds, deadline: iso(view.lease.deadline) },
    source: { hash: view.source.hash, files: view.source.files },
    exit: view.exit,
    artifacts: view.artifacts,
    cleanup: {
      state: view.cleanup.state,
      retainedUntil: view.cleanup.retainedUntil === null ? null : iso(view.cleanup.retainedUntil),
      lastError: view.cleanup.lastError,
    },
    cost: view.cost,
    cancelRequested: view.cancelRequested,
    uncertain: view.uncertain,
    terminal: view.terminal === null ? null : { state: view.terminal.state, at: iso(view.terminal.at), reason: view.terminal.reason },
    blocked: view.blocked,
  };
}

export function toRunRequest(input: ComputeRequestInput): ComputeRunRequest {
  return {
    instance: input.provider,
    argv: input.argv,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.artifacts !== undefined
      ? { artifacts: input.artifacts.map((a) => ({ path: a.path, maxBytes: a.max_bytes ?? DEFAULT_ARTIFACT_MAX_BYTES })) }
      : {}),
    ...(input.lease_seconds !== undefined ? { leaseSeconds: input.lease_seconds } : {}),
    ...(input.retain !== undefined ? { retain: input.retain } : {}),
  };
}

/**
 * The operation set. Every call builds the service from the same root,
 * config and environment; plan and run also read the brain's governance
 * policy now, so its data-to-provider rules apply with the instance id as
 * recipient. An invalid policy refuses admission rather than sending data
 * under rules nobody can read.
 */
export function createComputeOps(options: ComputeOpsOptions): ComputeOps {
  const { root, config, caller } = options;
  // Undefined reads the process environment through core's env chokepoint.
  const env = options.env;
  const hosted = options.hosted;
  // A hosted ledger settles whichever operation advances a job, so every
  // service of a hosted operation set carries it.
  const hostedOptions: Partial<ComputeServiceOptions> = hosted
    ? { budget: hosted.budget, approve: hosted.approve, ...(hosted.recheck ? { recheck: hosted.recheck } : {}) }
    : {};
  const service = (sourcePolicy?: ComputeServiceOptions["sourcePolicy"]) =>
    createComputeService({ ...options.serviceOptions, ...hostedOptions, root, config, env, ...(sourcePolicy ? { sourcePolicy } : {}) });

  /** The admission service, or the refusal an unreadable policy earns. */
  function admission(): ReturnType<typeof service> | ComputeErrorEnvelope {
    // Disabled: the service refuses with compute_disabled before any read.
    if (!config?.compute) return service();
    // The host admits with its turn's frozen policy and its own ledger.
    if (hosted) return service({ providers: hosted.sourcePolicy.providers });
    // A hosted turn or maintenance worker has no admission of its own: its
    // caller identity, budgets, approvals and Activity live on the host, so a
    // worker-side run would bypass them. Hosted admission (#3108) routes work
    // through the host instead. The launch marker is defense in depth; the
    // worker also lacks provider credentials and a writable state home.
    const workerRoot = env ? env.BRAIN_WORKER_DATA_ROOT : maintenanceConfigRoots().data;
    if (workerRoot) {
      return { ok: false, error: { code: "policy_denied", message: "external compute does not run from inside a hosted or maintenance worker; a host must admit it" } };
    }
    const policy = checkGovernancePolicy(root);
    if (policy.status === "invalid") {
      return { ok: false, error: { code: "policy_denied", message: `the governance policy is invalid, so no data may go to a provider: ${policy.errors[0] ?? "unreadable"}` } };
    }
    return service({ providers: policy.effective.providers });
  }

  return {
    caller,

    async health(input) {
      const report = await service().health(input.provider);
      if (!report.ok) return refusal(report);
      return {
        ok: true,
        enabled: report.enabled,
        instances: report.instances.map((i) => ({ id: i.id, provider: i.provider, status: i.status, reason: i.reason, capabilities: i.capabilities })),
      };
    },

    async plan(input) {
      const svc = admission();
      if ("ok" in svc) return svc;
      const planned = await svc.plan(caller, toRunRequest(input));
      return planned.ok ? { ok: true, plan: planned.plan } : refusal(planned);
    },

    async run(input, hooks) {
      const svc = admission();
      if ("ok" in svc) return svc;
      const result = await svc.run(caller, toRunRequest(input), hooks);
      return result.ok ? { ok: true, job: jobOutput(result.job) } : refusal(result);
    },

    async status(input) {
      const result = await service().status(caller, input.job);
      return result.ok ? { ok: true, job: jobOutput(result.job) } : refusal(result);
    },

    async cancel(input) {
      const result = await service().cancel(caller, input.job);
      return result.ok ? { ok: true, job: jobOutput(result.job) } : refusal(result);
    },

    async collect(input) {
      const result = await service().collect(caller, input.job);
      if (!result.ok) return refusal(result);
      return { ok: true, job: jobOutput(result.job), output: result.output, artifacts: result.artifacts };
    },

    async abandon(input) {
      const result = await service().abandon(caller, input.job);
      return result.ok ? { ok: true, job: jobOutput(result.job) } : refusal(result);
    },

    async reconcile() {
      const report = await service().reconcile();
      return report.ok ? { ok: true, visited: report.visited, skipped: report.skipped } : refusal(report);
    },
  };
}

/** True once a job needs no further visit from a driver. */
export function jobSettled(job: ComputeJobOutput): boolean {
  return job.terminal !== null && job.cleanup.state !== "pending" && job.cleanup.state !== "release_failed";
}

export interface ComputeDriverOptions {
  /** First wait after a job is tracked. Default 2 000 ms. */
  initialDelayMs?: number;
  /** Longest wait between visits. Default 15 000 ms. */
  maxDelayMs?: number;
  /**
   * Jobs tracked at once; a run beyond it is still started, just not driven.
   * Default 256: tracking costs one id, and the visits a pass makes are
   * bounded by `visitsPerPass`, not by this.
   */
  maxJobs?: number;
  /** Visits one pass makes, to the least recently visited jobs first. Default 16. */
  visitsPerPass?: number;
  /** Consecutive throwing visits after which a job is dropped (and logged). Default 5. */
  maxFailures?: number;
  /** Where a dropped job is reported. Default: stderr. */
  log?: (line: string) => void;
}

export interface ComputeDriver {
  /** Keep advancing a job this process started until it is settled. */
  track(jobId: string): void;
  tracked(): string[];
  /** Stop for good: no further visit starts. Jobs stay bounded by their leases. */
  stop(): void;
}

/**
 * A bounded background driver for a long-lived process (the MCP server):
 * it visits the jobs that process started through the same `status`
 * operation a caller would use, one visit at a time with backoff, at most
 * `visitsPerPass` a pass, least recently visited first, so every tracked job
 * is driven however many there are. A job leaves once it is settled, once
 * `status` refuses it, or after `maxFailures` visits in a row that threw
 * (reconcile is the backstop). Its timer never keeps the process alive, and
 * stopping it cancels nothing.
 */
export function createComputeDriver(ops: ComputeOps, options: ComputeDriverOptions = {}): ComputeDriver {
  const initial = options.initialDelayMs ?? 2_000;
  const max = options.maxDelayMs ?? 15_000;
  const maxJobs = options.maxJobs ?? 256;
  const perPass = options.visitsPerPass ?? 16;
  const maxFailures = options.maxFailures ?? 5;
  const log = options.log ?? ((line: string) => console.error(line));
  // Insertion order is visit order: a visited job moves to the end.
  const jobs = new Map<string, { failures: number }>();
  let delay = initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let stopped = false;

  const schedule = () => {
    if (stopped || busy || timer || jobs.size === 0) return;
    timer = setTimeout(tick, delay);
    (timer as { unref?: () => void }).unref?.();
  };

  async function tick(): Promise<void> {
    timer = undefined;
    if (stopped) return;
    busy = true;
    try {
      for (const id of [...jobs.keys()].slice(0, perPass)) {
        if (stopped) break;
        const entry = jobs.get(id);
        if (!entry) continue;
        jobs.delete(id);
        try {
          const result = await ops.status({ job: id });
          if (result.ok && !jobSettled(result.job)) jobs.set(id, { failures: 0 });
        } catch (error) {
          if (entry.failures + 1 >= maxFailures) {
            log(`brain compute: stopped advancing ${id} after ${maxFailures} failed visits (${(error as Error)?.message ?? String(error)}); \`brain compute reconcile\` or the next status call settles it`);
          } else {
            jobs.set(id, { failures: entry.failures + 1 });
          }
        }
        if (stopped) jobs.clear();
      }
    } finally {
      busy = false;
      delay = Math.min(max, Math.ceil(delay * 1.5));
      schedule();
    }
  }

  return {
    track(id) {
      if (stopped || jobs.has(id) || jobs.size >= maxJobs) return;
      jobs.set(id, { failures: 0 });
      delay = initial;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      schedule();
    },
    tracked: () => [...jobs.keys()],
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      jobs.clear();
    },
  };
}
