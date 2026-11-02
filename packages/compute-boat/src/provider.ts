/**
 * The Boat mapping onto the ComputeProvider contract
 * (docs/decisions/external-compute.md). Boat transport and mapping only: the
 * host owns the job, its lease, admission, retries across calls and recovery.
 *
 * Vendor facts this file relies on, from Boat's OpenAPI description:
 * - `POST /sandboxes` answers `202` while the sandbox provisions. `ready`,
 *   `idle` and `running` accept commands; `setupStatus` and `hydrated` are
 *   separate facts and are not readiness.
 * - A stop archives the disk and ends every process. It is never a pause,
 *   and this adapter never resumes a sandbox.
 * - Stopped data is kept 14 days; `dataExpiredAt` is set once it is gone.
 * - Usage is reported per sandbox as seconds and list-price dollars.
 */

import { createHash } from "node:crypto";

import type {
  AllocateOutcome,
  ArtifactRequest,
  CollectedArtifact,
  CollectOutcome,
  CommandHandle,
  CommandSpec,
  CommandStatus,
  ComputeCapabilities,
  ComputeContext,
  ComputeHealth,
  ComputeProvider,
  CostObservation,
  ExecOutcome,
  FindOutcome,
  KillOutcome,
  ReleaseOutcome,
  SandboxRef,
  SourceBundle,
  StageOutcome,
} from "@schlessera/brain";

import { boatError, call, describe, realClock, type Attempt, type CallResult, type CallSpec, type ClientDeps } from "./client.js";
import { boatOptionsSchema, type BoatOptions } from "./options.js";
import { createRedactor, type Redactor } from "./redact.js";
import { commandLine, quote, safeRelative, WORK_DIR } from "./shell.js";
import { writeTar } from "./tar.js";

export const STAGE_MAX_BYTES = 256 * 1024 * 1024;
/** Where the staging archive is uploaded and extracted before it reaches the work directory. */
const STAGE_DIR = "/tmp/brain-kit";
/** `GET /sandboxes/{id}/artifacts` serves files up to 50 MiB. */
export const COLLECT_MAX_BYTES = 50 * 1024 * 1024;
/** Boat keeps a stopped sandbox's data 14 days. */
export const RETENTION_SECONDS = 14 * 24 * 60 * 60;
/** `ttlSeconds` accepts at most 30 days. */
export const MAX_TTL_SECONDS = 2_592_000;
/** Each log is read as its last this-many bytes. */
export const OUTPUT_TAIL_BYTES = 1024 * 1024;

export const BOAT_CAPABILITIES: ComputeCapabilities = {
  commands: true,
  detached: true,
  idempotentAllocate: true,
  findByKey: true,
  stage: { maxBytes: STAGE_MAX_BYTES },
  collect: { maxBytes: COLLECT_MAX_BYTES },
  retain: { maxSeconds: RETENTION_SECONDS },
  maxLeaseSeconds: MAX_TTL_SECONDS,
  remoteExpiry: true,
  usage: "actual",
};

export const LABEL_KEY = "brain-kit/key";
export const LABEL_INSTANCE = "brain-kit/instance";

const READY = new Set(["ready", "idle", "running"]);
const DEAD = new Set(["error", "cancelled", "archiving", "archived"]);
/** How many killed commands and pre-deletion usage readings one process remembers. */
const MEMORY_ENTRIES = 1024;
/** Margin kept before the call deadline so the last answer still arrives in time. */
const DEADLINE_MARGIN_MS = 1000;

type Sb = Record<string, unknown>;
const rec = (v: unknown): Sb | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Sb) : undefined);
const s = (v: unknown) => (typeof v === "string" ? v : undefined);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const seg = encodeURIComponent;

/** A key Boat accepts as a label value and an `Idempotency-Key`. */
export function keyToken(key: string): string {
  if (/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return key;
  return `sha256-${createHash("sha256").update(key).digest("hex")}`;
}

export function labelQuery(key: string, instanceId: string): string {
  const q = new URLSearchParams();
  q.append("label", `${LABEL_KEY}=${keyToken(key)}`);
  q.append("label", `${LABEL_INSTANCE}=${instanceId}`);
  q.set("limit", "10");
  return q.toString();
}

export interface BoatProviderDeps extends Partial<ClientDeps> {}

/** One adapter value. Its only state is what it learned in this process, so a fresh one is always correct. */
export function createBoatProvider(deps: BoatProviderDeps = {}): ComputeProvider {
  const clock: ClientDeps = { now: deps.now ?? realClock.now, sleep: deps.sleep ?? realClock.sleep };
  /** Commands this process stopped with a signal, so their exit reads `killed`. */
  const killed = new Set<string>();
  /**
   * The usage read just before a discard, for a report after the sandbox is
   * gone, when Boat's own report 404s. Process memory only, and only a lower
   * bound: another process reads unknown instead. Core settles both the same
   * way (a released sandbox's partial or unknown cost settles as unknown), so
   * no ledger outcome depends on which process asks.
   */
  const lastUsage = new Map<string, { usd: number; seconds: number | null }>();
  /** Both are process memory for a long-lived host: keep only the most recent entries. */
  const bound = (store: Set<string> | Map<string, unknown>) => {
    while (store.size > MEMORY_ENTRIES) store.delete(store.keys().next().value!);
  };

  const begin = (ctx: ComputeContext) => {
    const red = createRedactor(ctx.secret);
    const options = boatOptionsSchema.safeParse(ctx.options ?? {});
    return { red, options: options.success ? options.data : undefined, req: (spec: CallSpec) => call(ctx, spec, red, clock) };
  };
  const ok = (r: CallResult) => r.last.kind === "response" && r.last.status >= 200 && r.last.status < 300;
  const status = (r: CallResult) => (r.last.kind === "response" ? r.last.status : 0);
  const body = (r: CallResult) => (r.last.kind === "response" ? rec(r.last.body) : undefined) ?? {};
  const code = (r: CallResult) => (r.last.kind === "response" ? boatError(r.last.body).code : undefined);
  const why = (red: Redactor, what: string, r: CallResult) => red.text(`${what}: ${describe(r.last)}`);
  const remaining = (ctx: ComputeContext) => ctx.deadline - clock.now() - DEADLINE_MARGIN_MS;

  /** A failure for a call with an effect: `uncertain` whenever it may have happened. */
  function effectFailure(red: Redactor, what: string, r: CallResult): { kind: "failed" | "uncertain"; reason: string } {
    if (r.ambiguous) return { kind: "uncertain", reason: why(red, what, r) };
    return { kind: "failed", reason: why(red, what, r) };
  }

  /** A failure for a read: a lost answer is `uncertain`, a definite one `failed`. */
  function readFailure(red: Redactor, what: string, r: CallResult): { kind: "failed" | "uncertain"; reason: string } {
    if (r.last.kind === "transport" && r.last.sent) return { kind: "uncertain", reason: why(red, what, r) };
    if (r.last.kind === "response" && r.last.status >= 500) return { kind: "uncertain", reason: why(red, what, r) };
    return { kind: "failed", reason: why(red, what, r) };
  }

  /** Wait until Boat reports the sandbox able to take commands. Setup and hydration are not waited for. */
  async function ensureReady(ctx: ComputeContext, red: Redactor, req: (spec: CallSpec) => Promise<CallResult>, id: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    for (let i = 0; ; i++) {
      const r = await req({ method: "GET", path: `/sandboxes/${seg(id)}`, label: "GET /sandboxes/{id}", retry: "safe" });
      if (!ok(r)) return { ok: false, reason: why(red, "reading the sandbox", r) };
      const sandbox = rec(body(r).sandbox) ?? {};
      const state = s(sandbox.state) ?? "unknown";
      if (READY.has(state)) return { ok: true };
      if (DEAD.has(state)) return { ok: false, reason: red.text(`the sandbox is ${state}${s(sandbox.error) ? `: ${s(sandbox.error)}` : ""}`) };
      const wait = Math.min(250 * 2 ** i, 2000);
      if (ctx.signal.aborted || remaining(ctx) <= wait) return { ok: false, reason: `the sandbox was still ${state} at the call deadline` };
      await clock.sleep(wait, ctx.signal);
    }
  }

  async function lookup(key: string, ctx: ComputeContext, red: Redactor, req: (spec: CallSpec) => Promise<CallResult>): Promise<{ outcome: FindOutcome; r: CallResult }> {
    const r = await req({ method: "GET", path: `/sandboxes?${labelQuery(key, ctx.instanceId)}`, label: "GET /sandboxes?label", retry: "safe" });
    if (!ok(r)) return { outcome: readFailure(red, "listing sandboxes by label", r), r };
    const list = (Array.isArray(body(r).sandboxes) ? (body(r).sandboxes as unknown[]) : []).map(rec).filter((x): x is Sb => !!x && typeof x.id === "string");
    // A cancelled create never got a machine and is gone; nothing to adopt or release.
    const live = list.filter((x) => s(x.state) !== "cancelled");
    if (live.length === 0) return { outcome: { kind: "not_found" }, r };
    if (live.length > 1) return { outcome: { kind: "uncertain", reason: `${live.length} sandboxes carry this allocation key` }, r };
    return { outcome: { kind: "ok", sandbox: { id: live[0]!.id as string, data: { state: s(live[0]!.state) ?? null } } }, r };
  }

  async function readUsage(ctx: ComputeContext, req: (spec: CallSpec) => Promise<CallResult>, id: string): Promise<CallResult> {
    return req({ method: "GET", path: `/sandboxes/${seg(id)}/usage`, label: "GET /sandboxes/{id}/usage", retry: "safe" });
  }

  const provider: ComputeProvider = {
    id: "boat",
    capabilities: BOAT_CAPABILITIES,
    configSchema: boatOptionsSchema,

    async health(ctx): Promise<ComputeHealth> {
      if (!ctx.secret) return { kind: "unavailable", reason: "no Boat API key is configured" };
      const { red, req } = begin(ctx);
      const limits = await req({ method: "GET", path: "/limits", label: "GET /limits", retry: "safe" });
      if (ok(limits)) {
        const b = body(limits);
        if (b.canStart === false) return { kind: "unavailable", reason: red.text(`Boat reports no machine start is possible now (billing ${s(b.billingStatus) ?? "unknown"})`) };
        return { kind: "ok", detail: "limits read" };
      }
      // A run-only key may lack `account.read`; a list proves the key works without it.
      if (status(limits) === 403 && code(limits) === "api_key_action_forbidden") {
        const list = await req({ method: "GET", path: "/sandboxes?limit=1", label: "GET /sandboxes?limit=1", retry: "safe" });
        if (ok(list)) return { kind: "ok", detail: "key accepted; limits not readable with this key" };
        return { kind: "unavailable", reason: why(red, "listing sandboxes", list) };
      }
      return { kind: "unavailable", reason: why(red, "reading limits", limits) };
    },

    async allocate(request, ctx): Promise<AllocateOutcome> {
      const { red, options, req } = begin(ctx);
      if (ctx.signal.aborted) return { kind: "failed", reason: "aborted before sending" };
      if (!options) return { kind: "refused", code: "provider_unavailable", reason: "the instance options are not valid Boat options" };
      // Look first: a sandbox from an earlier attempt is reused even after Boat's 24 h key window.
      const { outcome: found, r: listed } = await lookup(request.key, ctx, red, req);
      if (found.kind === "ok") return found;
      if (found.kind !== "not_found") {
        // Nothing was created by this call: a key Boat refuses is a refusal, anything else a failure.
        if ([401, 402, 403].includes(status(listed))) return { kind: "refused", code: "provider_unavailable", reason: why(red, "listing sandboxes by label", listed) };
        if (found.kind === "uncertain" && listed.last.kind === "response" && ok(listed)) return found;
        return { kind: "failed", reason: found.reason };
      }
      const token = keyToken(request.key);
      const r = await req({
        method: "POST",
        path: "/sandboxes",
        label: "POST /sandboxes",
        headers: { "Idempotency-Key": token },
        json: createBody(request.remoteExpirySeconds ?? request.leaseSeconds, request.retain, token, ctx.instanceId, options),
        retry: "safe",
      });
      if (ok(r)) {
        const sandbox = rec(body(r).sandbox);
        const id = s(sandbox?.id);
        if (!id) return { kind: "uncertain", reason: "Boat accepted the create without a sandbox id" };
        return { kind: "ok", sandbox: { id, data: { state: s(sandbox?.state) ?? null } } };
      }
      // The key already made a sandbox under another body: look for it again
      // before calling the outcome uncertain, since the first look may have
      // preceded the listing.
      if (status(r) === 409 && code(r) === "idempotency_key_reused") {
        const again = (await lookup(request.key, ctx, red, req)).outcome;
        if (again.kind === "ok") return again;
      }
      return allocateFailure(red, r);
    },

    async find(key, ctx): Promise<FindOutcome> {
      const { red, req } = begin(ctx);
      return (await lookup(key, ctx, red, req)).outcome;
    },

    async stage(sandbox: SandboxRef, source: SourceBundle, ctx): Promise<StageOutcome> {
      const { red, req } = begin(ctx);
      if (ctx.signal.aborted) return { kind: "failed", reason: "aborted before sending" };
      if (source.files.length === 0) return { kind: "ok" };
      const hash = /^[A-Za-z0-9]{8,128}$/.test(source.hash) ? source.hash : createHash("sha256").update(source.hash).digest("hex");
      const manifestName = `.brain-kit-stage-${hash.slice(0, 16)}.sha256`;
      const entries = [];
      const sums: string[] = [];
      for (const file of source.files) {
        const path = safeRelative(file.path);
        if (!path || path === manifestName || /[\n\r]/.test(path) || !/^[a-f0-9]{64}$/.test(file.sha256)) {
          return { kind: "failed", reason: `the source path ${JSON.stringify(file.path)} cannot be staged` };
        }
        entries.push({ path, data: await file.read() });
        sums.push(`${file.sha256}  ${path}`);
      }
      entries.push({ path: manifestName, data: new TextEncoder().encode(`${sums.join("\n")}\n`) });
      const tar = writeTar(entries);
      if (!tar.ok) return { kind: "failed", reason: `the source path ${JSON.stringify(tar.path)} is too long to stage` };
      if (tar.bytes.byteLength > STAGE_MAX_BYTES) {
        return { kind: "refused", code: "capability_unsupported", reason: `Boat staging takes at most ${STAGE_MAX_BYTES} bytes` };
      }
      const ready = await ensureReady(ctx, red, req, sandbox.id);
      if (!ready.ok) return { kind: "failed", reason: ready.reason };
      const tarPath = `${STAGE_DIR}/${hash.slice(0, 64)}.tar`;
      const url = await req({
        method: "POST",
        path: `/sandboxes/${seg(sandbox.id)}/files/upload-url`,
        label: "POST /sandboxes/{id}/files/upload-url",
        json: { path: tarPath, ttlSeconds: 300 },
        retry: "safe",
      });
      const signed = s(body(url).url);
      if (!ok(url) || !signed) return readFailure(red, "requesting an upload URL", url);
      red.add(signed);
      const put = await req({ method: "PUT", signedUrl: signed, label: "PUT <signed upload URL>", bytes: tar.bytes, retry: "safe" });
      if (!ok(put)) return readFailure(red, "uploading the source", put);
      // Boat never retries a command and neither does this adapter on an
      // unknown outcome: a lost answer or a 502 may mean it still runs, so
      // it is `uncertain`. The command is safe for the host to run again
      // alongside one still in flight: it keeps the archive, extracts and
      // checks into a fresh directory, and only then copies verified files.
      const seconds = Math.max(1, Math.min(600, Math.floor(remaining(ctx) / 1000)));
      const extract = await req({
        method: "POST",
        path: `/sandboxes/${seg(sandbox.id)}/commands`,
        label: "POST /sandboxes/{id}/commands (stage)",
        json: { command: stageCommand(tarPath, manifestName), timeoutSeconds: seconds },
        retry: "exec",
      });
      if (!ok(extract)) return effectFailure(red, "extracting the source", extract);
      const result = body(extract);
      if (n(result.exitCode) !== 0) return { kind: "failed", reason: red.text(`extracting the source exited ${n(result.exitCode) ?? "without a code"}${result.timedOut === true ? " (timed out)" : ""}`) };
      return { kind: "ok" };
    },

    async exec(sandbox: SandboxRef, command: CommandSpec, ctx): Promise<ExecOutcome> {
      const { red, req } = begin(ctx);
      if (ctx.signal.aborted) return { kind: "failed", reason: "aborted before sending" };
      const line = commandLine(command.argv, command.env, command.cwd);
      if (line === undefined) return { kind: "failed", reason: "the command, its cwd or an environment name cannot be passed to Boat safely" };
      const ready = await ensureReady(ctx, red, req, sandbox.id);
      if (!ready.ok) return { kind: "failed", reason: ready.reason };
      const r = await req({
        method: "POST",
        path: `/sandboxes/${seg(sandbox.id)}/commands`,
        label: "POST /sandboxes/{id}/commands",
        json: { command: line, detached: true },
        retry: "exec",
      });
      if (ok(r)) {
        const b = body(r);
        const pid = n(b.processId);
        if (pid === undefined) return { kind: "uncertain", reason: "Boat started the command without a process id" };
        return { kind: "ok", handle: { sandbox: { id: sandbox.id }, id: String(pid), data: { commandId: s(b.commandId) ?? null } } };
      }
      // A 502 other than "restoring", a 5xx or a lost answer may mean the command runs.
      if (r.ambiguous) return { kind: "uncertain", reason: why(red, "starting the command", r) };
      return { kind: "failed", reason: why(red, "starting the command", r) };
    },

    async poll(handle: CommandHandle, ctx): Promise<CommandStatus> {
      const { red, req } = begin(ctx);
      const q = new URLSearchParams({ tailBytes: String(OUTPUT_TAIL_BYTES) });
      const r = await req({
        method: "GET",
        path: `/sandboxes/${seg(handle.sandbox.id)}/commands/${seg(handle.id)}?${q}`,
        label: "GET /sandboxes/{id}/commands/{processId}",
        retry: "none",
      });
      const st = status(r);
      // The sandbox stopped or is gone: its processes ended with it. A stop is never a pause.
      if (st === 404 || (st === 409 && (code(r) === "machine_not_running" || code(r) === "sandbox_not_ready"))) {
        killed.delete(`${handle.sandbox.id}/${handle.id}`);
        return { kind: "exited", code: null, signal: null, reason: "provider_error", stderr: why(red, "the command's sandbox no longer runs it", r) };
      }
      if (!ok(r)) return readFailure(red, "reading the command", r);
      const b = body(r);
      const state = s(b.status);
      if (state === "running" || (state === undefined && b.running === true)) return { kind: "running" };
      const out = {
        stdout: s(b.stdout) ?? "",
        stderr: s(b.stderr) ?? "",
        truncated: b.stdoutTruncated === true || b.stderrTruncated === true,
      };
      const exitCode = n(b.exitCode) ?? null;
      const signal = s(b.signal) ?? null;
      const tag = `${handle.sandbox.id}/${handle.id}`;
      const wasKilled = killed.delete(tag);
      if (state === "lost") return { kind: "exited", code: exitCode, signal, reason: "provider_error", ...out };
      if (b.oomKilled === true) return { kind: "exited", code: exitCode, signal, reason: "oom", ...out };
      if (wasKilled) return { kind: "exited", code: exitCode, signal, reason: "killed", ...out };
      if (signal !== null && exitCode === null) return { kind: "exited", code: null, signal, reason: "signal", ...out };
      if (exitCode === null) return { kind: "exited", code: null, signal, reason: "provider_error", ...out };
      return { kind: "exited", code: exitCode, signal, reason: signal !== null ? "signal" : "exited", ...out };
    },

    async kill(handle: CommandHandle, ctx): Promise<KillOutcome> {
      const { red, req } = begin(ctx);
      if (ctx.signal.aborted) return { kind: "failed", reason: "aborted before sending" };
      const r = await req({
        method: "DELETE",
        path: `/sandboxes/${seg(handle.sandbox.id)}/commands/${seg(handle.id)}`,
        label: "DELETE /sandboxes/{id}/commands/{processId}",
        retry: "safe",
      });
      // Not running, or its sandbox stopped: nothing is left to kill.
      if (status(r) === 404 || status(r) === 409) return { kind: "ok" };
      if (!ok(r)) return effectFailure(red, "stopping the command", r);
      if (body(r).signaled !== false) {
        killed.add(`${handle.sandbox.id}/${handle.id}`);
        bound(killed);
      }
      return { kind: "ok" };
    },

    async collect(sandbox: SandboxRef, request: ArtifactRequest, ctx): Promise<CollectOutcome> {
      const { red, req } = begin(ctx);
      if (ctx.signal.aborted) return { kind: "failed", reason: "aborted before sending" };
      const artifacts: CollectedArtifact[] = [];
      for (const wanted of request.paths) {
        const rel = safeRelative(wanted.path);
        if (!rel) return { kind: "failed", reason: `the artifact path ${JSON.stringify(wanted.path)} is outside the work directory` };
        const path = `${WORK_DIR}/${rel}`;
        const cap = Math.min(wanted.maxBytes, COLLECT_MAX_BYTES);
        const info = await req({ method: "GET", path: `/sandboxes/${seg(sandbox.id)}/files/info?${new URLSearchParams({ path })}`, label: "GET /sandboxes/{id}/files/info", retry: "safe" });
        if (missing(info)) {
          artifacts.push({ path: wanted.path, status: "missing" });
          continue;
        }
        if (!ok(info)) return readFailure(red, `reading ${wanted.path}`, info);
        const entry = body(info);
        if (entry.isDir === true) {
          artifacts.push({ path: wanted.path, status: "missing" });
          continue;
        }
        const size = n(entry.size);
        if (size !== undefined && size > cap) {
          artifacts.push({ path: wanted.path, status: "too_large", bytes: size });
          continue;
        }
        const got = await req({
          method: "GET",
          path: `/sandboxes/${seg(sandbox.id)}/artifacts?${new URLSearchParams({ path })}`,
          label: "GET /sandboxes/{id}/artifacts",
          retry: "safe",
          readBytes: cap,
        });
        if (missing(got)) {
          artifacts.push({ path: wanted.path, status: "missing" });
          continue;
        }
        if (got.last.kind === "response" && got.last.overflow) {
          artifacts.push({ path: wanted.path, status: "too_large" });
          continue;
        }
        if (!ok(got) || got.last.kind !== "response" || !got.last.bytes) return readFailure(red, `downloading ${wanted.path}`, got);
        artifacts.push({ path: wanted.path, status: "collected", data: got.last.bytes });
      }
      return { kind: "ok", artifacts };
    },

    async release(sandbox: SandboxRef, mode, ctx): Promise<ReleaseOutcome> {
      const { red, req } = begin(ctx);
      if (ctx.signal.aborted) return { kind: "failed", reason: "aborted before sending" };
      return mode === "retain" ? retain(sandbox.id, ctx, red, req) : discard(sandbox.id, ctx, red, req);
    },

    async usage(sandbox: SandboxRef, ctx): Promise<CostObservation> {
      const { req } = begin(ctx);
      const r = await readUsage(ctx, req, sandbox.id);
      if (ok(r)) {
        const b = body(r);
        const usd = n(b.dollars);
        if (usd === undefined || usd < 0) return { usd: null, seconds: n(b.seconds) ?? null, coverage: "unknown" };
        return { usd, seconds: n(b.seconds) ?? null, coverage: b.running === false ? "complete" : "partial" };
      }
      const before = lastUsage.get(sandbox.id);
      // Deleted: the reading taken just before deletion misses only the seconds after it.
      if (status(r) === 404 && before) return { usd: before.usd, seconds: before.seconds, coverage: "partial" };
      return { usd: null, seconds: null, coverage: "unknown" };
    },
  };

  async function discard(id: string, ctx: ComputeContext, red: Redactor, req: (spec: CallSpec) => Promise<CallResult>): Promise<ReleaseOutcome> {
    if (!lastUsage.has(id)) {
      const u = await readUsage(ctx, req, id);
      const usd = n(body(u).dollars);
      if (ok(u) && usd !== undefined && usd >= 0) {
        lastUsage.set(id, { usd, seconds: n(body(u).seconds) ?? null });
        bound(lastUsage);
      }
    }
    const r = await req({
      method: "DELETE",
      path: `/sandboxes/${seg(id)}`,
      label: "DELETE /sandboxes/{id}",
      headers: { "X-Ascii-Confirm-Delete": id },
      retry: "safe",
    });
    // Already deleted: releasing twice is not an error.
    if (status(r) === 404 && !r.ambiguous) return { kind: "released" };
    if (!ok(r)) return effectFailure(red, "deleting the sandbox", r);
    let op = rec(body(r).operation) ?? {};
    for (let i = 0; ; i++) {
      const state = s(op.status);
      if (state === "completed") return { kind: "released" };
      if (state === "blocked") return { kind: "failed", reason: "Boat reports the deletion blocked" };
      const opId = s(op.id);
      if (!opId) return { kind: "uncertain", reason: "Boat accepted the deletion without an operation id" };
      const wait = Math.min(250 * 2 ** i, 2000);
      if (ctx.signal.aborted || remaining(ctx) <= wait) return { kind: "uncertain", reason: `the deletion was still ${state ?? "pending"} at the call deadline` };
      await clock.sleep(wait, ctx.signal);
      const poll = await req({ method: "GET", path: `/deletion-operations/${seg(opId)}`, label: "GET /deletion-operations/{id}", retry: "safe" });
      if (!ok(poll)) return { kind: "uncertain", reason: why(red, "reading the deletion", poll) };
      op = rec(body(poll).operation) ?? {};
    }
  }

  async function retain(id: string, ctx: ComputeContext, red: Redactor, req: (spec: CallSpec) => Promise<CallResult>): Promise<ReleaseOutcome> {
    // Never `force`: a stop whose disk save fails is refused rather than discarding work.
    const r = await req({ method: "POST", path: `/sandboxes/${seg(id)}/stop`, label: "POST /sandboxes/{id}/stop", json: {}, retry: "safe" });
    if (status(r) === 404 && !r.ambiguous) return { kind: "released" };
    let stopId: string | undefined;
    if (ok(r)) {
      const b = body(r);
      stopId = s(rec(b.stop)?.id) ?? s(rec(rec(b.sandbox)?.stop)?.id);
    } else if (status(r) !== 409) {
      return effectFailure(red, "stopping the sandbox", r);
    }
    for (let i = 0; ; i++) {
      const read = stopId
        ? await req({ method: "GET", path: `/sandboxes/${seg(id)}/stops/${seg(stopId)}`, label: "GET /sandboxes/{id}/stops/{stopId}", retry: "safe" })
        : await req({ method: "GET", path: `/sandboxes/${seg(id)}`, label: "GET /sandboxes/{id}", retry: "safe" });
      if (status(read) === 404 && !stopId) return { kind: "released" };
      if (!ok(read)) return { kind: "uncertain", reason: why(red, "reading the stop", read) };
      const sandboxNow = rec(body(read).sandbox);
      const stop = stopId ? rec(body(read).stop) : rec(sandboxNow?.stop);
      const state = s(stop?.status) ?? (s(sandboxNow?.state) === "archived" ? "completed" : undefined);
      if (state === "completed") return retainedUntil(id, ctx, red, req, s(stop?.endedAt));
      if (state === "superseded") return { kind: "failed", reason: "the stop was superseded by a resume" };
      if (!stopId && !state) return { kind: "failed", reason: why(red, "stopping the sandbox", r) };
      const wait = Math.min(250 * 2 ** i, 2000);
      if (ctx.signal.aborted || remaining(ctx) <= wait) {
        // A failing stop is not over: Boat retries it until the sandbox archives.
        if (state === "failing") {
          return { kind: "uncertain", reason: red.text(`Boat could not save the disk yet${s(stop?.error) ? `: ${s(stop?.error)}` : ""}; it retries the stop and the sandbox keeps running`) };
        }
        return { kind: "uncertain", reason: `the stop was still ${state ?? "pending"} at the call deadline` };
      }
      await clock.sleep(wait, ctx.signal);
    }
  }

  async function retainedUntil(id: string, ctx: ComputeContext, red: Redactor, req: (spec: CallSpec) => Promise<CallResult>, endedAt: string | undefined): Promise<ReleaseOutcome> {
    const r = await req({ method: "GET", path: `/sandboxes/${seg(id)}`, label: "GET /sandboxes/{id}", retry: "safe" });
    const sandbox = rec(body(r).sandbox) ?? {};
    // Set once Boat has deleted the stopped data.
    if (s(sandbox.dataExpiredAt)) return { kind: "released" };
    const stopped = Date.parse(s(sandbox.stoppedAt) ?? endedAt ?? "");
    const from = Number.isFinite(stopped) ? stopped : clock.now();
    if (!ok(r) && !Number.isFinite(Date.parse(endedAt ?? ""))) return { kind: "uncertain", reason: why(red, "reading the stopped sandbox", r) };
    return { kind: "retained", until: from + RETENTION_SECONDS * 1000 };
  }

  return provider;
}

function missing(r: CallResult): boolean {
  if (r.last.kind !== "response") return false;
  if (r.last.status === 404) return true;
  const c = boatError(r.last.body).code ?? "";
  return r.last.status === 400 && /not_found|no_such_file|enoent/i.test(c);
}

/** The create body. No timestamps, so a retry under the same key sends the same bytes. */
export function createBody(ttl: number, retain: boolean, token: string, instanceId: string, options: BoatOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {
    labels: { [LABEL_KEY]: token, [LABEL_INSTANCE]: instanceId },
    ttlSeconds: Math.max(1, Math.min(Math.ceil(ttl), MAX_TTL_SECONDS)),
    // Without a named environment, the sandbox gets none of the account's secrets, credentials or in-sandbox Boat key.
    noEnv: options.environment === undefined,
    snapshots: retain,
  };
  if (options.environment !== undefined) out.environment = options.environment;
  if (options.machine !== undefined) out.type = options.machine;
  if (options.from !== undefined) out.from = options.from;
  if (options.org !== undefined) out.org = options.org;
  return out;
}

/**
 * Extract into a fresh directory, check every file there, then copy into the
 * work directory. The archive is left in place, so a second run while an
 * earlier one is still in flight reads the same bytes, and copying the same
 * verified files twice leaves the same tree.
 */
function stageCommand(tarPath: string, manifest: string): string {
  return [
    "set -e",
    `mkdir -p ${WORK_DIR} ${STAGE_DIR}`,
    `d=$(mktemp -d ${STAGE_DIR}/x.XXXXXXXX)`,
    `trap 'rm -rf "$d"' EXIT`,
    `tar -xf ${quote(tarPath)} -C "$d"`,
    `(cd "$d" && sha256sum -c --quiet ${quote(manifest)})`,
    `rm -f "$d"/${quote(manifest)}`,
    `cp -a "$d"/. ${WORK_DIR}/`,
  ].join("; ");
}

function allocateFailure(red: Redactor, r: CallResult): AllocateOutcome {
  const reason = red.text(`creating the sandbox: ${describe(r.last)}`);
  // A refusal after an attempt that may have created a sandbox proves nothing.
  if (r.ambiguous) return { kind: "uncertain", reason };
  const last: Attempt = r.last;
  if (last.kind === "transport") return { kind: "failed", reason };
  const st = last.status;
  const c = boatError(last.body);
  if (st === 409 && (c.code === "idempotency_in_progress" || c.code === "idempotency_key_reused")) return { kind: "uncertain", reason };
  if (st === 401 || st === 402 || st === 403) return { kind: "refused", code: "provider_unavailable", reason };
  if ((st === 404 && c.code === "snapshot_not_found") || (st === 409 && c.code === "snapshot_data_expired") || (st === 400 && c.code === "unknown_environment")) {
    return { kind: "refused", code: "provider_unavailable", reason };
  }
  if (st === 429 && (c.code === "limit_reached" || c.code === "member_limit_reached")) return { kind: "refused", code: "concurrency_exhausted", reason };
  if (st === 429 || st === 503) return { kind: "refused", code: "provider_unavailable", reason };
  if (st >= 500) return { kind: "uncertain", reason };
  return { kind: "failed", reason };
}

