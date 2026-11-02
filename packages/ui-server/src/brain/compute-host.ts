/**
 * Hosted external compute (#3108): admission and observation of compute jobs
 * that a hosted turn starts, through the same core operation set as
 * `brain compute` and the governance a turn's other effects already pass.
 *
 * The host supplies everything a tool argument must never decide: the
 * caller (principal, session and turn of the authenticated turn), the turn's
 * frozen data-to-provider rules, its posture and approval surface, the
 * budget ledger, the provider mask guard and the credentials. A call carries
 * only the instance id, the command and the job.
 *
 * - Configuration is read as data, never run: `brain config check --json`'s
 *   `compute` summary, from a masked credential-free worker that sees only
 *   the policy's protected paths. Only built-in providers run on the host;
 *   an instance whose provider is a value is `provider_unavailable`.
 * - Credentials come only from names the operator binds on the host
 *   (BRAIN_UI_COMPUTE_KEYS; a built-in's own default variable is bound
 *   implicitly, ruling R6). A bound name that would also reach a worker
 *   disables hosted compute. Values reach the provider call only.
 * - A run is approved per use on an interactive typed turn and never
 *   remembered; a turn that cannot show a card is refused without one. Each
 *   decision is recorded as an `outward_action` (`compute_run`).
 * - Budget and concurrency are reserved together: core's cross-process
 *   admission lock holds the slot count while the ledger reserves in one
 *   immediate transaction. Unknown accounting refuses; no ceiling admits
 *   with the cost unknown (ruling 4).
 * - A job outlives a normal turn end and is driven by the host until it is
 *   settled; a cancelled, timed-out, budget-stopped or revoked turn cancels
 *   its jobs (ruling R7). Restart reattaches every unsettled job.
 * - Each job is its own Activity root run `compute:<job id>` with origin
 *   `compute`; an uncertain job stays open, flagged stuck (ruling R8).
 *
 * docs/decisions/external-compute.md ("Settled by #3108").
 */
import type { Database } from "bun:sqlite";
import { posix } from "node:path";
import { z } from "zod";

import { isEnvName, PROTECTED_TIER_A } from "@schlessera/brain-common/internal/protected-paths";
import type { EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { AGENT_INFERENCE_CREDENTIAL_ENV, hostComputeCredential } from "@schlessera/brain-ui-sdk/internal";
import { filterSubprocessEnv, type PermissionDecision, type PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import type { ComputeHealthToolInput, ComputeJobToolInput, ComputeRequestToolInput, ComputeToolCall, ComputeToolResult, ComputeToolRefusalCode } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { Logger } from "@opentelemetry/api-logs";

import type { ActivityRuntime } from "../activity/runtime.js";
import { COMPUTE_RUN_PREFIX } from "../activity/stream.js";
import type { SpanOutcome } from "../activity/store.js";
import type { GovernanceEventInput } from "../governance/events.js";
import { queryGovernanceEvents } from "../governance/events.js";
import { ProviderMaskRefusedError } from "./provider-mask-refusal.js";
import type { TurnBudgets } from "./turn-budgets.js";

type CoreInternal = typeof import("@schlessera/brain/internal");
type ComputeCaller = import("@schlessera/brain/internal").ComputeCaller;
type ComputeOps = import("@schlessera/brain/internal").ComputeOps;
type ComputeJobOutput = import("@schlessera/brain/internal").ComputeJobOutput;
type ComputeServiceOptions = import("@schlessera/brain/internal").ComputeServiceOptions;
type ComputePlan = import("@schlessera/brain/internal").ComputePlan;
type ComputeBudget = import("@schlessera/brain/internal").ComputeBudget;
type HostedCaller = Extract<ComputeCaller, { kind: "hosted" }>;
type RequestCall = { input: ComputeRequestToolInput };
type JobCall = { input: ComputeJobToolInput };
type HealthCall = { input: ComputeHealthToolInput };

/** One instance of `brain config check --json`'s `compute` summary, parsed as untrusted data. */
const InstanceSummary = z.strictObject({
  provider: z.string().min(1).max(100).nullable(),
  byValue: z.boolean(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128).nullable(),
  options: z.record(z.string(), z.unknown()).nullable(),
  lease: z.strictObject({ maxSeconds: z.number().int().positive() }),
  maxConcurrent: z.number().int().positive().max(1000).nullable(),
  hourlyCeilingUsd: z.number().positive().finite().nullable(),
  retainOnRelease: z.boolean().nullable(),
});
/** The `compute` field of `brain config check --json` (#3108). */
export const HostedComputeSummary = z.strictObject({
  enabled: z.boolean(),
  providers: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), InstanceSummary),
});
export type HostedComputeConfig = z.infer<typeof HostedComputeSummary>;
type InstanceConfig = z.infer<typeof InstanceSummary>;

/** A configuration read: the summary, or why it could not be established. */
export type ComputeConfigRead = { ok: true; config: HostedComputeConfig } | { ok: false; reason: string };

/** What one turn's compute calls are bound to. Supplied by the host's turn bridge, never by input. */
export interface ComputeTurnContext {
  turnId: string;
  principalId: string;
  sessionId(): string | undefined;
  /** The data-to-provider and protection rules frozen at this turn's admission. */
  policy: Pick<EffectiveGovernancePolicy, "providers" | "protect" | "release">;
  /** The frozen policy's hash; null under built-in defaults. */
  policyHash: string | null;
  posture: "interactive" | "voice";
  /** True when no person can answer a card for this turn. */
  noGrantSurface: boolean;
  autonomous: boolean;
  /** A client is connected to show the approval card. */
  hasClient(): boolean;
  /** The turn's provider mask guard (#2690), refusing masked paths with a governance record. */
  maskGuard?: { assert(tool: string, paths: readonly string[]): void };
  /** The name the model sees for a compute tool on this backend. */
  toolName(name: string): string;
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
  /** Live authority: the turn is current, authorized and not cancelled. */
  isCurrent(): boolean;
  /** Record a governance event with this turn's identity, actor, model and profile. */
  govern(event: Pick<GovernanceEventInput, "kind" | "payload">): void;
}

/** Readiness of hosted compute, for `/api/status` `runtime.compute`. No vendor is called to produce it. */
export interface ComputeReadiness {
  enabled: boolean;
  /** Why hosted compute refuses every run, or null. */
  reason: string | null;
  core: "present" | "missing" | "unknown";
  stateDir: string | null;
  /** The state directory is among the paths every worker has masked. */
  stateMasked: boolean;
  bindings: Array<{
    provider: string;
    /** The built-in is installed and loads; `unknown` until the first check. */
    package: "present" | "missing" | "unknown";
    remoteExpiry: boolean | null;
    defaultKeyEnv: string | null;
    credentials: Array<{ name: string; implicit: boolean; present: boolean; leakedToWorkers: boolean }>;
  }>;
  /** The last configuration a turn read, by instance. */
  instances: Array<{ id: string; provider: string | null; builtin: boolean; credential: string | null; bound: boolean; present: boolean; refusal: string | null }> | null;
  openJobs: number;
}

export interface ComputeHostOptions {
  db: Database;
  brainPath: string;
  /** Host compute state directory; null disables hosted compute (an ephemeral database). */
  stateDir: string | null;
  /** Whether `stateDir` is masked from every worker. */
  stateMasked: boolean;
  /** BRAIN_UI_COMPUTE_KEYS: credential variable names bound per built-in provider. */
  keys: Readonly<Record<string, readonly string[]>>;
  /** Names the operator forwards to child processes (BRAIN_UI_SUBPROCESS_ENV_EXTRA). */
  workerEnvExtra: readonly string[];
  /** Reads the compute summary as data, once per turn. */
  readConfig(ctx: ComputeTurnContext): Promise<ComputeConfigRead>;
  budgets?: Pick<TurnBudgets, "compute">;
  activity?: Pick<ActivityRuntime, "store" | "stream" | "governance">;
  log?: Logger;
  /** Core's internal entry; tests inject it, production imports the optional peer lazily. */
  core?: () => Promise<CoreInternal>;
  /** Test overrides for the core service: registry, clock, transport, timeouts. */
  serviceOptions?: Partial<Omit<ComputeServiceOptions, "root" | "config" | "env" | "stateDir" | "budget" | "approve" | "sourcePolicy" | "recheck">>;
  /** Host driver cadence. */
  driver?: { initialDelayMs?: number; maxDelayMs?: number; visitsPerPass?: number; maxFailures?: number };
  /** Credential reader; defaults to the ui-sdk env chokepoint. */
  credential?: (name: string) => string | undefined;
  clock?: () => number;
}

export interface ComputeHost {
  /** The bridge handler for one turn. */
  forTurn(ctx: ComputeTurnContext): (call: ComputeToolCall) => Promise<ComputeToolResult>;
  /** A cancelled, timed-out, budget-stopped or revoked turn: cancel its jobs (R7). */
  cancelTurn(turnId: string, reason: string): Promise<void>;
  /** A turn that ended normally: its jobs keep running under the host driver (R7). */
  endTurn(turnId: string): void;
  /** A deleted conversation: cancel its jobs. */
  cancelSession(sessionId: string): Promise<void>;
  /** Boot: reattach every unsettled hosted job before any turn starts. No vendor call unless a job needs one. */
  recover(): Promise<void>;
  /** Shutdown: stop driving; cancel jobs whose provider has no remote expiry. */
  close(): Promise<void>;
  status(): ComputeReadiness;
  /** Visit tracked jobs now (tests). */
  drive(): Promise<void>;
}

interface JobRow {
  job_id: string;
  principal_id: string;
  session_id: string;
  turn_id: string;
  tool_use_id: string | null;
  instance: string;
  instance_config: string;
  run_id: string;
  created_at: number;
  settled_at: number | null;
  observed: string | null;
}

const refusal = (code: ComputeToolRefusalCode, message: string): ComputeToolResult => ({ ok: false, error: { code, message } });
const MAX_RECORDED_INPUT = 8192;
const SPAN_NAME = "compute_job";

/** Outcome of a settled job's Activity run. Unknown is never success. */
function spanOutcome(job: ComputeJobOutput): SpanOutcome {
  switch (job.terminal?.state) {
    case "succeeded": return job.cleanup.state === "unknown" ? "error" : "success";
    case "cancelled": return "cancelled";
    case "expired": return "timeout";
    default: return "error";
  }
}

/** True once a job needs no further visit: terminal, with its cleanup settled one way or another. */
function settledJob(job: ComputeJobOutput): boolean {
  return job.terminal !== null && job.cleanup.state !== "pending" && job.cleanup.state !== "release_failed";
}

export function createComputeHost(options: ComputeHostOptions): ComputeHost {
  const { db, brainPath } = options;
  const now = options.clock ?? Date.now;
  const credential = options.credential ?? hostComputeCredential;
  const loadCore = options.core ?? (() => import("@schlessera/brain/internal"));
  const turnConfigs = new Map<string, Promise<ComputeConfigRead>>();
  let core: CoreInternal | null | undefined;
  let lastInstances: ComputeReadiness["instances"] = null;
  const builtins = new Map<string, { package: "present" | "missing"; remoteExpiry: boolean | null; defaultKeyEnv: string | null }>();
  let closed = false;

  const log = (severity: "WARN" | "INFO" | "ERROR", body: string, attributes?: Record<string, string | number | boolean>) =>
    options.log?.emit({ severityText: severity, body, ...(attributes ? { attributes } : {}) });

  async function coreModule(): Promise<CoreInternal | null> {
    if (core !== undefined) return core;
    try { core = await loadCore(); } catch { core = null; }
    return core;
  }

  const registry = () => options.serviceOptions?.registry;

  /** What a bound built-in is, learned without any vendor call: its package, default variable and remote expiry. */
  async function builtin(provider: string): Promise<{ package: "present" | "missing"; remoteExpiry: boolean | null; defaultKeyEnv: string | null }> {
    const known = builtins.get(provider);
    if (known) return known;
    const internal = await coreModule();
    let found: { package: "present" | "missing"; remoteExpiry: boolean | null; defaultKeyEnv: string | null } = { package: "missing", remoteExpiry: null, defaultKeyEnv: null };
    const entry = internal ? (registry() ?? internal.COMPUTE_PROVIDERS)[provider] : undefined;
    if (entry) {
      try {
        const loaded = await entry.load();
        found = { package: "present", remoteExpiry: loaded.provider.capabilities.remoteExpiry === true, defaultKeyEnv: loaded.keyEnv ?? null };
      } catch { /* missing package: provider_unavailable */ }
    }
    builtins.set(provider, found);
    return found;
  }

  /** Every bound name per provider, explicit and implicit. */
  function boundNames(provider: string): Set<string> {
    const names = new Set(options.keys[provider] ?? []);
    const implicit = builtins.get(provider)?.defaultKeyEnv;
    if (implicit) names.add(implicit);
    return names;
  }

  /** A bound name some child process would be given: it could reach a worker. */
  function leaked(name: string): boolean {
    if (options.workerEnvExtra.includes(name) || AGENT_INFERENCE_CREDENTIAL_ENV.includes(name)) return true;
    return (["agent", "brainCli", "cron"] as const).some(audience => name in filterSubprocessEnv({ [name]: "probe" }, audience, options.workerEnvExtra));
  }

  /** The providers whose credentials are known to the host: explicitly bound, or loaded built-ins. */
  const providersOfInterest = () => [...new Set([...Object.keys(options.keys), ...builtins.keys()])].sort();

  /** Why hosted compute refuses everything, or null. */
  function disabledReason(): string | null {
    if (!options.stateDir) return "hosted compute needs durable host state: the server database is ephemeral";
    if (!options.stateMasked) return "the host compute state directory is not masked from workers";
    if (core === null) return "@schlessera/brain is not installed on this host";
    for (const provider of providersOfInterest()) {
      for (const name of boundNames(provider)) {
        if (leaked(name)) return `the compute credential variable ${name} would also reach worker processes (BRAIN_UI_SUBPROCESS_ENV_EXTRA or an agent credential); hosted compute is off until it is not forwarded`;
      }
    }
    return null;
  }

  /** The env core reads credentials from: bound names only. */
  function credentialEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const provider of providersOfInterest()) for (const name of boundNames(provider)) {
      const value = credential(name);
      if (value) env[name] = value;
    }
    return env;
  }

  /** Bound credential values, for redaction of anything a provider echoed. */
  function secrets(): string[] {
    return Object.values(credentialEnv()).filter((value): value is string => typeof value === "string" && value.length >= 4);
  }

  function redact<T>(value: T): T {
    const values = secrets();
    if (!values.length) return value;
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return values.reduce((text, secret) => text.split(secret).join("[redacted]"), v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return walk(value) as T;
  }

  /** An instance as core's config schema takes it. Credentials are named, never present. */
  function coreEntry(instance: InstanceConfig): Record<string, unknown> {
    return {
      provider: instance.provider,
      ...(instance.apiKeyEnv ? { apiKeyEnv: instance.apiKeyEnv } : {}),
      ...(instance.options ? { options: instance.options } : {}),
      lease: { maxSeconds: instance.lease.maxSeconds },
      ...(instance.maxConcurrent !== null ? { maxConcurrent: instance.maxConcurrent } : {}),
      ...(instance.hourlyCeilingUsd !== null ? { hourlyCeilingUsd: instance.hourlyCeilingUsd } : {}),
      ...(instance.retainOnRelease !== null ? { retainOnRelease: instance.retainOnRelease } : {}),
    };
  }

  /** Why the host refuses an instance before core sees it, or null. */
  async function instanceRefusal(id: string, instance: InstanceConfig): Promise<ComputeToolResult | null> {
    if (instance.byValue || instance.provider === null) {
      return refusal("provider_unavailable", `"${id}" names a provider value; hosted runs accept only built-in providers, because the host never runs brain code`);
    }
    const known = await builtin(instance.provider);
    if (known.package === "missing") return null; // core reports the missing package as provider_unavailable
    const keyEnv = instance.apiKeyEnv ?? known.defaultKeyEnv;
    if (keyEnv && !boundNames(instance.provider).has(keyEnv)) {
      return refusal("provider_unavailable", `"${id}" reads its credential from ${keyEnv}, which the host operator has not bound for hosted compute (BRAIN_UI_COMPUTE_KEYS)`);
    }
    return null;
  }

  function recordInstances(config: HostedComputeConfig): void {
    lastInstances = Object.entries(config.providers).map(([id, instance]) => {
      const keyEnv = instance.provider ? instance.apiKeyEnv ?? builtins.get(instance.provider)?.defaultKeyEnv ?? null : null;
      const bound = instance.provider !== null && keyEnv !== null && boundNames(instance.provider).has(keyEnv);
      return { id, provider: instance.provider, builtin: !instance.byValue && instance.provider !== null, credential: keyEnv, bound,
        present: bound && Boolean(credential(keyEnv!)),
        refusal: instance.byValue ? "provider value" : !bound ? "credential not bound" : null };
    });
  }

  /** The turn's configuration, read once per turn. */
  function turnConfig(ctx: ComputeTurnContext): Promise<ComputeConfigRead> {
    let read = turnConfigs.get(ctx.turnId);
    if (!read) {
      read = options.readConfig(ctx).then(async result => {
        if (!result.ok) return result;
        const parsed = HostedComputeSummary.safeParse(result.config);
        if (!parsed.success) return { ok: false as const, reason: "the brain's compute configuration summary did not parse" };
        for (const instance of Object.values(parsed.data.providers)) if (instance.provider && !instance.byValue) await builtin(instance.provider);
        recordInstances(parsed.data);
        return { ok: true as const, config: parsed.data };
      }, error => ({ ok: false as const, reason: `the brain's compute configuration could not be read: ${error instanceof Error ? error.message : String(error)}` }));
      turnConfigs.set(ctx.turnId, read);
    }
    return read;
  }

  /** A core operation set for one caller over the given instances. */
  async function opsFor(caller: ComputeCaller, providers: Record<string, InstanceConfig>, hosted?: {
    sourcePolicy: Pick<EffectiveGovernancePolicy, "providers">; approve: (plan: ComputePlan) => Promise<"approved" | "required" | "denied">; recheck: () => boolean;
    budget: ComputeBudget;
  }): Promise<ComputeOps | null> {
    const internal = await coreModule();
    if (!internal) return null;
    const config = { compute: { providers: Object.fromEntries(Object.entries(providers).map(([id, instance]) => [id, coreEntry(instance)])) } };
    return internal.createComputeOps({
      root: brainPath,
      config: config as never,
      caller,
      env: credentialEnv(),
      serviceOptions: { ...options.serviceOptions, stateDir: options.stateDir! },
      hosted: {
        sourcePolicy: { providers: hosted?.sourcePolicy.providers ?? [] },
        approve: hosted ? plan => hosted.approve(plan) : () => "denied",
        budget: hosted?.budget ?? ledger,
        ...(hosted ? { recheck: () => hosted.recheck() } : {}),
      },
    });
  }

  /**
   * The host ledger behind core's `ComputeBudget`. Without one, or without
   * the turn's frozen admission, accounting is unavailable and nothing
   * starts. A warning the reservation crosses is recorded for the turn.
   */
  const ledgerFor = (ctx?: ComputeTurnContext): ComputeBudget => ({
    async reserve(jobId, usd, caller) {
      if (!options.budgets) throw new Error("this host has no budget ledger");
      if (caller.kind !== "hosted") throw new Error("only a hosted caller reserves against turn budgets");
      const reserved = await options.budgets.compute.reserve(jobId, caller.turn, caller.session, usd);
      for (const item of reserved.warnings) {
        const unit = item.costUsd !== null && item.costUsd >= item.warnUsd ? "usd" : "tokens";
        try {
          ctx?.govern({ kind: "budget_warning", payload: { scope: item.scope, unit, limit: unit === "usd" ? item.warnUsd : item.warnTokens!,
            observed: unit === "usd" ? item.costUsd! : item.tokens!, source: ctx.policyHash ? "policy" : "default" } as never });
        } catch (error) { log("WARN", `compute budget warning not recorded: ${String(error)}`); }
      }
      return reserved.verdict;
    },
    async settle(jobId, actualUsd) {
      await options.budgets?.compute.settle(jobId, actualUsd);
    },
  });
  const ledger = ledgerFor();

  const jobRow = (jobId: string): JobRow | null => db.query("SELECT * FROM compute_hosted_jobs WHERE job_id = ?").get(jobId) as JobRow | null;
  const callerOf = (row: JobRow): ComputeCaller => ({ kind: "hosted", principal: row.principal_id, session: row.session_id, turn: row.turn_id });

  async function opsForJob(row: JobRow): Promise<ComputeOps | null> {
    let instance: InstanceConfig;
    try { instance = InstanceSummary.parse(JSON.parse(row.instance_config)); } catch { return null; }
    if (instance.provider) await builtin(instance.provider);
    return opsFor(callerOf(row), { [row.instance]: instance });
  }

  // ---------------------------------------------------------------- Activity

  const activityWrite = (what: string, write: () => unknown) => {
    try {
      const result = write();
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).then(() => options.activity?.stream.pump(), error => log("WARN", `compute activity ${what} failed: ${String(error)}`));
      } else options.activity?.stream.pump();
    } catch (error) { log("WARN", `compute activity ${what} failed: ${String(error)}`); }
  };

  function startRun(row: JobRow, attrs: Record<string, unknown>): void {
    const store = options.activity?.store;
    if (!store) return;
    activityWrite("start", () => store.startSpan({ spanId: row.run_id, runId: row.run_id, name: SPAN_NAME, kind: "tool", origin: "compute",
      sessionId: row.session_id, jobName: row.instance, principalId: row.principal_id, startedAt: row.created_at,
      attrs: { "brain.compute.job": row.job_id, "brain.compute.turn": row.turn_id, ...(row.tool_use_id ? { "brain.compute.tool_use": row.tool_use_id } : {}), ...attrs } }));
  }

  /** Record what a visit saw: a new state as one event, uncertainty as a stuck flag, settlement as the run's end. */
  function observe(row: JobRow, job: ComputeJobOutput): void {
    const store = options.activity?.store;
    const key = `${job.state}/${job.cleanup.state}`;
    const settled = settledJob(job);
    if (store) {
      activityWrite("heartbeat", () => store.heartbeat(row.run_id, now()));
      if (row.observed !== key) {
        activityWrite("event", () => store.appendEvent(row.run_id, "compute_state", { state: job.state, cleanup: job.cleanup.state,
          ...(job.exit ? { exit: job.exit } : {}), ...(job.uncertain ? { uncertain: job.uncertain } : {}), ...(job.blocked ? { blocked: job.blocked } : {}) }, now()));
        if (job.state === "uncertain") {
          // Never read as success or failure: open, flagged, and left for reconciliation.
          activityWrite("stuck", () => store.patchSpan(row.run_id, { attrs: { "brain.compute.stuck": true, "brain.compute.uncertain": job.uncertain?.reason ?? "unknown" } }));
        }
      }
      if (settled) {
        const complete = job.cost.actual.coverage === "complete" && job.cost.actual.usd !== null;
        activityWrite("end", () => store.endSpan(row.run_id, { outcome: spanOutcome(job), endedAt: now(),
          reason: `${job.terminal!.state}: ${job.terminal!.reason}; cleanup ${job.cleanup.state}`,
          attrs: { "brain.compute.cleanup": job.cleanup.state, "brain.compute.stuck": false, "brain.compute.cost_coverage": job.cost.actual.coverage,
            ...(job.cleanup.retainedUntil ? { "brain.compute.retained_until": job.cleanup.retainedUntil } : {}) },
          ...(complete ? { usage: { costUsd: job.cost.actual.usd! } } : {}) }));
        activityWrite("rollup", () => store.rollupRun(row.run_id));
      }
    }
    db.query("UPDATE compute_hosted_jobs SET observed = ?, settled_at = CASE WHEN ? THEN ? ELSE settled_at END WHERE job_id = ?")
      .run(key, settled ? 1 : 0, now(), row.job_id);
    row.observed = key;
    if (settled) {
      row.settled_at = now();
      // The ledger settles exactly once whichever process reaches it first; a
      // job settled by core before a crash is settled here on the next visit.
      if (job.terminal) void Promise.resolve(ledger.settle(row.job_id, job.cost.actual.coverage === "complete" ? job.cost.actual.usd : null))
        .catch((error: unknown) => log("WARN", `compute ledger settle failed for ${row.job_id}: ${String(error)}`));
    }
  }

  function abandonRun(row: JobRow, reason: string): void {
    const store = options.activity?.store;
    db.query("UPDATE compute_hosted_jobs SET settled_at = ? WHERE job_id = ?").run(now(), row.job_id);
    if (!store) return;
    activityWrite("end", () => store.endSpan(row.run_id, { outcome: "error", endedAt: now(), reason }));
    activityWrite("rollup", () => store.rollupRun(row.run_id));
  }

  // ------------------------------------------------------------------ driver

  const tracked = new Map<string, { failures: number }>();
  const initialDelay = options.driver?.initialDelayMs ?? 2_000;
  const maxDelay = options.driver?.maxDelayMs ?? 15_000;
  const perPass = options.driver?.visitsPerPass ?? 16;
  const maxFailures = options.driver?.maxFailures ?? 5;
  let delay = initialDelay;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy: Promise<void> | undefined;

  const schedule = () => {
    if (closed || busy || timer || tracked.size === 0) return;
    timer = setTimeout(() => { timer = undefined; void pass(); }, delay);
    (timer as { unref?: () => void }).unref?.();
  };

  async function visit(jobId: string): Promise<"keep" | "drop"> {
    const row = jobRow(jobId);
    if (!row || row.settled_at !== null) return "drop";
    const ops = await opsForJob(row);
    if (!ops) { abandonRun(row, "the job's admission record cannot be read; reconcile it with brain compute reconcile"); return "drop"; }
    const result = await ops.status({ job: jobId });
    if (!result.ok) {
      if (result.error.code === "job_unknown") { abandonRun(row, "the job record is gone from the compute state directory"); return "drop"; }
      return "keep";
    }
    observe(row, result.job);
    return settledJob(result.job) ? "drop" : "keep";
  }

  async function pass(): Promise<void> {
    if (closed) return;
    let finish!: () => void;
    busy = new Promise(resolve => { finish = resolve; });
    try {
      for (const id of [...tracked.keys()].slice(0, perPass)) {
        if (closed) break;
        const entry = tracked.get(id);
        if (!entry) continue;
        tracked.delete(id);
        try {
          if (await visit(id) === "keep") tracked.set(id, { failures: 0 });
        } catch (error) {
          if (entry.failures + 1 < maxFailures) tracked.set(id, { failures: entry.failures + 1 });
          else log("WARN", `hosted compute stopped advancing ${id} after ${maxFailures} failed visits; it is reattached at the next restart`, { error: String(error) });
        }
      }
    } finally {
      busy = undefined;
      finish();
      delay = Math.min(maxDelay, Math.ceil(delay * 1.5));
      schedule();
    }
  }

  function track(jobId: string): void {
    if (closed || tracked.has(jobId)) return;
    tracked.set(jobId, { failures: 0 });
    delay = initialDelay;
    if (timer) { clearTimeout(timer); timer = undefined; }
    schedule();
  }

  const inflight = new Set<Promise<void>>();
  function cancelRows(rows: JobRow[], reason: string): Promise<void> {
    const work = cancelEach(rows, reason);
    inflight.add(work);
    void work.finally(() => inflight.delete(work)).catch(() => {});
    return work;
  }
  async function cancelEach(rows: JobRow[], reason: string): Promise<void> {
    await Promise.all(rows.map(async row => {
      try {
        const ops = await opsForJob(row);
        if (!ops) return;
        const store = options.activity?.store;
        if (store) activityWrite("event", () => store.appendEvent(row.run_id, "compute_cancel", { reason }, now()));
        const result = await ops.cancel({ job: row.job_id });
        if (result.ok) observe(row, result.job);
        if (!result.ok || !settledJob(result.job)) track(row.job_id);
      } catch (error) {
        log("WARN", `hosted compute could not cancel ${row.job_id}: ${String(error)}`);
        track(row.job_id);
      }
    }));
  }

  const openRows = (where = "", ...params: string[]): JobRow[] =>
    db.query(`SELECT * FROM compute_hosted_jobs WHERE settled_at IS NULL${where}`).all(...params) as JobRow[];

  // ------------------------------------------------------------- turn calls

  /** The card a person approves: everything the run would send and cost, nothing secret. */
  function approvalCard(input: RequestCall["input"], plan: ComputePlan, tainted: boolean): Record<string, unknown> {
    return {
      instance: plan.instance,
      provider: plan.provider,
      lease_seconds: plan.lease.seconds,
      estimate: plan.estimate.usd === null ? "unknown (no hourly ceiling configured)" : `$${plan.estimate.usd.toFixed(4)} (ceiling × lease)`,
      retain: plan.retain,
      source: { hash: plan.source.hash, files: plan.source.files.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })) },
      argv: input.argv,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      env_names: Object.keys(input.env ?? {}).sort(),
      artifacts: plan.artifacts,
      ...(tainted ? { taint: "This conversation has read untrusted input; the command and its data may have been shaped by it." } : {}),
    };
  }

  function forTurn(ctx: ComputeTurnContext) {
    const caller = (): HostedCaller | ComputeToolResult => {
      const session = ctx.sessionId();
      if (!session) return refusal("policy_denied", "This conversation has no session yet; external compute is available once it has one.");
      return { kind: "hosted", principal: ctx.principalId, session, turn: ctx.turnId };
    };
    // The conversation's earlier turns, and this turn's events not yet bound to its session.
    const tainted = (session: string) => {
      try {
        return queryGovernanceEvents(db, { sessionId: session, kinds: ["taint"], limit: 1 }).length > 0
          || queryGovernanceEvents(db, { turnId: ctx.turnId, kinds: ["taint"], limit: 1 }).length > 0;
      } catch { return true; }
    };
    const canAsk = () => !ctx.autonomous && ctx.posture !== "voice" && !ctx.noGrantSurface && ctx.hasClient();

    return async function compute(call: ComputeToolCall): Promise<ComputeToolResult> {
      if (!ctx.isCurrent()) return refusal("policy_denied", "This turn no longer has current authority.");
      if (ctx.autonomous) return refusal("policy_denied", "External compute is not available to autonomous turns.");
      await coreModule();
      const disabled = disabledReason();
      if (disabled) return refusal("compute_disabled", `Hosted external compute is off: ${disabled}.`);
      const who = caller();
      if ("ok" in who) return who;
      const toolName = ctx.toolName(call.tool);

      if (call.tool === "brain_compute_status" || call.tool === "brain_compute_cancel" || call.tool === "brain_compute_collect") {
        // Only this conversation's own jobs, by the host's record; core checks the caller again.
        const jobInput = (call as JobCall).input;
        const row = jobRow(jobInput.job);
        if (!row || row.principal_id !== who.principal || row.session_id !== who.session) {
          return refusal("job_unknown", `no compute job ${jobInput.job} for this conversation`);
        }
        const ops = await opsForJob(row);
        if (!ops) return refusal("provider_unavailable", "The job's admission record cannot be read.");
        try {
          const result = call.tool === "brain_compute_status" ? await ops.status(jobInput)
            : call.tool === "brain_compute_cancel" ? await ops.cancel(jobInput) : await ops.collect(jobInput);
          if (!result.ok) return redact(result);
          observe(row, result.job);
          if (!settledJob(result.job)) track(row.job_id);
          if (call.tool === "brain_compute_collect" && "output" in result) {
            // A host path is never handed to the model: artifacts are named by path and hash.
            const collected = result as Extract<Awaited<ReturnType<ComputeOps["collect"]>>, { ok: true }>;
            return redact({ ...collected, artifacts: collected.artifacts.map(({ file: _file, ...artifact }) => artifact) });
          }
          return redact(result);
        } catch (error) {
          log("WARN", `hosted compute ${call.tool} failed: ${String(error)}`);
          return refusal("provider_unavailable", "The compute service failed; the job's record is unchanged. Try status again later.");
        }
      }

      const read = await turnConfig(ctx);
      if (!read.ok) return refusal("compute_disabled", `External compute is unavailable in this turn: ${read.reason}.`);
      if (!read.config.enabled) return refusal("compute_disabled", "No compute providers are configured (brain.config `compute`).");
      const builtinsOnly: Record<string, InstanceConfig> = {};
      for (const [id, instance] of Object.entries(read.config.providers)) if (!instance.byValue && instance.provider !== null) builtinsOnly[id] = instance;

      if (call.tool === "brain_compute_health") {
        const ops = await opsFor(who, builtinsOnly);
        if (!ops) return refusal("compute_disabled", "@schlessera/brain is not installed on this host.");
        const report = await ops.health((call as HealthCall).input);
        if (!report.ok) return redact(report);
        const wanted = (call as HealthCall).input.provider;
        const byValue = Object.entries(read.config.providers).filter(([id, instance]) => instance.byValue && (!wanted || wanted === id))
          .map(([id]) => ({ id, provider: null, status: "provider_unavailable" as const, reason: "hosted runs accept only built-in providers", capabilities: null }));
        const unbound = await Promise.all(report.instances.map(async instance => {
          const refused = await instanceRefusal(instance.id, read.config.providers[instance.id]!);
          return refused && !refused.ok ? { ...instance, status: "provider_unavailable" as const, reason: refused.error.message } : instance;
        }));
        return redact({ ...report, instances: [...unbound, ...byValue].sort((a, b) => a.id.localeCompare(b.id)) });
      }

      // plan and run
      const input = (call as RequestCall).input;
      const instance = read.config.providers[input.provider];
      if (instance) {
        const refused = await instanceRefusal(input.provider, instance);
        if (refused) return refused;
      }
      for (const path of [...(input.source ?? []), ...(input.cwd !== undefined ? [input.cwd] : [])]) {
        const normalized = posix.normalize(path).replace(/^\.\//, "");
        if (isEnvName(normalized.split("/")[0]!) || PROTECTED_TIER_A.some(protectedPath => normalized === protectedPath || normalized.startsWith(`${protectedPath}/`))) {
          return refusal("source_refused", `${path} is a protected path (secrets, governance or start-up code) and is never sent to a provider`);
        }
      }
      try {
        ctx.maskGuard?.assert(toolName, [...(input.source ?? []), ...(input.cwd !== undefined ? [input.cwd] : [])]);
      } catch (error) {
        if (error instanceof ProviderMaskRefusedError) return refusal("source_refused", error.message);
        throw error;
      }
      const run = call.tool === "brain_compute_run";
      const approve = async (plan: ComputePlan): Promise<"approved" | "required" | "denied"> => {
        if (!run) return canAsk() ? "approved" : "required";
        const isTainted = tainted(who.session);
        const record = (decision: "approved" | "declined" | "refused") => {
          const recorded = JSON.stringify({ instance: plan.instance, argv: input.argv, source: plan.source.hash, lease_seconds: plan.lease.seconds });
          try {
            ctx.govern({ kind: "outward_action", payload: { tool: toolName, input: recorded.slice(0, MAX_RECORDED_INPUT), inputTruncated: recorded.length > MAX_RECORDED_INPUT,
              action: "compute_run", target: plan.instance, historyRewrite: false, tainted: isTainted, decision, rule: null } as never });
          } catch (error) { log("WARN", `compute outward action not recorded: ${String(error)}`); }
        };
        if (!canAsk()) { record("refused"); return "required"; }
        const decision = await ctx.requestPermission({ toolUseId: call.toolUseId ?? `compute-${crypto.randomUUID()}`, toolName, kind: "command",
          input: approvalCard(input, plan, isTainted),
          description: `Run this command on the external compute instance "${plan.instance}". The listed files are uploaded, paid time runs up to the lease, and the job outlives this turn until it is collected, cancelled or its lease ends.` });
        // An edited card is a different request: it is refused, never run as edited.
        const approved = decision.behavior === "allow" && decision.updatedInput === undefined;
        record(approved ? "approved" : "declined");
        return approved ? "approved" : "denied";
      };
      const ops = await opsFor(who, builtinsOnly, { sourcePolicy: ctx.policy, approve, recheck: () => ctx.isCurrent(), budget: ledgerFor(ctx) });
      if (!ops) return refusal("compute_disabled", "@schlessera/brain is not installed on this host.");
      try {
        if (!run) return redact(await ops.plan(input));
        const result = await ops.run(input, {
          onCreated: jobId => {
            const runId = `${COMPUTE_RUN_PREFIX}${jobId}`;
            const row: JobRow = { job_id: jobId, principal_id: who.principal, session_id: who.session, turn_id: who.turn, tool_use_id: call.toolUseId ?? null,
              instance: input.provider, instance_config: JSON.stringify(instance), run_id: runId, created_at: now(), settled_at: null, observed: null };
            db.query(`INSERT INTO compute_hosted_jobs (job_id, principal_id, session_id, turn_id, tool_use_id, instance, instance_config, run_id, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(row.job_id, row.principal_id, row.session_id, row.turn_id, row.tool_use_id, row.instance, row.instance_config, row.run_id, row.created_at);
            startRun(row, { "brain.compute.provider": instance?.provider ?? null, "brain.compute.lease_seconds": input.lease_seconds ?? instance?.lease.maxSeconds ?? null,
              "brain.compute.estimate_usd": instance?.hourlyCeilingUsd != null ? (instance.hourlyCeilingUsd * (input.lease_seconds ?? instance.lease.maxSeconds)) / 3600 : null });
            track(jobId);
          },
        });
        if (result.ok) {
          const row = jobRow(result.job.id);
          if (row) {
            if (options.activity?.store) activityWrite("event", () => options.activity!.store.patchSpan(row.run_id, { attrs: { "brain.compute.source_hash": result.job.source.hash } }));
            observe(row, result.job);
          }
        }
        return redact(result);
      } catch (error) {
        log("WARN", `hosted compute ${call.tool} failed: ${String(error)}`);
        return refusal("provider_unavailable", "The compute service failed before the job started; nothing new is running.");
      }
    };
  }

  return {
    forTurn,

    async cancelTurn(turnId, reason) {
      turnConfigs.delete(turnId);
      await cancelRows(openRows(" AND turn_id = ?", turnId), reason);
    },

    endTurn(turnId) {
      turnConfigs.delete(turnId);
    },

    async cancelSession(sessionId) {
      await cancelRows(openRows(" AND session_id = ?", sessionId), "the conversation was deleted");
    },

    async recover() {
      await coreModule();
      for (const provider of Object.keys(options.keys)) await builtin(provider);
      const disabled = disabledReason();
      if (disabled) log("WARN", `hosted external compute is off: ${disabled}`);
      for (const row of openRows()) {
        // Reattach: keep the run alive in Activity and visit it once now, so a
        // job that finished while the host was down settles its ledger once.
        if (options.activity?.store) activityWrite("heartbeat", () => options.activity!.store.heartbeat(row.run_id, now()));
        track(row.job_id);
      }
      if (tracked.size) {
        if (timer) { clearTimeout(timer); timer = undefined; }
        await pass();
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await busy;
      await Promise.allSettled([...inflight]);
      // A provider with its own remote expiry stops on its own; anything else
      // would run unbounded while the host is down, so it is cancelled now.
      const unbounded: JobRow[] = [];
      for (const row of openRows()) {
        let provider: string | null = null;
        try { provider = InstanceSummary.parse(JSON.parse(row.instance_config)).provider; } catch { /* unknown: cancel */ }
        if (!provider || (await builtin(provider)).remoteExpiry !== true) unbounded.push(row);
      }
      await cancelRows(unbounded, "the host shut down and this provider has no remote expiry");
      tracked.clear();
      if (timer) clearTimeout(timer);
      timer = undefined;
    },

    status() {
      const reason = disabledReason();
      const providers = providersOfInterest();
      return {
        enabled: reason === null,
        reason,
        core: core === undefined ? "unknown" : core === null ? "missing" : "present",
        stateDir: options.stateDir,
        stateMasked: options.stateMasked,
        bindings: providers.map(provider => {
          const known = builtins.get(provider);
          const explicit = new Set(options.keys[provider] ?? []);
          return {
            provider,
            package: known?.package ?? "unknown",
            remoteExpiry: known?.remoteExpiry ?? null,
            defaultKeyEnv: known?.defaultKeyEnv ?? null,
            credentials: [...boundNames(provider)].sort().map(name => ({ name, implicit: !explicit.has(name), present: Boolean(credential(name)), leakedToWorkers: leaked(name) })),
          };
        }),
        instances: lastInstances,
        openJobs: (db.query("SELECT COUNT(*) AS n FROM compute_hosted_jobs WHERE settled_at IS NULL").get() as { n: number }).n,
      };
    },

    async drive() {
      if (timer) { clearTimeout(timer); timer = undefined; }
      await busy;
      await pass();
    },
  };
}

/**
 * Read a brain's compute summary as data (#3108), as the provider taxonomy is
 * read (#2694, #2699): `brain config check --json` in a credential-free
 * strict worker on an immutable startup view, seeing only the policy's
 * protected paths, so neither code nor configuration a turn could change
 * decides which instances, options and credential names the host uses.
 * Repository code never runs on the host.
 */
export async function readHostedComputeConfig(options: {
  brainPath: string;
  nativeManager: Parameters<typeof import("@schlessera/brain-ui-sdk/internal").prepareNativeWorkerStartupView>[1];
  maskPaths: readonly string[];
  policy: Pick<EffectiveGovernancePolicy, "providers" | "protect" | "release">;
  signal: AbortSignal;
  command?: readonly string[];
}): Promise<ComputeConfigRead> {
  const { prepareNativeWorkerStartupView } = await import("@schlessera/brain-ui-sdk/internal");
  const { taxonomyProtection } = await import("./provider-types.js");
  const { providerFolderRoots } = await import("./governance-policy.js");
  const { createPrivateIndexDirectory, removePrivateIndexDirectory, runMaskedBrainCli } = await import("./private-index.js");
  const { taxonomyArgv } = await import("./client.js");
  const protection = taxonomyProtection(options.brainPath, options.policy, options.command);
  if (!protection.ok) return { ok: false, reason: `the brain's configuration is not protected: ${protection.reason}` };
  const view = await prepareNativeWorkerStartupView(options.brainPath, options.nativeManager, options.signal);
  const scratch = createPrivateIndexDirectory();
  try {
    const run = await runMaskedBrainCli({ brainPath: options.brainPath, startupView: view, folders: providerFolderRoots(options.policy), index: scratch,
      maskPaths: options.maskPaths, signal: options.signal, timeoutMs: 30_000, command: taxonomyArgv(options.brainPath, options.command),
      label: "brain config check", outputBytes: 1024 * 1024, visible: protection.visible });
    if (!run.ok) return { ok: false, reason: run.detail };
    let parsed: unknown;
    try { parsed = JSON.parse(run.stdout); } catch { return { ok: false, reason: "brain config check did not print JSON" }; }
    const compute = (parsed as { valid?: unknown; compute?: unknown }).valid === true ? (parsed as { compute?: unknown }).compute : undefined;
    if (compute === undefined) return { ok: false, reason: "this brain's CLI reports no compute summary; upgrade @schlessera/brain in the brain repo" };
    const summary = HostedComputeSummary.safeParse(compute);
    return summary.success ? { ok: true, config: summary.data } : { ok: false, reason: "the brain's compute summary did not parse" };
  } finally {
    removePrivateIndexDirectory(scratch);
    await view.cleanup();
  }
}
