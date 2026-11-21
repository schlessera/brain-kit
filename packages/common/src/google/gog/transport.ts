/**
 * The gog transport (plan §8, "The selected shape"): `execute(operation,
 * input)` in, a validated record or a coded error out. The governance layer
 * above it never sees argv or gog's JSON, so one operation can move to direct
 * REST without changing anything there.
 *
 * Per call: strict input, the pin (verified once, its file identity
 * re-checked before every call), the account's concurrency limit (reads 4,
 * writes 1), one process under a timeout (reads 30 s, writes 60 s), one
 * retry of a read that gog called retryable, never a retry of a write, and
 * the codec.
 *
 * A `gmail.search` is the search and then one thread read per hit: gog's
 * search output carries only the first message's labels, by name, so the
 * union of each thread's label ids that `hidden_labels` filtering needs comes
 * from reading the thread (plan §5, last bullet). The pre-read is capped by
 * the page size, at most 25.
 *
 * Write operations have argv and the full write discipline here; their
 * codecs come with the write tasks, and until then `execute` refuses them
 * without running anything.
 */
import type { GoogleError, GoogleOperation } from "../catalog.js";
import type { GmailLabelRecord, GmailMessageRecord, GmailSearchPageRecord, GmailThreadRecord } from "../records.js";
import {
  GOG_OPERATION_INPUTS, GOG_THREAD_INPUT, GogArgvError, gogArgv, gogInvocation, isGogAccountAlias, type GogInvocation, type GogOperationInput,
} from "./argv.js";
import { GOG_READ_CODECS, GogShapeError, searchHitFromThread, type GogDraftRead } from "./codecs.js";
import { GOG_COMMANDS } from "./commands.js";
import { gogEnvironment, type GogEnvironment, type GogEnvironmentConfig } from "./environment.js";
import { gogError, gogProcessError, type GogEffect } from "./errors.js";
import { gogBinaryIdentity, sameGogIdentity, verifyGogBinary, verifyGogBinaryWith, type GogPinParameters, type GogPinResult } from "./pin.js";
import { GOG_STDOUT_CAP, runGogProcess } from "./runner.js";

/**
 * The binary. `pinned` is the only production shape: the pin check runs at
 * first use. `fake` is a test double the test wrote itself; it skips the pin
 * and is reachable only through this parameter, never configuration.
 */
export type GogBinary = { kind: "pinned"; path: string } | { kind: "fake"; path: string };

/** What the host learns about each process, for its own log. No value, argument or stderr text is in it. */
export interface GogLogEvent {
  operation: GoogleOperation;
  command: string;
  effect: GogEffect;
  attempt: number;
  outcome: "ok" | "error";
  code: GoogleError["code"] | null;
  reason: string | null;
  exit_code: number | null;
  duration_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;
}

export interface GogTransportOptions {
  binary: GogBinary;
  /** The gog account alias (plan §5): never an address, never `auto`. */
  account: string;
  environment: GogEnvironmentConfig;
  /** Product timings; tests shorten them. Defaults: reads 30 s, writes 60 s. */
  timeouts?: { readMs?: number; writeMs?: number };
  /** The pause before the one retry of a retryable read. Default 500 ms. */
  retryDelayMs?: number;
  log?: (event: GogLogEvent) => void;
}

export const GOG_READ_OPERATIONS = ["gmail.search", "gmail.thread.get", "gmail.message.get", "gmail.draft.get", "gmail.labels.list"] as const;
export type GogReadOperation = typeof GOG_READ_OPERATIONS[number];

/** What each read returns. */
export interface GogReadResults {
  "gmail.search": GmailSearchPageRecord;
  "gmail.thread.get": GmailThreadRecord;
  "gmail.message.get": GmailMessageRecord;
  "gmail.draft.get": GogDraftRead;
  "gmail.labels.list": GmailLabelRecord[];
}

export type GogResult<T> = { ok: true; value: T } | { ok: false; error: GoogleError };

/** Whether the transport can run, and on what. A fake reports `fake: true` and no pin. */
export type GogAvailability =
  | { ok: true; fake: false; pin: Extract<GogPinResult, { ok: true }> }
  | { ok: true; fake: true }
  | { ok: false; error: GoogleError };

export interface GogTransport {
  readonly account: string;
  /** Runs the pin check now if it has not run (first use runs it anyway). */
  availability(): Promise<GogAvailability>;
  execute<O extends GogReadOperation>(operation: O, input: GogOperationInput<O>): Promise<GogResult<GogReadResults[O]>>;
}

// ------------------------------------------------------------ concurrency

/** A FIFO counting semaphore. */
class Limit {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(readonly size: number) {}
  get state() {
    return { active: this.active, queued: this.queue.length };
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>(resolve => this.queue.push(resolve));
    else this.active++;
    try {
      return await work();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export const GOG_CONCURRENCY = Object.freeze({ read: 4, write: 1 });
const limits = new Map<string, { read: Limit; write: Limit }>();

/** Per account, shared by every transport in the process for that alias. */
function accountLimits(account: string) {
  let found = limits.get(account);
  if (!found) {
    found = { read: new Limit(GOG_CONCURRENCY.read), write: new Limit(GOG_CONCURRENCY.write) };
    limits.set(account, found);
  }
  return found;
}

/** Internal, for tests: how many calls hold and wait for each of an account's limits. */
export function gogConcurrencyState(account: string) {
  const found = accountLimits(account);
  return { read: found.read.state, write: found.write.state };
}

// --------------------------------------------------------------- transport

/** What the internal runner returns: the answer bytes, or the error. */
export type GogInvokeResult = { ok: true; stdout: Uint8Array } | { ok: false; error: GoogleError };

export interface GogTransportInternals extends GogTransport {
  /** Runs one invocation with the full discipline. Internal: the write codecs and the tests build on it. */
  invoke(operation: GoogleOperation, call: GogInvocation): Promise<GogInvokeResult>;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Builds the transport. Never throws: a bad option makes every call answer `unavailable` with its reason. */
export function createGogTransport(options: GogTransportOptions): GogTransport {
  return createGogTransportInternals(options);
}

/** Internal: the transport with its runner exposed, and the pin's parameters replaceable for tests. */
export function createGogTransportInternals(options: GogTransportOptions & { pinParameters?: GogPinParameters }): GogTransportInternals {
  const { binary, account } = options;
  const readMs = options.timeouts?.readMs ?? 30_000;
  const writeMs = options.timeouts?.writeMs ?? 60_000;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const environment = gogEnvironment(options.environment);
  const setup: GoogleError | null = !isGogAccountAlias(account) ? gogError("unavailable", "account")
    : !environment.ok ? gogError("unavailable", `environment_${environment.reason}`)
      : binary?.kind !== "pinned" && binary?.kind !== "fake" ? gogError("unavailable", "binary")
        : null;
  const env: GogEnvironment | null = environment.ok ? environment.environment : null;

  // The pin: verified once; a failure is kept until the file changes.
  let pin: Promise<GogPinResult> | null = null;
  let failedIdentity: ReturnType<typeof gogBinaryIdentity> = null;

  async function pinned(): Promise<{ ok: true; path: string } | { ok: false; error: GoogleError }> {
    if (binary.kind === "fake") return { ok: true, path: binary.path };
    if (pin) {
      const result = await pin;
      if (!result.ok) {
        const now = gogBinaryIdentity(result.path);
        const unchanged = now === null ? failedIdentity === null : failedIdentity !== null && sameGogIdentity(now, failedIdentity);
        if (unchanged) return { ok: false, error: gogError("transport_incompatible", result.reason) };
        pin = null;
      }
    }
    if (!pin) {
      const started = options.pinParameters
        ? verifyGogBinaryWith(binary.path, { env: env! }, options.pinParameters)
        : verifyGogBinary(binary.path, { env: env! });
      pin = started;
      const result = await started;
      if (!result.ok) failedIdentity = gogBinaryIdentity(result.path);
    }
    const result = await pin;
    if (!result.ok) return { ok: false, error: gogError("transport_incompatible", result.reason) };
    // The file must still be the one that was hashed.
    const now = gogBinaryIdentity(result.path);
    if (!now || !sameGogIdentity(now, result.identity)) {
      pin = null;
      failedIdentity = null;
      return { ok: false, error: gogError("transport_incompatible", "binary_changed") };
    }
    return { ok: true, path: result.path };
  }

  async function invoke(operation: GoogleOperation, call: GogInvocation): Promise<GogInvokeResult> {
    if (setup) return { ok: false, error: setup };
    const spec = GOG_COMMANDS[call.command];
    const effect: GogEffect = spec.write ? "write" : "read";
    let argv: string[];
    try {
      argv = gogArgv(call, account);
    } catch (error) {
      if (error instanceof GogArgvError) return { ok: false, error: gogError("invalid_input", "argv") };
      throw error;
    }
    const limit = accountLimits(account)[effect];
    return limit.run(async () => {
      for (let attempt = 1; ; attempt++) {
        const executable = await pinned();
        if (!executable.ok) return executable;
        const run = await runGogProcess(executable.path, argv, {
          env: env!, stdin: call.stdin, timeoutMs: effect === "write" ? writeMs : readMs, stdoutCap: GOG_STDOUT_CAP,
        });
        const error = gogProcessError(run.end, effect);
        options.log?.({
          operation, command: call.command, effect, attempt, outcome: error ? "error" : "ok", code: error?.code ?? null,
          reason: error?.reason ?? null, exit_code: run.end.kind === "exit" ? run.end.exitCode : null,
          duration_ms: Math.round(run.durationMs), stdout_bytes: run.stdoutBytes, stderr_bytes: run.stderrBytes,
        });
        if (!error) return { ok: true, stdout: run.stdout ?? new Uint8Array() };
        // One retry, for a read gog called retryable (exit 8). Never for a write.
        if (effect === "read" && attempt === 1 && run.end.kind === "exit" && run.end.exitCode === 8) {
          await sleep(retryDelayMs);
          continue;
        }
        return { ok: false, error };
      }
    });
  }

  async function decoded<T>(operation: GoogleOperation, call: GogInvocation, decode: (json: unknown) => T | Promise<T>): Promise<GogResult<T>> {
    const answer = await invoke(operation, call);
    if (!answer.ok) return answer;
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(answer.stdout));
    } catch {
      return { ok: false, error: gogError("transport_incompatible", "unexpected_output") };
    }
    try {
      return { ok: true, value: await decode(json) };
    } catch (error) {
      if (error instanceof GogShapeError) return { ok: false, error: gogError("transport_incompatible", "unexpected_shape") };
      throw error;
    }
  }

  async function search(input: GogOperationInput<"gmail.search">): Promise<GogResult<GmailSearchPageRecord>> {
    const page = await decoded("gmail.search", gogInvocation("gmail.search", input), GOG_READ_CODECS["gmail.search"]);
    if (!page.ok) return page;
    // Ids go back into argv, so they pass the same validator as any input.
    if (!page.value.thread_ids.every(thread_id => GOG_THREAD_INPUT.safeParse({ thread_id }).success)) {
      return { ok: false, error: gogError("transport_incompatible", "unexpected_shape") };
    }
    const reads = await Promise.all(page.value.thread_ids.map(thread_id =>
      decoded("gmail.search", gogInvocation("gmail.thread.get", { thread_id }), GOG_READ_CODECS["gmail.thread.get"])));
    const hits = [];
    for (const [index, read] of reads.entries()) {
      // A thread that went away between the search and its read is not a hit.
      if (!read.ok && read.error.code === "not_found") continue;
      if (!read.ok) return read;
      if (read.value.id !== page.value.thread_ids[index]) return { ok: false, error: gogError("transport_incompatible", "unexpected_shape") };
      hits.push(searchHitFromThread(read.value));
    }
    return { ok: true, value: { hits, next_page_token: page.value.next_page_token, result_size_estimate: null } };
  }

  async function execute<O extends GogReadOperation>(operation: O, input: GogOperationInput<O>): Promise<GogResult<GogReadResults[O]>> {
    if (setup) return { ok: false, error: setup };
    if (!(GOG_READ_OPERATIONS as readonly string[]).includes(operation)) {
      const known = Object.prototype.hasOwnProperty.call(GOG_OPERATION_INPUTS, operation);
      return { ok: false, error: known ? gogError("transport_incompatible", "no_codec") : gogError("invalid_input", "unknown_operation") };
    }
    const parsed = GOG_OPERATION_INPUTS[operation].safeParse(input);
    if (!parsed.success) return { ok: false, error: gogError("invalid_input", "schema") };
    const valid = parsed.data as GogOperationInput<O>;
    let call: GogInvocation;
    try {
      call = gogInvocation(operation, valid);
    } catch (error) {
      if (error instanceof GogArgvError) return { ok: false, error: gogError("invalid_input", "argv") };
      throw error;
    }
    const result: GogResult<unknown> = operation === "gmail.search"
      ? await search(valid as GogOperationInput<"gmail.search">)
      : await decoded<unknown>(operation, call, GOG_READ_CODECS[operation as GogReadOperation]);
    return result as GogResult<GogReadResults[O]>;
  }

  async function availability(): Promise<GogAvailability> {
    if (setup) return { ok: false, error: setup };
    if (binary.kind === "fake") return { ok: true, fake: true };
    const executable = await pinned();
    if (!executable.ok) return executable;
    const result = (await pin)!;
    return result.ok ? { ok: true, fake: false, pin: result } : { ok: false, error: gogError("transport_incompatible", result.reason) };
  }

  return { account, availability, execute, invoke };
}
