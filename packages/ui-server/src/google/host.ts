/**
 * The host Gmail tools (#4207, epic #4201; plan
 * [`docs/plans/google-workspace.md`](../../../../docs/plans/google-workspace.md)
 * §6, §9). A hosted turn reads Gmail only through these: the host holds the
 * credential (`./credential.ts`), binds the turn, decides every call with
 * the pure decision function in common under the turn's frozen policy, runs
 * the read through the pinned gog transport, enforces `hidden_labels` on
 * what came back, projects it into one of the two views, and records the
 * session's taint before any content view returns. It mirrors the host
 * GitHub tools (`../github/host.ts`).
 *
 * Per call, in this order (plan §6 steps 1 to 5, 10 and 13):
 *
 * 1. Input: the tool's strict schema (`parseGoogleToolCall`); the call names
 *    its operation.
 * 2. Writes: the four write tools answer `unavailable` (`writes_unavailable`)
 *    until the write engine lands (#4211). Nothing is decided or sent.
 * 3. The gate: the decision function with every host fact except the
 *    targets' labels, which only the read itself can give: availability
 *    (owner only, an enabled block naming an account, Gmail listed), input,
 *    mode, card need and posture, and routing as the provider-policy
 *    recipient `google`. A refusal sends Google nothing.
 * 4. The read, through the account's transport. A thread read, a message
 *    read and a draft read under a non-empty `hidden_labels` also read the
 *    target's thread, so the decision sees the labels of every message in it.
 * 5. The final decision, with those labels: a target in a thread any of
 *    whose messages carries a hidden label answers exactly as a missing one
 *    does (`not_found`, no reason). While any label is hidden, so does a
 *    target whose labels could not be established: a fetch that failed in a
 *    way that may be the target's own, an answer for another id, a draft
 *    with no message, or a thread that could not be read. A search drops
 *    every hit whose thread carries one, and the label list drops the
 *    hidden labels themselves. Label names come from the label list, so a
 *    result carries them only where the policy admits `gmail.labels.list`.
 * 6. Provenance: a `content` result records `google_result` through the
 *    `untrusted` callback before it returns, and a failure to record it
 *    withholds the result. A `structured` result records nothing: the
 *    call's collector obligation is discharged by its result with nothing to
 *    record, as for any result without an input or output signal. The label
 *    list is always structured.
 *
 * Search cursors are host-minted (`gc_` and 18 random bytes) and kept here,
 * in memory, bound to the conversation and the query that produced them:
 * Google's page token never reaches the model, and a cursor from another
 * conversation or for another query is refused (`invalid_input`, `cursor`).
 * The table is bounded and its entries expire; a restart forgets them, and
 * the model searches again.
 */
import { randomBytes } from "node:crypto";
import { isTargetIndependentGogFailure, type GogResult, type GogTransport } from "@schlessera/brain-common/internal/google-gog";
import {
  contentGmailDraft, contentGmailMessageResult, contentGmailSearch, contentGmailThread, decideGoogleCall, gmailLabelDirectory, isGmailThreadId,
  parseGoogleToolCall, structuredGmailDraft, structuredGmailLabels, structuredGmailMessageResult, structuredGmailSearch, structuredGmailThread,
  GOOGLE_HOST_CURSOR_PREFIX, GOOGLE_NOT_FOUND_MESSAGE,
  type GmailLabelDirectory, type GmailLabelRecord, type GmailMessageRecord, type GmailReadInput, type GmailSearchInput, type GoogleDecision,
  type GoogleDecisionFacts, type GoogleError, type GoogleOperation, type GooglePolicy, type GooglePrincipalKind,
} from "@schlessera/brain-common/internal/google-operations";
import {
  GMAIL_DETAIL_LIMITS, GMAIL_TOOL_NAMES, isGmailReadToolName,
  type GmailMessageBody, type GmailReadPayload, type GmailReadToolName, type GmailSearchPayload, type GmailToolName, type GoogleToolCall,
  type GoogleToolResult,
} from "@schlessera/brain-ui-sdk/tool-contracts";
import type { RecipientRoutingRefusal } from "../web-tools/routing.js";
import type { AuthMode } from "../middleware/auth.js";
import { isUsablePrincipal, type Principal } from "../db/principals.js";
import { accountScope } from "../middleware/account-partition.js";
import type { GoogleCredential } from "./credential.js";

/**
 * Who a principal is to the Google tools (Q9: the owner only): the owner
 * account as the account partition knows it, an owner login or the ambient
 * principal where the auth mode makes it the owner (no auth, Tailscale). A
 * proxy's upstream users are each their own account, and a delegated agent
 * or a system principal is no owner. A missing, revoked or expired principal
 * is nobody.
 */
export function googlePrincipalKind(principal: Principal | null | undefined, authMode: AuthMode, at: number): GooglePrincipalKind {
  if (!principal || !isUsablePrincipal(principal, at)) return "none";
  return accountScope(principal, authMode) === "owner" ? "owner" : "not_owner";
}

/** Google's name as a provider-policy recipient (G2), as the Gemini provider's is. */
const GOOGLE_RECIPIENT = "google";

/** The turn a call belongs to, bound by the host, never by the call. */
export interface GoogleToolsTurn {
  readonly turnId: string;
  readonly principalId: string;
  readonly sessionId: () => string | null;
  /** How the turn runs. Voice never grants, and reads need no grant (ruling 6). */
  readonly posture: "interactive" | "voice";
  /** The turn's frozen admitted policy's `google` block; null when the turn runs under no governance policy. */
  readonly policy: () => GooglePolicy | null | undefined;
  /**
   * Data routing (G2) under the turn's frozen policy and the conversation's
   * recorded exposures, asked before any read. A throw counts as unproven.
   */
  readonly routing: (recipient: typeof GOOGLE_RECIPIENT) => Promise<RecipientRoutingRefusal | null>;
  /** Whether the session has ingested untrusted input; a failing read counts as tainted. */
  readonly tainted: () => boolean;
}

interface GoogleToolsHostOptions {
  /** The host's credential: the account's transport, or why Google is unavailable. */
  credential: Pick<GoogleCredential, "transport">;
  /** Who a principal is to Google: the brain's owner, another principal, or nobody the host could establish. */
  principal: (principalId: string) => GooglePrincipalKind;
  /**
   * Records the session's untrusted-input taint (`google_result`). Awaited
   * before a content result is returned; when it throws, the result is
   * withheld.
   */
  untrusted: (turn: GoogleToolsTurn, event: { tool: GmailReadToolName; detail: string }) => Promise<void>;
  /**
   * Records one audit line per Google call (plan §6 step 13): the governance
   * event `google_call`, which the safety projection never reads. Awaited, but
   * never load-bearing: a failure to record it is reported and changes no
   * answer.
   */
  audit?: (scope: GoogleAuditScope, event: GoogleCallAudit) => Promise<void> | void;
  report?: (message: string) => void;
  now?: () => number;
  /** How long a search cursor stands. Default {@link GOOGLE_CURSOR_TTL_MS}. */
  cursorTtlMs?: number;
  /** How long the account's label list is reused for label names. Default {@link GOOGLE_LABEL_TTL_MS}. */
  labelTtlMs?: number;
}

type GoogleMessageBodyResult = { ok: true; body: GmailMessageBody } | { ok: false; error: GoogleError };

/** Who an audit line is attributed to: a turn's call, or the owner's display route. */
interface GoogleAuditScope { turnId: string | null; sessionId: string | null; actor: "interactive" | "voice" | "user" }

/** One Google call's audit line: what was asked and how it ended, never what Google returned. */
export interface GoogleCallAudit {
  tool: string;
  /** The catalog operation, or null when the input named none. */
  operation: GoogleOperation | null;
  /** The view a returned result carries; null for a refusal. */
  view: "structured" | "content" | null;
  outcome: "returned" | "refused";
  code: GoogleError["code"] | null;
  reason: string | null;
}

export interface GoogleToolsHost {
  call(turn: GoogleToolsTurn, call: GoogleToolCall): Promise<GoogleToolResult>;
  /**
   * One message's full text body for the owner's display (the internal
   * detail route): decided as a read of it, with its thread's labels against
   * `hidden_labels`, and never provider context, so it is neither routed nor
   * recorded as taint. The route scopes the id to this session's results.
   */
  messageBody(principalId: string, policy: GooglePolicy | null | undefined, messageId: string, sessionId?: string | null): Promise<GoogleMessageBodyResult>;
}

/** A search cursor stands this long. */
const GOOGLE_CURSOR_TTL_MS = 30 * 60_000;
/** At most this many cursors are kept; the oldest goes first. */
const GOOGLE_CURSOR_LIMIT = 512;
/** The account's label list is reused this long for label names. */
const GOOGLE_LABEL_TTL_MS = 5 * 60_000;

const WRITES_UNAVAILABLE: GoogleError = { code: "unavailable", reason: "writes_unavailable",
  message: "Gmail changes are not available on this host yet: only search and read are. Nothing was changed." };
const SHAPE: GoogleError = { code: "transport_incompatible", reason: "unexpected_shape",
  message: "The Google transport answered in a shape brain-kit does not read." };
const CURSOR: GoogleError = { code: "invalid_input", reason: "cursor",
  message: "That cursor is not one this conversation's search for this query returned, or it expired. Search again without it." };
const NOT_RECORDED: GoogleError = { code: "recording_unavailable", reason: "recording_unavailable",
  message: "The read could not be recorded as untrusted input, so its content was withheld." };
const NOT_FOUND: GoogleError = { code: "not_found", reason: null, message: GOOGLE_NOT_FOUND_MESSAGE };

/** A refusal in the result envelope, bounded. A real miss reads exactly as a hidden target does. */
function refusal(tool: GmailToolName, error: GoogleError): GoogleToolResult {
  if (error.code === "not_found") return { ok: false, tool, error: NOT_FOUND };
  return { ok: false, tool, error: { code: error.code, reason: error.reason === null ? null : error.reason.slice(0, 64), message: error.message.slice(0, 500) } };
}

/** The decision's facts that only the turn knows. A host step that throws counts against the call. */
async function turnFacts(options: GoogleToolsHostOptions, turn: GoogleToolsTurn): Promise<GoogleDecisionFacts> {
  let principal: GooglePrincipalKind = "none";
  try { principal = options.principal(turn.principalId); } catch { /* Unknown is nobody. */ }
  let routed: RecipientRoutingRefusal | null = "recipient_unproven";
  try { routed = await turn.routing(GOOGLE_RECIPIENT); } catch { /* Unknown exposure is unproven. */ }
  let tainted = true;
  try { tainted = turn.tainted(); } catch { /* Unknown taint is tainted. */ }
  return { principal, posture: turn.posture, tainted, routing: routed ?? "allowed",
    // No Google card exists before the write engine (#4211); reads never need one.
    card_available: false, turn_reversible_items: 0 };
}

/**
 * The policy the gate decides with: the turn's own, with the hidden-label
 * step deferred to the final decision, because only the read can give the
 * labels of what it targets. Every other step decides exactly as the final
 * decision will.
 */
function deferringHiddenLabels(policy: GooglePolicy | null | undefined): GooglePolicy | null | undefined {
  if (!policy || typeof policy !== "object" || !policy.gmail || typeof policy.gmail !== "object") return policy;
  return { ...policy, gmail: { ...policy.gmail, hidden_labels: [] } };
}

const hiddenOf = (policy: GooglePolicy): readonly string[] => Array.isArray(policy.gmail?.hidden_labels) ? policy.gmail.hidden_labels : [];

/**
 * A target's fetch that failed before its labels were seen. While anything is
 * hidden it reads as a miss unless the failure says nothing about the target,
 * so no answer tells a hidden target from a missing one.
 */
function fetchFailure(policy: GooglePolicy, failure: GoogleError): GoogleError {
  return failure.code === "not_found" || (hiddenOf(policy).length > 0 && !isTargetIndependentGogFailure(failure)) ? NOT_FOUND : failure;
}

/** An answer for another id: a miss while anything is hidden, else a shape the host does not read. */
const mismatch = (policy: GooglePolicy): GoogleError => hiddenOf(policy).length > 0 ? NOT_FOUND : SHAPE;

/** A safe slice: never a lone surrogate at the cut. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export function createGoogleToolsHost(options: GoogleToolsHostOptions): GoogleToolsHost {
  const now = options.now ?? Date.now;
  /** A failing log never changes an answer: the message is built inside the guard, so an error that cannot be shown is dropped too. */
  const report = (message: () => string) => { try { options.report?.(message()); } catch { /* Dropped. */ } };
  const shown = (error: unknown) => error instanceof Error ? error.message : String(error);
  const cursorTtl = options.cursorTtlMs ?? GOOGLE_CURSOR_TTL_MS;
  const labelTtl = options.labelTtlMs ?? GOOGLE_LABEL_TTL_MS;
  const cursors = new Map<string, { scope: string; query: string; token: string; expires: number }>();
  // Keyed by the transport, which the credential keeps per account alias and home.
  const labelCache = new WeakMap<GogTransport, { at: number; labels: GmailLabelRecord[] }>();

  function mintCursor(scope: string, query: string, token: string): string {
    const at = now();
    for (const [key, entry] of cursors) if (entry.expires <= at) cursors.delete(key);
    while (cursors.size >= GOOGLE_CURSOR_LIMIT) cursors.delete(cursors.keys().next().value!);
    const cursor = `${GOOGLE_HOST_CURSOR_PREFIX}${randomBytes(18).toString("base64url")}`;
    cursors.set(cursor, { scope, query, token, expires: at + cursorTtl });
    return cursor;
  }

  /**
   * The account's label list, reused for a while; null when the policy does
   * not admit reading it (`names`) or it cannot be read, and then every name
   * is null.
   */
  async function labelsOf(transport: GogTransport, names: boolean): Promise<GmailLabelRecord[] | null> {
    if (!names) return null;
    const cached = labelCache.get(transport);
    if (cached && now() - cached.at < labelTtl) return cached.labels;
    let read: GogResult<GmailLabelRecord[]>;
    try { read = await transport.execute("gmail.labels.list", {}); } catch { return null; }
    if (!read.ok) return null;
    labelCache.set(transport, { at: now(), labels: read.value });
    return read.value;
  }

  /** Names for label ids from the account's list, without the hidden labels; none when the list could not be read. */
  const named = (labels: readonly GmailLabelRecord[] | null, hidden: readonly string[]): { labels?: GmailLabelDirectory } =>
    labels ? { labels: gmailLabelDirectory(labels.filter(label => !hidden.includes(label.id))) } : {};

  /** The account's transport, or the credential's reason Google is unavailable. */
  function transportFor(account: string): { ok: true; transport: GogTransport } | { ok: false; error: GoogleError } {
    let opened: ReturnType<GoogleCredential["transport"]>;
    try { opened = options.credential.transport(account); }
    catch { return { ok: false, error: { code: "unavailable", reason: "probe_failed", message: "The Google availability check failed unexpectedly; the next call checks again." } }; }
    if (!opened.ok) return { ok: false, error: { code: "unavailable", reason: opened.status.reason, message: `Google is unavailable on this host: ${opened.status.detail}` } };
    return { ok: true, transport: opened.transport };
  }

  /**
   * Every label id in the thread of a read target: its own labels and, when
   * `hidden_labels` is not empty, those of every message of its thread. A
   * thread whose labels cannot be established is never clean: it reads as a
   * miss, as a hidden one does.
   */
  async function targetLabels(transport: GogTransport, policy: GooglePolicy, own: readonly string[], threadId: string | null): Promise<string[] | GoogleError> {
    if (hiddenOf(policy).length === 0) return [...own];
    if (!isGmailThreadId(threadId)) return NOT_FOUND;
    const thread = await transport.execute("gmail.thread.get", { thread_id: threadId });
    if (!thread.ok || thread.value.id !== threadId) return NOT_FOUND;
    return [...new Set([...own, ...thread.value.messages.flatMap(message => message.label_ids)])];
  }

  /** The final decision, once the read gave the targets' labels: anything but admitted refuses. */
  function finalDecision(policy: GooglePolicy, operation: GoogleOperation, input: unknown, facts: GoogleDecisionFacts, labels: string[]): GoogleDecision {
    return decideGoogleCall(policy, { operation, input }, { ...facts, target_label_ids: labels });
  }

  async function search(turn: GoogleToolsTurn, transport: GogTransport, policy: GooglePolicy, input: GmailSearchInput, names: boolean): Promise<GmailSearchPayload | GoogleError> {
    const scope = turn.sessionId() ?? `turn:${turn.turnId}`;
    let token: string | undefined;
    if (input.cursor !== undefined) {
      const found = cursors.get(input.cursor);
      if (!found || found.expires <= now() || found.scope !== scope || found.query !== input.query) return CURSOR;
      token = found.token;
    }
    const [page, labels] = await Promise.all([
      transport.execute("gmail.search", { query: input.query, ...(input.limit !== undefined ? { limit: input.limit } : {}), ...(token !== undefined ? { page_token: token } : {}) }),
      labelsOf(transport, names),
    ]);
    if (!page.ok) return page.error;
    const hidden = hiddenOf(policy);
    // Enforced on results, never on the query (plan §5): a hit whose thread carries a hidden label is absent.
    const hits = page.value.hits.filter(hit => !hit.label_ids.some(label => hidden.includes(label)));
    const cursor = page.value.next_page_token ? mintCursor(scope, input.query, page.value.next_page_token) : null;
    const context = { ...named(labels, hidden), cursor };
    const filtered = { ...page.value, hits };
    return input.view === "structured" ? { kind: "search", ...structuredGmailSearch(filtered, context) } : { kind: "search", ...contentGmailSearch(filtered, context) };
  }

  async function read(transport: GogTransport, policy: GooglePolicy, input: GmailReadInput, facts: GoogleDecisionFacts, operation: GoogleOperation, names: boolean): Promise<GmailReadPayload | GoogleError> {
    const hidden = hiddenOf(policy);
    if (input.target === "labels") {
      const list = await transport.execute("gmail.labels.list", {});
      if (!list.ok) return list.error;
      labelCache.set(transport, { at: now(), labels: list.value });
      // The label list is the owner's configuration (ruling 5): structured, whatever the view; hidden labels are not in it.
      return { kind: "labels", ...structuredGmailLabels(list.value.filter(label => !hidden.includes(label.id))) };
    }
    const decide = (labels: string[]) => {
      const decision = finalDecision(policy, operation, input, facts, labels);
      return decision.outcome === "admitted" ? null : decision.outcome === "refused" ? decision.error : { code: "policy_denied" as const, reason: "needs_card", message: "This read needs an approval the host cannot ask for." };
    };
    const id = input.id!;
    const structured = input.view === "structured";
    if (input.target === "thread") {
      const [thread, labels] = await Promise.all([transport.execute("gmail.thread.get", { thread_id: id }), labelsOf(transport, names)]);
      if (!thread.ok) return fetchFailure(policy, thread.error);
      if (thread.value.id !== id) return mismatch(policy);
      const refused = decide([...new Set(thread.value.messages.flatMap(message => message.label_ids))]);
      if (refused) return refused;
      const context = named(labels, hidden);
      const projected = structured ? structuredGmailThread(thread.value, context) : contentGmailThread(thread.value, context);
      return projected ? { kind: "thread", ...projected } as GmailReadPayload : SHAPE;
    }
    if (input.target === "message") {
      const [message, labels] = await Promise.all([transport.execute("gmail.message.get", { message_id: id }), labelsOf(transport, names)]);
      if (!message.ok) return fetchFailure(policy, message.error);
      if (message.value.id !== id) return mismatch(policy);
      const targets = await targetLabels(transport, policy, message.value.label_ids, message.value.thread_id);
      if (!Array.isArray(targets)) return targets;
      const refused = decide(targets);
      if (refused) return refused;
      const context = named(labels, hidden);
      const projected = structured ? structuredGmailMessageResult(message.value, context) : contentGmailMessageResult(message.value, context);
      return projected ? { kind: "message", ...projected } as GmailReadPayload : SHAPE;
    }
    const [draft, labels] = await Promise.all([transport.execute("gmail.draft.get", { draft_id: id }), labelsOf(transport, names)]);
    if (!draft.ok) return fetchFailure(policy, draft.error);
    const record = draft.value.draft;
    if (record.id !== id) return mismatch(policy);
    // A draft with no message has no labels to establish: with anything hidden, it is not shown.
    if (!record.message && hidden.length > 0) return NOT_FOUND;
    const targets = record.message ? await targetLabels(transport, policy, record.message.label_ids, record.message.thread_id) : [];
    if (!Array.isArray(targets)) return targets;
    const refused = decide(targets);
    if (refused) return refused;
    const context = named(labels, hidden);
    const projected = structured ? structuredGmailDraft(record, context) : contentGmailDraft(record, context);
    return projected ? { kind: "draft", ...projected } as GmailReadPayload : SHAPE;
  }

  /** One call, decided and run; the caller records its audit line. */
  async function run(turn: GoogleToolsTurn, name: string, parsed: ReturnType<typeof parseGoogleToolCall>): Promise<GoogleToolResult> {
      if (!parsed.ok) return refusal(isGmailToolName(name) ? name : GMAIL_TOOL_NAMES.search, parsed.error);
      const tool = parsed.call.tool;
      if (!isGmailReadToolName(tool)) return refusal(tool, WRITES_UNAVAILABLE);
      const { operation, input } = parsed.call;
      try {
        const facts = await turnFacts(options, turn);
        let policy: GooglePolicy | null | undefined;
        // A policy the turn cannot give is one the decision cannot read.
        try { policy = turn.policy(); } catch { policy = {} as GooglePolicy; }
        // The gate: every step but the targets' labels, before anything is sent.
        const gate = decideGoogleCall(deferringHiddenLabels(policy), { operation, input }, facts);
        if (gate.outcome === "refused") return refusal(tool, gate.error);
        if (gate.outcome !== "admitted") return refusal(tool, { code: "policy_denied", reason: "needs_card", message: "This read needs an approval the host cannot ask for." });
        const admitted = policy!;
        const opened = transportFor(admitted.account!);
        if (!opened.ok) return refusal(tool, opened.error);
        // Label names come from reading the label list, so only where the policy admits that read itself.
        const names = decideGoogleCall(admitted, { operation: "gmail.labels.list", input: { target: "labels" } }, facts).outcome === "admitted";
        const result = tool === GMAIL_TOOL_NAMES.search
          ? await search(turn, opened.transport, admitted, input as GmailSearchInput, names)
          : await read(opened.transport, admitted, input as GmailReadInput, facts, operation, names);
        if (!("kind" in result)) return refusal(tool, result);
        // Provenance before return: a content view taints first, and an unrecorded taint withholds it.
        if (result.view === "content") {
          const target = tool === GMAIL_TOOL_NAMES.read ? ` ${(input as GmailReadInput).target}` : "";
          try { await options.untrusted(turn, { tool, detail: `${operation}${target}` }); }
          catch (error) {
            report(() => `Gmail ${operation} taint not recorded, content withheld: ${shown(error)}`);
            return refusal(tool, NOT_RECORDED);
          }
        }
        return tool === GMAIL_TOOL_NAMES.search
          ? { ok: true, tool, result: result as GmailSearchPayload }
          : { ok: true, tool, result: result as GmailReadPayload };
      } catch (error) {
        report(() => `Gmail tool ${tool} failed: ${shown(error)}`);
        return refusal(tool, { code: "upstream_error", reason: null, message: "The Gmail read failed." });
      }
    }

  /** Records an audit line; never changes the answer. */
  async function audited(scope: () => GoogleAuditScope, event: () => GoogleCallAudit): Promise<void> {
    // Everything, the line's own fields included, is read inside the guard.
    try { if (options.audit) await options.audit(scope(), event()); }
    catch (error) { report(() => `Gmail call audit not recorded: ${shown(error)}`); }
  }

  return {
    async call(turn, call) {
      let tool: string = GMAIL_TOOL_NAMES.search;
      let parsed: ReturnType<typeof parseGoogleToolCall> | null = null;
      let result: GoogleToolResult;
      // Always an answer: nothing a call brings, or any step throws, escapes as a rejection.
      try {
        tool = call.tool;
        parsed = parseGoogleToolCall(tool, call.input);
        result = await run(turn, tool, parsed);
      } catch (error) {
        report(() => `Gmail tool ${String(tool)} failed: ${shown(error)}`);
        result = refusal(isGmailToolName(tool) ? tool : GMAIL_TOOL_NAMES.search, { code: "upstream_error", reason: null, message: "The Gmail read failed." });
      }
      const answer = result;
      await audited(() => {
        let sessionId: string | null = null;
        try { sessionId = turn.sessionId(); } catch { /* Unbound. */ }
        return { turnId: turn.turnId, sessionId, actor: turn.posture };
      }, () => ({ tool, operation: parsed?.ok ? parsed.call.operation : null, view: answer.ok ? answer.result.view : null,
        outcome: answer.ok ? "returned" : "refused", code: answer.ok ? null : answer.error.code, reason: answer.ok ? null : answer.error.reason }));
      return answer;
    },

    async messageBody(principalId, policy, messageId, sessionId = null) {
      const result = await body(principalId, policy, messageId);
      await audited(() => ({ turnId: null, sessionId, actor: "user" }), () => ({ tool: GOOGLE_MESSAGE_BODY_ROUTE, operation: "gmail.message.get",
        view: result.ok ? "content" : null, outcome: result.ok ? "returned" : "refused", code: result.ok ? null : result.error.code,
        reason: result.ok ? null : result.error.reason }));
      return result;
    },
  };

  async function body(principalId: string, policy: GooglePolicy | null | undefined, messageId: string): Promise<GoogleMessageBodyResult> {
      try {
        let principal: GooglePrincipalKind = "none";
        try { principal = options.principal(principalId); } catch { /* Unknown is nobody. */ }
        const input = { target: "message", id: messageId, view: "content" };
        // Display only, for the owner: no model text goes to Google and nothing returns to a turn.
        const facts: GoogleDecisionFacts = { principal, posture: "interactive", tainted: false, routing: "allowed", card_available: false, turn_reversible_items: 0 };
        const gate = decideGoogleCall(deferringHiddenLabels(policy), { operation: "gmail.message.get", input }, facts);
        if (gate.outcome !== "admitted") return { ok: false, error: gate.outcome === "refused" ? (gate.error.code === "not_found" ? NOT_FOUND : gate.error)
          : { code: "policy_denied", reason: "needs_card", message: "This read needs an approval the host cannot ask for." } };
        const opened = transportFor(policy!.account!);
        if (!opened.ok) return { ok: false, error: opened.error };
        const message = await opened.transport.execute("gmail.message.get", { message_id: messageId });
        if (!message.ok) return { ok: false, error: fetchFailure(policy!, message.error) };
        if (message.value.id !== messageId) return { ok: false, error: mismatch(policy!) };
        const targets = await targetLabels(opened.transport, policy!, message.value.label_ids, message.value.thread_id);
        if (!Array.isArray(targets)) return { ok: false, error: targets };
        const decision = finalDecision(policy!, "gmail.message.get", input, facts, targets);
        if (decision.outcome !== "admitted") return { ok: false, error: decision.outcome === "refused" ? (decision.error.code === "not_found" ? NOT_FOUND : decision.error) : SHAPE };
        return { ok: true, body: messageBodyOf(message.value) };
      } catch (error) {
        report(() => `Gmail message body failed: ${shown(error)}`);
        return { ok: false, error: { code: "upstream_error", reason: null, message: "The Gmail read failed." } };
      }
  }
}

/** The audit line's `tool` for the owner's display route, which is no model tool. */
const GOOGLE_MESSAGE_BODY_ROUTE = "gmail_message_body";

const isGmailToolName = (name: string): name is GmailToolName => (Object.values(GMAIL_TOOL_NAMES) as string[]).includes(name);

/** The full text body, bounded for display. */
function messageBodyOf(record: GmailMessageRecord): GmailMessageBody {
  const body = typeof record.body_text === "string" ? record.body_text : null;
  const shown = body === null ? null : cut(body, GMAIL_DETAIL_LIMITS.bodyChars);
  return { message_id: record.id, body_text: shown, body_length: body === null ? null : body.length, body_truncated: body !== null && shown!.length < body.length };
}
