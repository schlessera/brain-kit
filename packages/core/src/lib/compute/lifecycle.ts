/**
 * The job lifecycle: one provider effect per step, each bracketed by an
 * intent receipt written before the call and an outcome receipt after it, so
 * a process that dies mid-call leaves a record reconciliation can resolve
 * without repeating a non-idempotent effect. The lease is checked before
 * every step. The caller holds the job's owner lock.
 */

import { existsSync } from "node:fs";

import type { ResolvedComputeInstance } from "../registry.js";
import type {
  CommandStatus,
  ComputeContext,
  ComputeLogger,
  ComputeUncertain,
  ReleaseOutcome,
} from "../seams.js";
import { loadSourceBundle } from "./admission.js";
import { receipt, sha256Hex, type ComputeJobStore } from "./store.js";
import {
  isTerminal,
  type ComputeBudget,
  type ComputeClock,
  type ComputeJobRecord,
  type ComputeReceipt,
  type ComputeTerminalState,
} from "./types.js";

export interface LifecycleDeps {
  root: string;
  store: ComputeJobStore;
  clock: ComputeClock;
  instance: ResolvedComputeInstance;
  callTimeoutMs: number;
  maxOutputBytes: number;
  fetch: typeof fetch;
  log: ComputeLogger;
  budget?: ComputeBudget;
}

/**
 * `start`: allocate an admitted job and stop once its command runs.
 * `progress`: never allocate an admitted job (its starter died before
 * allocating, so it is cancelled); poll once and carry an exited command
 * through collection and release.
 */
export type DriveMode = "start" | "progress";

const MAX_STEPS = 32;
const MAX_ALLOCATE_ATTEMPTS = 3;
const MAX_STAGE_ATTEMPTS = 3;
const MAX_COLLECT_ATTEMPTS = 3;
/** Reads of a usage report before the host settles with what it has. */
const MAX_USAGE_READS = 5;
/** Grace after a call's deadline before the host stops waiting for it. */
const ABORT_GRACE_MS = 250;
const RELEASE_BACKOFF_MS = 30_000;
const RELEASE_BACKOFF_MAX_MS = 3_600_000;

export function redact(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

/**
 * Redact every string in a value, keys included, by walking it rather than
 * its JSON text: a secret holding a quote or a backslash is escaped in JSON
 * and would slip past a text match.
 */
export function redactDeep(value: unknown, secret: string | undefined, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redact(value, secret);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secret, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[redact(k, secret)] = redactDeep(v, secret, seen);
  return out;
}

/** A logger that never lets the instance secret through. */
export function redactingLogger(log: ComputeLogger, secret: string | undefined): ComputeLogger {
  const clean = (data?: Record<string, unknown>) =>
    data === undefined ? undefined : (redactDeep(data, secret) as Record<string, unknown>);
  return {
    debug: (message, data) => log.debug(redact(message, secret), clean(data)),
    warn: (message, data) => log.warn(redact(message, secret), clean(data)),
  };
}

/** An outcome with its `reason` and `detail` strings redacted. */
function redactOutcome<T>(value: T, secret: string | undefined): T {
  if (!secret || typeof value !== "object" || value === null) return value;
  const fields = value as { reason?: unknown; detail?: unknown };
  if (typeof fields.reason !== "string" && typeof fields.detail !== "string") return value;
  const out = { ...value } as T & { reason?: unknown; detail?: unknown };
  if (typeof fields.reason === "string") out.reason = redact(fields.reason, secret);
  if (typeof fields.detail === "string") out.detail = redact(fields.detail, secret);
  return out;
}

/**
 * Call the provider with a fresh context. A throw, or no answer by the
 * deadline, is `uncertain`: the effect may have happened. Every reason the
 * outcome carries is redacted of the instance secret.
 */
export async function callProvider<T>(
  deps: Pick<LifecycleDeps, "clock" | "instance" | "callTimeoutMs" | "fetch" | "log">,
  deadline: number,
  fn: (ctx: ComputeContext) => Promise<T>
): Promise<T | ComputeUncertain> {
  const { instance } = deps;
  const controller = new AbortController();
  const ms = Math.max(0, Math.min(deadline - deps.clock.now(), deps.callTimeoutMs));
  const ctx: ComputeContext = {
    instanceId: instance.id,
    options: instance.options,
    secret: instance.secret,
    signal: controller.signal,
    deadline,
    fetch: deps.fetch,
    log: redactingLogger(deps.log, instance.secret),
  };
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ComputeUncertain>((resolve) => {
    abortTimer = setTimeout(() => {
      controller.abort(new Error("compute call deadline"));
      graceTimer = setTimeout(
        () => resolve({ kind: "uncertain", reason: "the provider did not answer before the call deadline" }),
        ABORT_GRACE_MS
      );
    }, ms);
  });
  try {
    const result = await Promise.race([
      Promise.resolve()
        .then(() => fn(ctx))
        .catch((error: unknown): ComputeUncertain => ({
          kind: "uncertain",
          reason: `the provider threw: ${error instanceof Error ? error.message : String(error)}`,
        })),
      timedOut,
    ]);
    return redactOutcome(result, instance.secret);
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(graceTimer);
  }
}

function outcomeLabel(value: unknown): string {
  return typeof value === "object" && value !== null && "kind" in value ? String((value as { kind: unknown }).kind) : "unknown";
}

function outcomeReason(value: unknown, secret: string | undefined): string | undefined {
  const reason = typeof value === "object" && value !== null && "reason" in value ? (value as { reason: unknown }).reason : undefined;
  return typeof reason === "string" ? redact(reason, secret).slice(0, 2000) : undefined;
}

/**
 * A usage report as the record keeps it: unknown coverage is `null`, never a
 * number, and a missing or invalid amount is unknown.
 */
export function normaliseUsage(usage: unknown): { usd: number | null; coverage: "complete" | "partial" | "unknown" } {
  const report = typeof usage === "object" && usage !== null ? (usage as { usd?: unknown; coverage?: unknown }) : {};
  const usd = typeof report.usd === "number" && Number.isFinite(report.usd) && report.usd >= 0 ? report.usd : null;
  const coverage = report.coverage === "complete" || report.coverage === "partial" ? report.coverage : "unknown";
  return usd === null || coverage === "unknown" ? { usd: null, coverage: "unknown" } : { usd, coverage };
}

export class JobDriver {
  constructor(
    private readonly job: ComputeJobRecord,
    private readonly deps: LifecycleDeps
  ) {}

  private get now(): number {
    return this.deps.clock.now();
  }

  private get caps() {
    return this.deps.instance.provider.capabilities;
  }

  private get provider() {
    return this.deps.instance.provider;
  }

  save(): void {
    this.job.updatedAt = this.now;
    this.deps.store.write(this.job);
  }

  private note(entry: Omit<ComputeReceipt, "at">): void {
    receipt(this.job, this.now, entry);
  }

  /** The deadline for a lease-bounded effect. */
  private leaseDeadline(): number {
    return Math.min(this.job.lease.deadline, this.now + this.deps.callTimeoutMs);
  }

  /** Cleanup (kill, release, find, usage) gets a fresh deadline: it must run after the lease too. */
  private cleanupDeadline(): number {
    return this.now + this.deps.callTimeoutMs;
  }

  /** The end of the release allowance after the lease. */
  private allowanceEnd(): number {
    return this.job.lease.deadline + this.job.lease.releaseAllowanceSeconds * 1000;
  }

  /**
   * Collection runs within the lease; for a command found already exited at
   * the first visit after the lease, within the release allowance.
   */
  private collectDeadline(): number {
    return this.expired() ? Math.min(this.allowanceEnd(), this.now + this.deps.callTimeoutMs) : this.leaseDeadline();
  }

  /** One provider effect with its intent and outcome receipts. */
  private async effect<T>(
    step: ComputeReceipt["step"],
    deadline: number,
    fn: (ctx: ComputeContext) => Promise<T>,
    beforeCall?: () => void
  ): Promise<T | ComputeUncertain> {
    beforeCall?.();
    this.note({ step, phase: "intent" });
    this.save();
    const result = await callProvider(this.deps, deadline, fn);
    this.note({ step, phase: "outcome", outcome: outcomeLabel(result), detail: outcomeReason(result, this.deps.instance.secret) });
    return result;
  }

  private cancelRequested(): boolean {
    if (!this.job.cancelRequested && existsSync(this.deps.store.cancelMarkerPath(this.job.id))) {
      this.job.cancelRequested = true;
      this.note({ step: "cancel", phase: "outcome", outcome: "requested" });
    }
    return this.job.cancelRequested;
  }

  private expired(): boolean {
    return this.now >= this.job.lease.deadline;
  }

  /** Decide the terminal state and move to release (or finish when nothing was allocated). */
  private conclude(state: ComputeTerminalState, reason: string): void {
    this.job.outcome = { state, reason };
    if (state === "expired") this.note({ step: "expire", phase: "outcome", outcome: "expired" });
    if (this.job.allocation.sandbox) this.job.state = "releasing";
    else this.finish(state, reason, this.job.allocation.attempts > 0 ? "unknown" : "none");
  }

  private finish(state: ComputeTerminalState, reason: string, cleanup?: "none" | "unknown"): void {
    if (cleanup) this.job.cleanup.state = cleanup;
    this.job.state = state;
    this.job.outcome = { state, reason };
    this.job.terminal = { state, at: this.now, reason };
    this.job.uncertain = null;
  }

  private snapshot(): string {
    const j = this.job;
    return JSON.stringify([j.state, j.cleanup, j.reservation.settled, j.allocation, j.command, j.stageAttempts, j.collectAttempts]);
  }

  /** Advance until the job needs time to pass, ends, or needs an operator. */
  async drive(mode: DriveMode): Promise<ComputeJobRecord> {
    for (let i = 0; i < MAX_STEPS; i++) {
      const before = this.snapshot();
      const proceed = await this.step(mode);
      this.save();
      if (!proceed) break;
      if (this.snapshot() === before) break;
    }
    return this.job;
  }

  /** One step; false when there is nothing more to do now. */
  private async step(mode: DriveMode): Promise<boolean> {
    const job = this.job;
    if (isTerminal(job.state)) return this.afterTerminal();
    const cancel = this.cancelRequested();
    const expired = this.expired();
    switch (job.state) {
      case "admitted":
        if (cancel) return this.finish("cancelled", "cancelled before allocation", "none"), true;
        if (expired) return this.finish("expired", "the lease ended before allocation", "none"), true;
        if (mode !== "start") return this.finish("cancelled", "interrupted_before_allocation", "none"), true;
        return this.allocate();
      case "allocating":
        // Only a process that died between intent and outcome leaves this behind.
        job.state = "uncertain";
        job.uncertain = { step: "allocate", reason: "the allocation outcome was never recorded" };
        return true;
      case "uncertain":
        return this.resolveUncertain(cancel, expired);
      case "staging":
        if (cancel) return this.conclude("cancelled", "cancelled"), true;
        if (expired) return this.conclude("expired", "the lease ended while staging"), true;
        return this.stage();
      case "running":
        return this.running(mode, cancel, expired);
      case "collecting":
        if (cancel) return this.markUncollected(), this.conclude("cancelled", "cancelled"), true;
        // The command exited on its own: past the release allowance nothing more is collected.
        if (expired && this.now >= this.allowanceEnd()) return this.markUncollected(), this.concludeFromExit(), true;
        return this.collect();
      case "releasing":
        return this.release();
    }
    return false;
  }

  private async allocate(): Promise<boolean> {
    const job = this.job;
    const caps = this.caps;
    const result = await this.effect("allocate", this.leaseDeadline(), (ctx) =>
      this.provider.allocate(
        {
          key: job.allocation.key,
          leaseSeconds: job.lease.seconds,
          remoteExpirySeconds: caps.remoteExpiry
            ? Math.max(1, Math.ceil((job.lease.deadline - this.now) / 1000) + job.lease.releaseAllowanceSeconds)
            : undefined,
          retain: job.request.retain,
        },
        ctx
      ), () => {
        job.state = "allocating";
        job.allocation.attempts += 1;
      });
    switch (result.kind) {
      case "ok":
        job.allocation.sandbox = result.sandbox;
        job.cleanup.state = "pending";
        job.uncertain = null;
        job.state = "staging";
        return true;
      case "refused":
      case "failed":
        // Nothing was allocated: the provider said so.
        if (job.allocation.attempts > 1) {
          // An earlier attempt was uncertain; this answer does not prove it left nothing.
          job.state = "uncertain";
          job.uncertain = { step: "allocate", reason: outcomeReason(result, this.deps.instance.secret) ?? result.kind };
          return false;
        }
        job.exit = { code: null, signal: null, reason: "provider_error" };
        this.finish("failed", `allocation ${result.kind}: ${outcomeReason(result, this.deps.instance.secret) ?? ""}`.trim(), "none");
        return true;
      default:
        job.state = "uncertain";
        job.uncertain = { step: "allocate", reason: outcomeReason(result, this.deps.instance.secret) ?? "uncertain" };
        return false;
    }
  }

  private async resolveUncertain(cancel: boolean, expired: boolean): Promise<boolean> {
    const job = this.job;
    const caps = this.caps;
    if (job.uncertain?.step === "exec" || job.allocation.sandbox) {
      // The command may be running. It is never started again.
      if (cancel || expired) {
        job.exit = { code: null, signal: null, reason: "unknown" };
        this.conclude(cancel ? "cancelled" : "expired", cancel ? "cancelled with the command's start unknown" : "the lease ended with the command's start unknown");
        return true;
      }
      return false;
    }
    // A lost allocation.
    if (caps.findByKey && this.provider.find) {
      const found = await this.effect("find", this.cleanupDeadline(), (ctx) => this.provider.find!(job.allocation.key, ctx));
      if (found.kind === "ok") {
        job.allocation.sandbox = found.sandbox;
        job.cleanup.state = "pending";
        job.uncertain = null;
        if (cancel) this.conclude("cancelled", "cancelled");
        else if (expired) this.conclude("expired", "the lease ended while the allocation was uncertain");
        else job.state = "staging";
        return true;
      }
      if (found.kind !== "not_found") return false;
      // An empty listing is not proof: never provision on it, except under an idempotency key.
    }
    if (!caps.idempotentAllocate) return false;
    if (!cancel && !expired) return job.allocation.attempts < MAX_ALLOCATE_ATTEMPTS ? this.allocate() : false;
    // Cancelled or expired with an allocation that may exist: one allocate
    // with the same key only recovers its reference (idempotency means it
    // cannot duplicate one), so it can be released rather than left running.
    if (job.allocation.attempts > MAX_ALLOCATE_ATTEMPTS) return false;
    return this.recoverForRelease(cancel);
  }

  private async recoverForRelease(cancel: boolean): Promise<boolean> {
    const job = this.job;
    const result = await this.effect(
      "allocate",
      this.cleanupDeadline(),
      (ctx) =>
        this.provider.allocate(
          {
            key: job.allocation.key,
            leaseSeconds: job.lease.seconds,
            remoteExpirySeconds: this.caps.remoteExpiry ? Math.max(1, job.lease.releaseAllowanceSeconds) : undefined,
            retain: job.request.retain,
          },
          ctx
        ),
      () => {
        job.allocation.attempts += 1;
      }
    );
    if (result.kind !== "ok") {
      job.uncertain = { step: "allocate", reason: outcomeReason(result, this.deps.instance.secret) ?? result.kind };
      return false;
    }
    job.allocation.sandbox = result.sandbox;
    job.cleanup.state = "pending";
    job.uncertain = null;
    if (cancel) this.conclude("cancelled", "cancelled while the allocation was uncertain");
    else this.conclude("expired", "the lease ended while the allocation was uncertain");
    return true;
  }

  private async stage(): Promise<boolean> {
    const job = this.job;
    const sandbox = job.allocation.sandbox!;
    if (job.source.files.length > 0) {
      // Every file is read and checked before the provider sees the bundle,
      // so bytes other than those admitted are never handed over.
      const bundle = loadSourceBundle(this.deps.root, job.source);
      if ("refused" in bundle) {
        this.note({ step: "stage", phase: "outcome", outcome: "refused", detail: bundle.refused });
        this.conclude("failed", `staging refused: ${bundle.refused}`);
        return true;
      }
      const result = await this.effect("stage", this.leaseDeadline(), (ctx) => this.provider.stage!(sandbox, bundle, ctx), () => {
        job.stageAttempts += 1;
      });
      if (result.kind !== "ok") {
        // Staging only overwrites files in our own sandbox, so it may be repeated.
        if (result.kind === "uncertain" && job.stageAttempts < MAX_STAGE_ATTEMPTS) return true;
        job.exit = { code: null, signal: null, reason: "provider_error" };
        this.conclude("failed", `staging ${result.kind}: ${outcomeReason(result, this.deps.instance.secret) ?? ""}`.trim());
        return true;
      }
    }
    job.state = "running";
    return true;
  }

  private async running(mode: DriveMode, cancel: boolean, expired: boolean): Promise<boolean> {
    const job = this.job;
    const handle = job.command.handle;
    if (!handle) {
      if (job.command.intentAt !== null) {
        job.state = "uncertain";
        job.uncertain = { step: "exec", reason: "the command's start was never recorded" };
        return true;
      }
      if (cancel) return this.conclude("cancelled", "cancelled before the command started"), true;
      if (expired) return this.conclude("expired", "the lease ended before the command started"), true;
      const sandbox = job.allocation.sandbox!;
      const result = await this.effect(
        "exec",
        this.leaseDeadline(),
        (ctx) => this.provider.exec(sandbox, { argv: job.request.argv, cwd: job.request.cwd ?? undefined, env: job.request.env }, ctx),
        () => {
          job.command.intentAt = this.now;
        }
      );
      switch (result.kind) {
        case "ok":
          job.command.handle = result.handle;
          job.command.startedAt = this.now;
          return mode !== "start";
        case "refused":
        case "failed":
          job.exit = { code: null, signal: null, reason: "provider_error" };
          this.conclude("failed", `exec ${result.kind}: ${outcomeReason(result, this.deps.instance.secret) ?? ""}`.trim());
          return true;
        default:
          job.state = "uncertain";
          job.uncertain = { step: "exec", reason: outcomeReason(result, this.deps.instance.secret) ?? "uncertain" };
          return false;
      }
    }
    if (cancel || expired) {
      // The command may have ended on its own since the last visit: look before killing it.
      const seen = await this.effect("poll", this.cleanupDeadline(), (ctx) => this.provider.poll(handle, ctx));
      if (seen.kind === "exited") {
        this.recordExit(seen);
        if (cancel) {
          this.markUncollected();
          this.conclude("cancelled", "cancelled after the command exited");
        } else job.state = "collecting";
        return true;
      }
      const killed = await this.effect("kill", this.cleanupDeadline(), (ctx) => this.provider.kill(handle, ctx));
      job.exit = { code: null, signal: null, reason: killed.kind === "ok" ? "killed" : "unknown" };
      this.markUncollected();
      if (cancel) this.conclude("cancelled", "cancelled");
      else this.conclude("expired", "the lease ended while the command ran");
      return true;
    }
    if (mode === "start") return false;
    const status = await this.effect("poll", this.leaseDeadline(), (ctx) => this.provider.poll(handle, ctx));
    if (status.kind !== "exited") return false;
    this.recordExit(status);
    job.state = "collecting";
    return true;
  }

  private recordExit(status: Extract<CommandStatus, { kind: "exited" }>): void {
    const job = this.job;
    job.exit = { code: status.code, signal: status.signal, reason: status.reason };
    let truncated = status.truncated === true;
    const keep = (text: string | undefined, stream: "stdout" | "stderr") => {
      if (text === undefined) return null;
      let data = new TextEncoder().encode(redact(text, this.deps.instance.secret));
      if (data.byteLength > this.deps.maxOutputBytes) {
        data = data.subarray(0, this.deps.maxOutputBytes);
        truncated = true;
      }
      this.deps.store.putOutput(job.id, stream, data);
      return { bytes: data.byteLength, sha256: sha256Hex(data) };
    };
    job.output = { stdout: keep(status.stdout, "stdout"), stderr: keep(status.stderr, "stderr"), truncated };
  }

  private markUncollected(): void {
    for (const a of this.job.artifacts) if (a.status === "pending") a.status = "not_collected";
  }

  private async collect(): Promise<boolean> {
    const job = this.job;
    const pending = job.artifacts.filter((a) => a.status === "pending");
    if (pending.length > 0) {
      const sandbox = job.allocation.sandbox!;
      const result = await this.effect(
        "collect",
        this.collectDeadline(),
        (ctx) => this.provider.collect!(sandbox, { paths: pending.map((a) => ({ path: a.path, maxBytes: a.maxBytes })) }, ctx),
        () => {
          job.collectAttempts += 1;
        }
      );
      if (result.kind !== "ok") {
        if (job.collectAttempts < MAX_COLLECT_ATTEMPTS) return true;
        this.markUncollected();
      } else {
        for (const artifact of pending) {
          const got = result.artifacts.find((a) => a.path === artifact.path);
          if (!got) artifact.status = "not_collected";
          else if (got.status === "collected") {
            if (got.data.byteLength > artifact.maxBytes) {
              artifact.status = "too_large";
              artifact.bytes = got.data.byteLength;
            } else {
              artifact.sha256 = this.deps.store.putArtifact(job.id, got.data);
              artifact.bytes = got.data.byteLength;
              artifact.status = "collected";
            }
          } else {
            artifact.status = got.status;
            artifact.bytes = got.status === "too_large" ? got.bytes ?? null : null;
          }
        }
      }
    }
    this.concludeFromExit();
    return true;
  }

  /** The terminal state a command that exited on its own earns. */
  private concludeFromExit(): void {
    const job = this.job;
    const exit = job.exit!;
    if (exit.reason === "exited" && exit.code === 0) {
      if (job.artifacts.every((a) => a.status === "collected")) this.conclude("succeeded", "exited 0");
      else this.conclude("failed", "artifacts_missing");
    } else {
      const why = exit.reason === "exited" ? `exited ${exit.code}` : exit.reason === "signal" ? `signal ${exit.signal ?? "unknown"}` : exit.reason;
      this.conclude("failed", why);
    }
  }

  private async release(): Promise<boolean> {
    const job = this.job;
    const sandbox = job.allocation.sandbox;
    const outcome = job.outcome!;
    if (!sandbox) {
      this.finish(outcome.state, outcome.reason, "unknown");
      return true;
    }
    const result = await this.effect("release", this.cleanupDeadline(), (ctx) => this.provider.release(sandbox, job.cleanup.mode, ctx), () => {
      job.cleanup.attempts += 1;
    });
    this.applyRelease(result);
    if (job.state === "releasing") {
      job.state = outcome.state;
      job.terminal = { state: outcome.state, at: this.now, reason: outcome.reason };
      job.uncertain = null;
    }
    return true;
  }

  private applyRelease(result: ReleaseOutcome): void {
    const cleanup = this.job.cleanup;
    if (result.kind === "released") {
      cleanup.state = "released";
      cleanup.lastError = null;
      cleanup.nextAttemptAt = null;
    } else if (result.kind === "retained") {
      cleanup.state = "retained";
      cleanup.retainedUntil = result.until;
      cleanup.lastError = null;
      cleanup.nextAttemptAt = null;
    } else {
      // A failed or uncertain release is never success; it is retried with backoff.
      cleanup.state = "release_failed";
      cleanup.lastError = `${result.kind}: ${outcomeReason(result, this.deps.instance.secret) ?? ""}`.trim();
      cleanup.nextAttemptAt = this.now + Math.min(RELEASE_BACKOFF_MS * 2 ** Math.max(0, cleanup.attempts - 1), RELEASE_BACKOFF_MAX_MS);
    }
  }

  /** Terminal: retry a failed release when due; settle cost and budget once cleanup has settled. */
  private async afterTerminal(): Promise<boolean> {
    const job = this.job;
    const cleanup = job.cleanup;
    if (cleanup.state === "release_failed" || cleanup.state === "pending") {
      if (cleanup.nextAttemptAt !== null && this.now < cleanup.nextAttemptAt) return false;
      const sandbox = job.allocation.sandbox;
      if (!sandbox) return false;
      const result = await this.effect("release", this.cleanupDeadline(), (ctx) => this.provider.release(sandbox, cleanup.mode, ctx), () => {
        cleanup.attempts += 1;
      });
      this.applyRelease(result);
      return cleanup.state !== "release_failed";
    }
    if (job.reservation.settled) return false;
    const sandbox = job.allocation.sandbox;
    if (sandbox && this.caps.usage === "actual" && this.provider.usage) {
      const reads = job.receipts.filter((r) => r.step === "usage" && r.phase === "intent").length;
      if (reads < MAX_USAGE_READS) {
        const usage = await this.effect("usage", this.cleanupDeadline(), (ctx) => this.provider.usage!(sandbox, ctx));
        const reading = normaliseUsage(usage);
        // An unknown reading never replaces a lower bound an earlier one gave.
        if (reading.coverage !== "unknown" || job.cost.actual.coverage !== "partial") job.cost.actual = { ...reading, source: "provider" };
        // A partial report is a lower bound while the sandbox can still
        // accrue, so it is read again. Once the sandbox is released nothing
        // more accrues and no later read can complete it.
        if (job.cost.actual.coverage === "partial" && job.cleanup.state !== "released" && reads + 1 < MAX_USAGE_READS) return false;
      }
    } else {
      job.cost.actual = { usd: null, coverage: "unknown", source: "none" };
    }
    if (this.deps.budget) {
      try {
        // The ledger takes one amount: a partial lower bound settled as the
        // actual cost would release the rest of the reservation, so anything
        // short of complete settles as unknown.
        await this.deps.budget.settle(job.id, job.cost.actual.coverage === "complete" ? job.cost.actual.usd : null);
        this.note({ step: "settle", phase: "outcome", outcome: "settled" });
      } catch (error) {
        this.note({ step: "settle", phase: "outcome", outcome: "failed", detail: (error as Error).message });
        return false;
      }
    }
    job.reservation.settled = true;
    return false;
  }
}
