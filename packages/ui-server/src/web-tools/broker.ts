/**
 * The host side of the four web tools (#3685, epic #2765): one broker per
 * host between the turns that forward a call and the executor that runs it.
 *
 * - Identity: every call is bound to the scope the ws bridge captured from the
 *   authenticated turn (principal, session, turn, tool-call id, profile,
 *   policy revision). The executor receives that scope; no call field chooses
 *   it. A tool-call id runs once per turn.
 * - Handles: an executor's result id never reaches the model. The broker
 *   issues an opaque handle, scoped to the calling principal and session and
 *   to the executor session that produced it; a guessed, foreign or stale
 *   handle is `unknown_handle`, with no oracle saying which.
 * - Bounds: request bytes and fan-out (re-checked here, the authority),
 *   per-session and global concurrency, a bounded pending queue, a per-call
 *   deadline, response bytes, live executor sessions and stored handles.
 * - Lifecycle: a call settles exactly once. Cancellation, deadline and
 *   executor death settle it at once; a result that arrives afterwards, or
 *   after the turn stopped being current, is discarded. Each settled call
 *   and each ended executor session leaves a receipt.
 *
 * - Admission (#3687): before a call is dispatched, each provider it names
 *   is put to the calling turn's own authority (data routing and budget).
 *   While it runs, every connection its executor opens can be put to the same
 *   authority through `inFlight`; a refusal there settles the call with the
 *   authority's code, whatever the executor made of the failed connection.
 *
 * Provider credentials and configuration stay with the executor; the broker
 * knows only which provider ids the host admits.
 */
import { randomBytes } from "node:crypto";
import {
  parseWebToolInput, webToolProviders, type WebModelAccess, type WebModelGrant, type WebToolCall, type WebToolEnvelope, type WebToolErrorCode, type WebToolName,
} from "@schlessera/brain-ui-sdk/tool-contracts";
import { webProviderRecipient } from "./recipients.js";

/** The authenticated turn's identity for one call, captured by the ws bridge. */
export interface WebCallScope {
  principalId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  profile: "governed" | "strict";
  policyRevision: string | null;
}

/** Why the calling turn's authority refused a recipient: a web call error code and the words for the model. */
export interface WebCallRefusal { code: "policy_denied" | "budget_exceeded" | "unavailable"; message: string }

/**
 * The calling turn's own admission for the external recipients one web call
 * reaches (#3687). Built by the ws bridge from the authenticated turn, never
 * from anything the worker or executor says, and never sent to the executor.
 */
export interface WebCallAuthority {
  /** Data routing (G2) and budget admission for one recipient, by its policy name. */
  admit(recipient: string): Promise<WebCallRefusal | null>;
  /** One admitted provider request, attributed to the turn: unknown cost, never zero. */
  attempt(event: { recipient: string; host: string; callId: string }): void;
}

/** A dispatched call, as an executor connection is attributed to it. */
export interface WebInFlightCall {
  callId: string;
  tool: WebToolName;
  scope: WebCallScope;
  authority: WebCallAuthority | undefined;
  /** Settle the call as refused by its authority; the first refusal wins. */
  refuse(refusal: WebCallRefusal): void;
}

/** One call as the executor receives it: validated input, host scope, upstream handle substituted. */
export interface WebExecutorRequest {
  /** Broker-issued, unique per call. */
  callId: string;
  tool: WebToolName;
  input: Record<string, unknown>;
  scope: WebCallScope;
  /** The calling turn's admitted model (#3688), from its backend on the host; the executor host relays it. */
  model?: WebModelAccess;
  /** What the executor itself is told of that model once its relay runs: never a credential. */
  modelGrant?: WebModelGrant;
}

export type WebExecutorResult =
  | { ok: true; text: string; /** The executor's own id for stored content, if it stored any. */ handle?: string;
      /** Further ids the same result stored, such as a search's fetched pages; each gets its own host handle. */ handles?: string[] }
  | { ok: false; code: "failed" | "unsupported" | "unknown_handle"; message: string; feature?: string };

/** How an executor session ended, observed rather than assumed. */
export interface WebExecutorExit {
  reason: "idle" | "evicted" | "closed" | "died" | "cancel_timeout" | "start_failed";
  pid: number | null;
  code: number | null;
  signal: string | null;
  /** The process and its group were observed gone. */
  exited: boolean;
  /** The session's private state was removed; absent when it had none. */
  cleaned?: boolean;
}

/** One principal's session's executor: its stored results live and die with it. */
export interface WebExecutorSession {
  call(request: WebExecutorRequest, signal: AbortSignal): Promise<WebExecutorResult>;
  /** Settles when the session ends for any reason. */
  readonly ended: Promise<WebExecutorExit>;
  close(reason: WebExecutorExit["reason"]): Promise<WebExecutorExit>;
}

/** The internal executor boundary: one production implementation (#3686) and test doubles. */
export interface WebExecutor {
  open(owner: { principalId: string; sessionId: string }, signal: AbortSignal): Promise<WebExecutorSession>;
}

export interface WebBrokerLimits {
  globalConcurrency: number;
  sessionConcurrency: number;
  /** Calls waiting for a slot, host-wide. */
  queue: number;
  callDeadlineMs: number;
  /** UTF-8 bytes of one result's text. */
  responseBytes: number;
  /** Live executor sessions; the least recently used idle one is closed for a new one. */
  sessions: number;
  /** An executor session with no call for this long is closed. */
  idleMs: number;
  /** Handles one executor session keeps; the oldest is forgotten first. */
  handles: number;
  /** Tool-call ids remembered for replay refusal. */
  replayWindow: number;
}

/** Provisional bounds for the fixture-driven slice; #3687 measures and owns the admission policy. */
const WEB_BROKER_LIMITS: Readonly<WebBrokerLimits> = Object.freeze({
  globalConcurrency: 4, sessionConcurrency: 2, queue: 16, callDeadlineMs: 60_000, responseBytes: 131_072,
  sessions: 8, idleMs: 600_000, handles: 64, replayWindow: 4_096,
});

type WebCallOutcome = "completed" | WebToolErrorCode;

interface WebCallReceipt {
  kind: "call";
  callId: string | null;
  tool: WebToolName;
  scope: Omit<WebCallScope, "policyRevision"> & { policyRevision: string | null };
  outcome: WebCallOutcome;
  requestBytes: number;
  responseBytes: number;
  queuedMs: number;
  durationMs: number;
}
interface WebExecutorReceipt {
  kind: "executor";
  owner: { principalId: string; sessionId: string };
  generation: number;
  calls: number;
  exit: WebExecutorExit;
}
export type WebReceipt = WebCallReceipt | WebExecutorReceipt;

interface WebBrokerOptions {
  executor: WebExecutor;
  /** The provider ids this host admits for an explicit `provider`; the host default is always admitted. */
  admittedProviders: () => readonly string[];
  limits?: Partial<WebBrokerLimits>;
  onReceipt?: (receipt: WebReceipt) => void;
  now?: () => number;
}

export interface WebBroker {
  /**
   * `current` reports whether the calling turn still holds authority;
   * `authority` is that turn's admission for the recipients the call reaches.
   */
  call(scope: WebCallScope, call: WebToolCall, signal: AbortSignal, current: () => boolean, authority?: WebCallAuthority): Promise<WebToolEnvelope>;
  /** The calls one principal's session has dispatched and not settled, for attributing its executor's connections. */
  inFlight(owner: { principalId: string; sessionId: string }): readonly WebInFlightCall[];
  /** Close every executor session and refuse further calls. */
  close(): Promise<void>;
  /** For tests and diagnostics: counts only, no content. */
  stats(): { active: number; queued: number; sessions: number; handles: number };
}

interface Owned {
  key: string;
  owner: { principalId: string; sessionId: string };
  generation: number;
  session: Promise<WebExecutorSession>;
  active: number;
  calls: number;
  lastUsed: number;
  idle?: ReturnType<typeof setTimeout>;
  /** Opaque handle -> executor handle, insertion ordered. */
  handles: Map<string, string>;
  /** Calls dispatched to this executor session and not yet settled. */
  inFlight: Map<string, WebInFlightCall>;
  ended: boolean;
}

interface Waiter { sessionKey: string; resolve(): void; reject(error: Error): void }

class Settled extends Error {
  constructor(readonly code: WebToolErrorCode, message: string) { super(message); }
}

const ownerKey = (owner: { principalId: string; sessionId: string }) => `${owner.principalId}\u0000${owner.sessionId}`;
const bytes = (value: string) => Buffer.byteLength(value, "utf8");

export function createWebBroker(options: WebBrokerOptions): WebBroker {
  const limits: WebBrokerLimits = { ...WEB_BROKER_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const owned = new Map<string, Owned>();
  const queue: Waiter[] = [];
  const seen = new Set<string>();
  let active = 0, generation = 0, closed = false;
  // Opening an executor session is shared by every call of that session, so
  // it follows the broker's lifetime, never one caller's signal.
  const lifetime = new AbortController();
  const receipt = (value: WebReceipt) => { try { options.onReceipt?.(value); } catch { /* A receipt sink never fails the call. */ } };

  const activeIn = (key: string) => owned.get(key)?.active ?? 0;
  const hasSlot = (key: string) => active < limits.globalConcurrency && activeIn(key) < limits.sessionConcurrency;
  function wake(): void {
    for (let index = 0; index < queue.length; index++) {
      const waiter = queue[index]!;
      if (!hasSlot(waiter.sessionKey)) continue;
      queue.splice(index, 1);
      waiter.resolve();
      return;
    }
  }
  /** Take one slot for `key`, waiting in the bounded queue. The caller releases it. */
  async function acquire(key: string, signal: AbortSignal): Promise<void> {
    if (!hasSlot(key)) {
      if (queue.length >= limits.queue) throw new Settled("busy", "The host is running as many web calls as it allows; try again shortly.");
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { sessionKey: key, resolve: () => { signal.removeEventListener("abort", abort); resolve(); }, reject };
        const abort = () => { const at = queue.indexOf(waiter); if (at >= 0) queue.splice(at, 1); reject(new Settled("cancelled", "The turn was cancelled before the call started.")); };
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        queue.push(waiter);
      });
    }
    active++;
  }

  function end(entry: Owned, exit: WebExecutorExit): void {
    if (entry.ended) return;
    entry.ended = true;
    if (entry.idle) clearTimeout(entry.idle);
    entry.handles.clear();
    entry.inFlight.clear();
    if (owned.get(entry.key) === entry) owned.delete(entry.key);
    receipt({ kind: "executor", owner: entry.owner, generation: entry.generation, calls: entry.calls, exit });
    wake();
  }
  function retire(entry: Owned, reason: WebExecutorExit["reason"]): Promise<void> {
    // Settle bookkeeping now: a closing executor serves no further call.
    if (owned.get(entry.key) === entry) owned.delete(entry.key);
    return entry.session.then(session => session.close(reason)).then(exit => end(entry, exit),
      () => end(entry, { reason, pid: null, code: null, signal: null, exited: false }));
  }
  function scheduleIdle(entry: Owned): void {
    if (entry.idle) clearTimeout(entry.idle);
    if (entry.active > 0 || entry.ended) return;
    entry.idle = setTimeout(() => { if (entry.active === 0) void retire(entry, "idle"); }, limits.idleMs);
    entry.idle.unref?.();
  }
  async function ownedFor(owner: { principalId: string; sessionId: string }): Promise<Owned> {
    const key = ownerKey(owner);
    const existing = owned.get(key);
    if (existing) return existing;
    if (owned.size >= limits.sessions) {
      const idle = [...owned.values()].filter(entry => entry.active === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) throw new Settled("busy", "The host has as many web sessions open as it allows; try again shortly.");
      await retire(idle, "evicted");
      if (owned.has(key)) return owned.get(key)!;
    }
    const entry: Owned = { key, owner, generation: ++generation, session: options.executor.open(owner, lifetime.signal), active: 0, calls: 0,
      lastUsed: now(), handles: new Map(), inFlight: new Map(), ended: false };
    owned.set(key, entry);
    entry.session.then(session => session.ended.then(exit => end(entry, exit)),
      () => end(entry, { reason: "start_failed", pid: null, code: null, signal: null, exited: false }));
    return entry;
  }

  function issueHandle(entry: Owned, upstream: string): string {
    const handle = `wr_${randomBytes(18).toString("base64url")}`;
    entry.handles.set(handle, upstream);
    while (entry.handles.size > limits.handles) entry.handles.delete(entry.handles.keys().next().value!);
    return handle;
  }

  async function run(scope: WebCallScope, call: WebToolCall, signal: AbortSignal, current: () => boolean, authority: WebCallAuthority | undefined): Promise<{ envelope: WebToolEnvelope; callId: string | null; requestBytes: number; responseBytes: number; queuedMs: number; startedAt: number }> {
    const tool = call.tool;
    const fail = (code: WebToolErrorCode, message: string, feature?: string): WebToolEnvelope => ({ ok: false, tool, error: { code, message, ...(feature ? { feature } : {}) } });
    const started = now();
    const base = { callId: null, requestBytes: 0, responseBytes: 0, queuedMs: 0, startedAt: started };
    if (closed) return { ...base, envelope: fail("unavailable", "Web tools are not available on this host right now.") };
    const parsed = parseWebToolInput(tool, call.input);
    if (!parsed.ok) return { ...base, envelope: fail(parsed.code, parsed.message, parsed.feature) };
    const requestBytes = bytes(JSON.stringify(parsed.input));
    const admitted = new Set(options.admittedProviders());
    const refused = webToolProviders(parsed.input).filter(provider => !admitted.has(provider));
    if (refused.length) return { ...base, requestBytes, envelope: fail("provider_not_admitted", `This host does not admit ${refused.join(", ")} for web calls.`) };
    if (typeof call.toolCallId !== "string" || !call.toolCallId) return { ...base, requestBytes, envelope: fail("invalid_input", "A web call needs the model's tool call id.") };
    const replayKey = `${scope.turnId}\u0000${scope.toolCallId}`;
    if (seen.has(replayKey)) return { ...base, requestBytes, envelope: fail("replayed_call", "This tool call already ran; its result was returned once.") };
    seen.add(replayKey);
    while (seen.size > limits.replayWindow) seen.delete(seen.values().next().value!);
    if (signal.aborted || !current()) return { ...base, requestBytes, envelope: fail("cancelled", "The turn is no longer current.") };
    // Each provider the call names is admitted before anything is queued or sent.
    for (const provider of webToolProviders(parsed.input)) {
      let refusal: WebCallRefusal | null;
      try { refusal = authority ? await authority.admit(webProviderRecipient(provider)) : null; }
      catch { refusal = { code: "unavailable", message: "The host could not check this web call's admission; nothing was sent." }; }
      if (refusal) return { ...base, requestBytes, envelope: fail(refusal.code, refusal.message) };
    }
    if (signal.aborted || !current()) return { ...base, requestBytes, envelope: fail("cancelled", "The turn is no longer current.") };

    const owner = { principalId: scope.principalId, sessionId: scope.sessionId };
    const key = ownerKey(owner);
    // A handle is looked up before any slot is taken: an unknown one costs nothing.
    let input = parsed.input;
    if (tool === "get_search_content") {
      const upstream = owned.get(key)?.handles.get(String(input.responseId));
      if (!upstream) return { ...base, requestBytes, envelope: fail("unknown_handle", "No stored web result in this conversation has that responseId. Run the search or fetch again.") };
      input = { ...input, responseId: upstream };
    }
    try { await acquire(key, signal); }
    catch (error) { return { ...base, requestBytes, envelope: error instanceof Settled ? fail(error.code, error.message) : fail("failed", "The call could not be admitted.") }; }
    const queuedMs = now() - started;
    let entry: Owned | undefined;
    let dispatched: (() => WebCallRefusal | undefined) | undefined;
    const callId = `wc_${randomBytes(12).toString("base64url")}`;
    const controller = new AbortController();
    let outcome: Settled | undefined;
    const settle = (error: Settled) => { if (!outcome) { outcome = error; controller.abort(error); } };
    const onAbort = () => settle(new Settled("cancelled", "The turn was cancelled; the call was stopped."));
    signal.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => settle(new Settled("deadline", `The call did not finish within ${limits.callDeadlineMs} ms and was stopped.`)), limits.callDeadlineMs);
    try {
      entry = await ownedFor(owner);
      // The handle must still belong to this executor session after any wait.
      if (tool === "get_search_content" && entry.handles.get(String(parsed.input.responseId)) !== input.responseId) {
        return { ...base, callId, requestBytes, queuedMs, envelope: fail("unknown_handle", "That stored web result is no longer available. Run the search or fetch again.") };
      }
      entry.active++; entry.calls++; entry.lastUsed = now();
      let refused: WebCallRefusal | undefined;
      const inFlight: WebInFlightCall = { callId, tool, scope, authority, refuse: refusal => { refused ??= refusal; } };
      entry.inFlight.set(callId, inFlight);
      dispatched = () => refused;
      if (entry.idle) clearTimeout(entry.idle);
      let session: WebExecutorSession;
      try { session = await entry.session; }
      catch { throw new Settled("unavailable", "The web executor could not start; nothing ran."); }
      if (outcome) throw outcome;
      const died = entry.ended ? Promise.resolve() : session.ended.then(() => settle(new Settled("executor_died", "The web executor stopped during the call; nothing it produced was kept.")));
      void died;
      const stopped = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(controller.signal.reason);
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      });
      const result = await Promise.race([session.call({ callId, tool, input, scope, ...(call.model ? { model: call.model } : {}) }, controller.signal), stopped]);
      // No late or cross-turn result: re-check liveness before any data returns.
      if (outcome) throw outcome;
      const refusal = dispatched?.();
      if (refusal) return { ...base, callId, requestBytes, queuedMs, envelope: fail(refusal.code, refusal.message) };
      if (signal.aborted || !current()) throw new Settled("cancelled", "The turn stopped being current before the result returned; it was discarded.");
      if (!result.ok) return { ...base, callId, requestBytes, queuedMs, envelope: fail(result.code, result.message, result.feature) };
      const responseBytes = bytes(result.text);
      if (responseBytes > limits.responseBytes) {
        return { ...base, callId, requestBytes, responseBytes, queuedMs, envelope: fail("response_too_large", `The result is ${responseBytes} bytes; the limit is ${limits.responseBytes}.`) };
      }
      if (result.handle !== undefined && (typeof result.handle !== "string" || !result.handle)) throw new Settled("failed", "The executor returned a malformed handle.");
      let responseId: string | undefined;
      if (tool === "get_search_content") responseId = String(parsed.input.responseId);
      else if (result.handle) responseId = issueHandle(entry, result.handle);
      for (const extra of result.handles ?? []) if (typeof extra === "string" && extra && extra !== result.handle) issueHandle(entry, extra);
      // No executor id reaches the model: every id this session's executor
      // issued is replaced by the host's handle for it, wherever it appears.
      let text = result.text;
      for (const [opaque, upstream] of entry.handles) text = text.split(upstream).join(opaque);
      return { ...base, callId, requestBytes, responseBytes, queuedMs, envelope: { ok: true, tool, text, ...(responseId ? { responseId } : {}) } };
    } catch (error) {
      const settled = outcome ?? (error instanceof Settled ? error : new Settled("failed", "The web executor failed this call."));
      if (settled.code === "executor_died" || (entry?.ended && settled.code !== "unavailable")) return { ...base, callId, requestBytes, queuedMs, envelope: fail("executor_died", "The web executor stopped during the call; nothing it produced was kept.") };
      return { ...base, callId, requestBytes, queuedMs, envelope: fail(settled.code, settled.message) };
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener("abort", onAbort);
      controller.abort(new Settled("cancelled", "settled"));
      active--;
      if (entry) { if (dispatched) entry.inFlight.delete(callId); entry.active--; entry.lastUsed = now(); scheduleIdle(entry); }
      wake();
    }
  }

  return {
    async call(scope, call, signal, current, authority) {
      const ran = await run(scope, call, signal, current, authority);
      receipt({ kind: "call", callId: ran.callId, tool: call.tool, scope, outcome: ran.envelope.ok ? "completed" : ran.envelope.error.code,
        requestBytes: ran.requestBytes, responseBytes: ran.responseBytes, queuedMs: ran.queuedMs, durationMs: now() - ran.startedAt });
      return ran.envelope;
    },
    async close() {
      closed = true;
      lifetime.abort();
      for (const waiter of queue.splice(0)) waiter.reject(new Settled("unavailable", "The host closed its web tools."));
      await Promise.allSettled([...owned.values()].map(entry => retire(entry, "closed")));
    },
    inFlight: owner => [...owned.get(ownerKey(owner))?.inFlight.values() ?? []],
    stats: () => ({ active, queued: queue.length, sessions: owned.size, handles: [...owned.values()].reduce((sum, entry) => sum + entry.handles.size, 0) }),
  };
}
