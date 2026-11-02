/**
 * The host-independent external compute service: one operation set for the
 * CLI, MCP and hosted layers (docs/decisions/external-compute.md). Admission
 * is the same function for every caller kind; the host supplies the caller,
 * the budget ledger, approval and data-to-provider policy.
 *
 * With no `compute` key in the config, every operation except `health`
 * refuses with `compute_disabled` before touching the filesystem.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import { writeFileSafely } from "../safe-path.js";
import { resolveComputeInstance, type ResolvedComputeInstance } from "../registry.js";
import type { ComputeCapabilities, ComputeLogger } from "../seams.js";
import {
  checkArtifacts,
  checkCaller,
  checkCapabilities,
  checkCommand,
  checkEnv,
  checkLease,
  checkRetain,
  checkSecretFree,
  refuse,
  resolveSource,
  sameCaller,
  wantsRetain,
} from "./admission.js";
import { JobDriver, callProvider, type DriveMode, type LifecycleDeps } from "./lifecycle.js";
import { acquireLock, tryLock, type HeldLock } from "./lock.js";
import { computeBrainKey, existingComputeStateDir, resolveComputeStateDir } from "./state-dir.js";
import { ComputeJobStore, newComputeJobId, receipt } from "./store.js";
import {
  isTerminal,
  type ComputeCaller,
  type ComputeClock,
  type ComputeJobRecord,
  type ComputeJobResult,
  type ComputeJobView,
  type ComputePlan,
  type ComputeRefusal,
  type ComputeRunRequest,
  type ComputeServiceOptions,
} from "./types.js";

const DEFAULT_RELEASE_ALLOWANCE_SECONDS = 300;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_LOCK_WAIT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const COLLECT_TEXT_BYTES = 64 * 1024;

const SILENT: ComputeLogger = { debug() {}, warn() {} };
const SYSTEM_CLOCK: ComputeClock = { now: () => Date.now() };

export interface ComputeInstanceHealth {
  id: string;
  provider: string | null;
  status: "ready" | "provider_unknown" | "provider_unavailable";
  reason: string | null;
  capabilities: ComputeCapabilities | null;
}

export interface ComputeHealthReport {
  ok: true;
  enabled: boolean;
  instances: ComputeInstanceHealth[];
}

export interface ComputeCollection {
  ok: true;
  job: ComputeJobView;
  output: { stdout: string | null; stderr: string | null; truncated: boolean };
  artifacts: { path: string; status: string; bytes: number | null; sha256: string | null; file: string | null }[];
}

export interface ComputeReconcileReport {
  ok: true;
  visited: { id: string; state: ComputeJobRecord["state"]; cleanup: ComputeJobRecord["cleanup"]["state"] }[];
  skipped: { id: string; reason: string }[];
}

export interface ComputeService {
  health(instance?: string): Promise<ComputeHealthReport | ComputeRefusal>;
  plan(caller: ComputeCaller, request: ComputeRunRequest): Promise<{ ok: true; plan: ComputePlan } | ComputeRefusal>;
  /** `hooks.onCreated` hears the job id once its record exists, before any provider call. */
  run(caller: ComputeCaller, request: ComputeRunRequest, hooks?: ComputeRunHooks): Promise<ComputeJobResult>;
  status(caller: ComputeCaller, jobId: string): Promise<ComputeJobResult>;
  cancel(caller: ComputeCaller, jobId: string): Promise<ComputeJobResult>;
  collect(caller: ComputeCaller, jobId: string): Promise<ComputeCollection | ComputeRefusal>;
  /** Accept an unresolved `uncertain` outcome; a known sandbox is still released. */
  abandon(caller: ComputeCaller, jobId: string): Promise<ComputeJobResult>;
  /** Visit every unfinished job of this brain not held by a live process. */
  reconcile(): Promise<ComputeReconcileReport | ComputeRefusal>;
}

export interface ComputeRunHooks {
  onCreated?(jobId: string): void;
}

export function computeJobView(job: ComputeJobRecord, blocked: string | null = null): ComputeJobView {
  return {
    id: job.id,
    instance: job.instance,
    provider: job.provider,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lease: { seconds: job.lease.seconds, deadline: job.lease.deadline },
    source: { hash: job.source.hash, files: job.source.files.length },
    exit: job.exit,
    artifacts: job.artifacts.map((a) => ({ path: a.path, status: a.status, bytes: a.bytes, sha256: a.sha256 })),
    cleanup: { state: job.cleanup.state, retainedUntil: job.cleanup.retainedUntil, lastError: job.cleanup.lastError },
    cost: job.cost,
    cancelRequested: job.cancelRequested,
    uncertain: job.uncertain,
    terminal: job.terminal,
    blocked,
  };
}

interface Admitted {
  instance: ResolvedComputeInstance;
  plan: ComputePlan;
  env: Record<string, string>;
}

/** JSON with object keys sorted, so a reordered config hashes the same. */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (typeof v !== "object" || v === null) return v;
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
  };
  return JSON.stringify(sort(value)) ?? "null";
}

export function createComputeService(options: ComputeServiceOptions): ComputeService {
  const providers = options.config?.compute?.providers;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const log = options.log ?? SILENT;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const allowance = options.releaseAllowanceSeconds ?? DEFAULT_RELEASE_ALLOWANCE_SECONDS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const transport = options.fetch ?? globalThis.fetch;
  const disabled = () => refuse("compute_disabled", "no compute providers are configured (brain.config `compute`)");
  const unknownJob = (id: string) => refuse("job_unknown", `no compute job ${id} for this caller`);

  let store: ComputeJobStore | undefined;
  let brain: string | undefined;
  const state = (): { store: ComputeJobStore; brain: string } => {
    if (!store) {
      const dir = resolveComputeStateDir({ root: options.root, override: options.stateDir, env: options.env });
      brain = computeBrainKey(options.root);
      store = new ComputeJobStore(dir, options.storeHooks);
      store.describeBrain(brain, realpathSync(options.root));
    }
    return { store, brain: brain! };
  };

  /** Every readable record without creating the state directory or writing anything. */
  function peekJobs(): ComputeJobRecord[] {
    if (store) return listJobs(store).jobs;
    const dir = existingComputeStateDir({ root: options.root, override: options.stateDir, env: options.env });
    return dir === undefined ? [] : listJobs(new ComputeJobStore(dir, options.storeHooks, { create: false })).jobs;
  }

  async function instanceFor(id: string): Promise<ResolvedComputeInstance | ComputeRefusal> {
    if (typeof id !== "string" || !providers || !Object.hasOwn(providers, id)) {
      return refuse("provider_unknown", `no compute instance named "${String(id)}"; configured: ${Object.keys(providers ?? {}).sort().join(", ") || "none"}`);
    }
    const resolved = await resolveComputeInstance(id, providers[id], { env: options.env, registry: options.registry });
    return resolved.ok ? resolved.instance : refuse(resolved.code, resolved.reason);
  }

  function credentialNames(instance: ResolvedComputeInstance): Set<string> {
    const names = new Set<string>();
    for (const entry of Object.values(providers ?? {})) if (entry.apiKeyEnv) names.add(entry.apiKeyEnv);
    if (instance.keyEnv) names.add(instance.keyEnv);
    return names;
  }

  /**
   * Where a job's provider effects go: the implementation, its options and
   * the credential variable. A job is only driven while its instance still
   * hashes the same, so a release never reaches another account or region.
   * Limits (lease, slots, ceiling) are not part of it: changing them must
   * not strand running jobs.
   */
  function configHash(instance: ResolvedComputeInstance): string {
    const target = { provider: instance.provider.id, options: instance.config.options ?? null, keyEnv: instance.keyEnv ?? null };
    return createHash("sha256").update(canonicalJson(target)).digest("hex");
  }

  /** The instance a job's effects may go to, or why none may now. */
  async function target(job: ComputeJobRecord): Promise<{ instance: ResolvedComputeInstance } | { blocked: string }> {
    const instance = await instanceFor(job.instance);
    if ("ok" in instance) return { blocked: instance.reason };
    if (instance.provider.id !== job.provider) return { blocked: `"${job.instance}" now names a different provider` };
    if (configHash(instance) !== job.configHash) {
      return {
        blocked: `"${job.instance}" was reconfigured after this job started (its provider options or credential variable changed); no provider call is made for it until that configuration is restored`,
      };
    }
    return { instance };
  }

  /** Every readable record; an unreadable one is logged and left alone. */
  function listJobs(jobStore: ComputeJobStore): { jobs: ComputeJobRecord[]; unreadable: { id: string; reason: string }[] } {
    const listed = jobStore.list();
    for (const u of listed.unreadable) log.warn("compute: skipping a job record this version cannot read", { id: u.id, reason: u.reason });
    return listed;
  }

  /**
   * Jobs holding a slot: still active, awaiting cleanup, or retained with
   * their retention not yet over (the provider still holds their data).
   */
  function slotsUsed(jobs: ComputeJobRecord[], instance: string): number {
    const now = clock.now();
    return jobs.filter(
      (j) =>
        j.instance === instance &&
        (!isTerminal(j.state) ||
          j.cleanup.state === "pending" ||
          j.cleanup.state === "release_failed" ||
          (j.cleanup.state === "retained" && (j.cleanup.retainedUntil === null || j.cleanup.retainedUntil > now)))
    ).length;
  }

  /** Every check that needs no lock and has no effect. */
  async function admit(caller: ComputeCaller, request: ComputeRunRequest): Promise<Admitted | ComputeRefusal> {
    if (!providers) return disabled();
    const who = checkCaller(caller);
    if (who) return who;
    if (!request || typeof request !== "object") return refuse("policy_denied", "a compute request is required");
    if (request.retain !== undefined && typeof request.retain !== "boolean") return refuse("policy_denied", "retain must be true or false");
    const instance = await instanceFor(request.instance);
    if ("ok" in instance) return instance;
    const unsupported = checkCapabilities(instance, request);
    if (unsupported) return unsupported;
    const retention = checkRetain(instance, request);
    if (retention) return retention;
    const lease = checkLease(instance, request.leaseSeconds);
    if ("ok" in lease) return lease;
    const secretFree = checkSecretFree(request, instance.secret);
    if (secretFree) return secretFree;
    const command = checkCommand(request);
    if (command) return command;
    const artifacts = checkArtifacts(request.artifacts);
    if ("ok" in artifacts) return artifacts;
    const caps = instance.provider.capabilities;
    const source = resolveSource(options.root, request.source, instance.id, options.sourcePolicy, caps.stage === false ? undefined : caps.stage.maxBytes);
    if ("ok" in source) return source;
    const checked = checkEnv(request.env, credentialNames(instance), instance.secret);
    if ("ok" in checked) return checked;
    const env = checked.env;
    const ceiling = instance.config.hourlyCeilingUsd;
    const plan: ComputePlan = {
      instance: instance.id,
      provider: instance.provider.id,
      lease: { seconds: lease.seconds, releaseAllowanceSeconds: allowance },
      source,
      artifacts,
      estimate: ceiling !== undefined ? { usd: (ceiling * lease.seconds) / 3600, basis: "ceiling" } : { usd: null, basis: "none" },
      retain: wantsRetain(instance, request),
      slots: { used: 0, max: instance.config.maxConcurrent ?? 1 },
    };
    if (options.approve) {
      const approval = await options.approve(plan, caller);
      if (approval === "required") return refuse("approval_required", `running on "${instance.id}" needs approval`);
      if (approval !== "approved") return refuse("policy_denied", `running on "${instance.id}" was not approved`);
    }
    return { instance, plan, env };
  }

  function newRecord(id: string, brainKey: string, caller: ComputeCaller, admitted: Admitted, request: ComputeRunRequest): ComputeJobRecord {
    const now = clock.now();
    const { instance, plan } = admitted;
    return {
      schema: 1,
      id,
      brain: brainKey,
      caller,
      instance: instance.id,
      provider: instance.provider.id,
      configHash: configHash(instance),
      state: "admitted",
      createdAt: now,
      updatedAt: now,
      lease: { seconds: plan.lease.seconds, deadline: now + plan.lease.seconds * 1000, releaseAllowanceSeconds: allowance },
      request: { argv: [...request.argv], cwd: request.cwd ?? null, env: admitted.env, retain: plan.retain },
      source: plan.source,
      allocation: { key: id, attempts: 0, sandbox: null },
      command: { intentAt: null, handle: null, startedAt: null },
      stageAttempts: 0,
      collectAttempts: 0,
      exit: null,
      output: null,
      artifacts: plan.artifacts.map((a) => ({ ...a, status: "pending", bytes: null, sha256: null })),
      outcome: null,
      cleanup: {
        state: "none",
        mode: plan.retain && instance.provider.capabilities.retain !== false ? "retain" : "discard",
        retainedUntil: null,
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
      },
      cost: { estimate: plan.estimate, actual: { usd: null, coverage: "unknown", source: "none" } },
      reservation: { usd: plan.estimate.usd, enforced: options.budget !== undefined, settled: false },
      cancelRequested: false,
      uncertain: null,
      terminal: null,
      receipts: [{ at: now, step: "admit", phase: "outcome", outcome: "admitted" }],
    };
  }

  function deps(instance: ResolvedComputeInstance, jobStore: ComputeJobStore): LifecycleDeps {
    return { root: options.root, store: jobStore, clock, instance, callTimeoutMs, maxOutputBytes, fetch: transport, log, budget: options.budget };
  }

  /** The caller's own job of this brain, or undefined. */
  function own(caller: ComputeCaller, jobId: string): { job: ComputeJobRecord; store: ComputeJobStore } | undefined {
    const s = state();
    const job = s.store.read(jobId);
    if (!job || job.brain !== s.brain || !sameCaller(job.caller, caller)) return undefined;
    return { job, store: s.store };
  }

  /**
   * Advance a job when no live process holds it; otherwise report it as
   * recorded. `blocked` says why a job that is not held could not be driven.
   */
  async function advance(
    job: ComputeJobRecord,
    jobStore: ComputeJobStore,
    mode: DriveMode,
    lock?: HeldLock
  ): Promise<{ job: ComputeJobRecord; blocked: string | null }> {
    const held = lock ?? tryLock(jobStore.ownerLockPath(job.id));
    if (!held) return { job, blocked: null };
    try {
      const fresh = jobStore.read(job.id) ?? job;
      const found = await target(fresh);
      if ("blocked" in found) return { job: fresh, blocked: found.blocked };
      return { job: await new JobDriver(fresh, deps(found.instance, jobStore)).drive(mode), blocked: null };
    } finally {
      held.release();
    }
  }

  const view = (advanced: { job: ComputeJobRecord; blocked: string | null }) => computeJobView(advanced.job, advanced.blocked);

  return {
    async health(id) {
      if (!providers) return { ok: true, enabled: false, instances: [] };
      if (id !== undefined && !Object.hasOwn(providers, id)) return refuse("provider_unknown", `no compute instance named "${id}"`);
      const ids = id !== undefined ? [id] : Object.keys(providers).sort();
      const instances: ComputeInstanceHealth[] = [];
      for (const name of ids) {
        const instance = await instanceFor(name);
        if ("ok" in instance) {
          instances.push({ id: name, provider: null, status: instance.code === "provider_unknown" ? "provider_unknown" : "provider_unavailable", reason: instance.reason, capabilities: null });
          continue;
        }
        const health = await callProvider(
          { clock, instance, callTimeoutMs, fetch: transport, log },
          clock.now() + callTimeoutMs,
          (ctx) => instance.provider.health(ctx)
        );
        instances.push({
          id: name,
          provider: instance.provider.id,
          status: health.kind === "ok" ? "ready" : "provider_unavailable",
          reason: health.kind === "ok" ? null : health.reason,
          capabilities: instance.provider.capabilities,
        });
      }
      return { ok: true, enabled: true, instances };
    },

    async plan(caller, request) {
      const admitted = await admit(caller, request);
      if ("ok" in admitted) return admitted;
      // Plan has no effect: it counts slots from whatever records exist and
      // creates neither the state directory nor its brain.json.
      admitted.plan.slots.used = slotsUsed(peekJobs(), admitted.instance.id);
      return { ok: true, plan: admitted.plan };
    },

    async run(caller, request, hooks) {
      const admitted = await admit(caller, request);
      if ("ok" in admitted) return admitted;
      const { store: jobStore, brain: brainKey } = state();
      const admission = await acquireLock(jobStore.admissionLockPath, lockWaitMs);
      if (!admission) return refuse("concurrency_exhausted", "another process held compute admission past the wait; retry");
      let job: ComputeJobRecord;
      let owner: HeldLock | undefined;
      try {
        if (options.recheck) {
          let current = false;
          try {
            current = await options.recheck(caller);
          } catch {
            current = false;
          }
          if (!current) return refuse("policy_denied", "the caller no longer has authority to start this job");
        }
        const used = slotsUsed(listJobs(jobStore).jobs, admitted.instance.id);
        if (used >= admitted.plan.slots.max) {
          return refuse("concurrency_exhausted", `"${admitted.instance.id}" has ${used} of ${admitted.plan.slots.max} jobs running or awaiting cleanup`);
        }
        const id = newComputeJobId();
        if (options.budget) {
          let verdict: "ok" | "exceeded";
          try {
            verdict = await options.budget.reserve(id, admitted.plan.estimate.usd, caller);
          } catch (error) {
            return refuse("accounting_unavailable", `the budget ledger is unavailable: ${(error as Error).message}`);
          }
          if (verdict !== "ok") return refuse("budget_exceeded", "the budget cannot cover this job's reservation");
        }
        job = newRecord(id, brainKey, caller, admitted, request);
        try {
          jobStore.prepare(id);
          owner = tryLock(jobStore.ownerLockPath(id));
          if (!owner) throw new Error("a fresh job's owner lock was already held");
          jobStore.create(job);
        } catch (error) {
          owner?.release();
          if (options.budget) await Promise.resolve(options.budget.settle(id, null)).catch(() => {});
          throw error;
        }
      } finally {
        admission.release();
      }
      try {
        hooks?.onCreated?.(job.id);
      } catch (error) {
        log.warn("compute: a run hook threw", { id: job.id, reason: (error as Error).message });
      }
      return { ok: true, job: view(await advance(job, jobStore, "start", owner)) };
    },

    async status(caller, jobId) {
      if (!providers) return disabled();
      const found = own(caller, jobId);
      if (!found) return unknownJob(jobId);
      return { ok: true, job: view(await advance(found.job, found.store, "progress")) };
    },

    async cancel(caller, jobId) {
      if (!providers) return disabled();
      const found = own(caller, jobId);
      if (!found) return unknownJob(jobId);
      if (!isTerminal(found.job.state)) {
        writeFileSafely(found.store.cancelMarkerPath(jobId), `${clock.now()}\n`, { mode: 0o600 });
      }
      const lock = await acquireLock(found.store.ownerLockPath(jobId), lockWaitMs);
      if (!lock) return { ok: true, job: computeJobView(found.store.read(jobId) ?? found.job) };
      return { ok: true, job: view(await advance(found.job, found.store, "progress", lock)) };
    },

    async collect(caller, jobId) {
      if (!providers) return disabled();
      const found = own(caller, jobId);
      if (!found) return unknownJob(jobId);
      const advanced = await advance(found.job, found.store, "progress");
      const job = advanced.job;
      const text = (stream: "stdout" | "stderr") => {
        const data = found.store.readOutput(jobId, stream);
        return data === undefined ? null : new TextDecoder().decode(data.subarray(0, COLLECT_TEXT_BYTES));
      };
      const outputBytes = job.output?.stdout?.bytes ?? 0;
      const stderrBytes = job.output?.stderr?.bytes ?? 0;
      return {
        ok: true,
        job: view(advanced),
        output: {
          stdout: text("stdout"),
          stderr: text("stderr"),
          truncated: (job.output?.truncated ?? false) || outputBytes > COLLECT_TEXT_BYTES || stderrBytes > COLLECT_TEXT_BYTES,
        },
        artifacts: job.artifacts.map((a) => ({
          path: a.path,
          status: a.status,
          bytes: a.bytes,
          sha256: a.sha256,
          file: a.sha256 ? found.store.artifactPath(jobId, a.sha256) : null,
        })),
      };
    },

    async abandon(caller, jobId) {
      if (!providers) return disabled();
      const found = own(caller, jobId);
      if (!found) return unknownJob(jobId);
      const lock = await acquireLock(found.store.ownerLockPath(jobId), lockWaitMs);
      if (!lock) return refuse("concurrency_exhausted", "another process is advancing this job");
      try {
        const job = found.store.read(jobId)!;
        if (job.state !== "uncertain") {
          lock.release();
          return refuse("policy_denied", `only an uncertain job can be abandoned; ${jobId} is ${job.state}`);
        }
        const now = clock.now();
        receipt(job, now, { step: "abandon", phase: "outcome", outcome: "accepted" });
        job.outcome = { state: "abandoned", reason: `operator accepted: ${job.uncertain?.reason ?? "uncertain"}` };
        if (job.allocation.sandbox) job.state = "releasing";
        else {
          job.state = "abandoned";
          job.cleanup.state = job.allocation.attempts > 0 ? "unknown" : "none";
          job.terminal = { state: "abandoned", at: now, reason: job.outcome.reason };
        }
        job.uncertain = null;
        job.updatedAt = now;
        found.store.write(job);
        return { ok: true, job: view(await advance(job, found.store, "progress", lock)) };
      } catch (error) {
        lock.release();
        throw error;
      }
    },

    async reconcile() {
      if (!providers) return disabled();
      const { store: jobStore, brain: brainKey } = state();
      const listed = listJobs(jobStore);
      const report: ComputeReconcileReport = { ok: true, visited: [], skipped: [...listed.unreadable] };
      for (const job of listed.jobs) {
        if (job.brain !== brainKey) continue;
        const settled = isTerminal(job.state) && job.reservation.settled && job.cleanup.state !== "release_failed" && job.cleanup.state !== "pending";
        if (settled) continue;
        const lock = tryLock(jobStore.ownerLockPath(job.id));
        if (!lock) {
          report.skipped.push({ id: job.id, reason: "held by a live process" });
          continue;
        }
        const after = await advance(job, jobStore, "progress", lock);
        if (after.blocked !== null) {
          report.skipped.push({ id: job.id, reason: after.blocked });
          continue;
        }
        report.visited.push({ id: after.job.id, state: after.job.state, cleanup: after.job.cleanup.state });
      }
      return report;
    },
  };
}
