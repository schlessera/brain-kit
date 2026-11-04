/**
 * Apify catalog discovery and concrete Actor consent (#3160,
 * [the contract](../../../../docs/decisions/apify-capability.md)).
 *
 * Four independent facts stand between a model and a remote Actor run, and
 * none implies another: the provider is enabled and authenticated (#3159,
 * {@link ApifyAuthority}); catalog discovery is permitted (`apify.discovery`);
 * this exact Actor build, input, price and destination set is consented to
 * (`apify.actors`, an exact standing grant or a one-use approval); and the
 * spend is admitted (#3161, the `dispatch` callback of {@link ApifyConsent.admitRun}).
 *
 * Discovery and inspection send data to Apify, so they follow the discovery
 * mode and the session's provider-folder routing (G2). Their results are
 * remote, untrusted text (G6): the caller is told before it receives them,
 * and nothing in them is ever read as policy, a grant or an instruction.
 *
 * A proposal binds account and authority generation, principal, session,
 * turn, policy version, the immutable Actor id, the resolved build id and
 * number, the full input-schema and pricing fingerprints, the qualified
 * profile, the exact canonical input, its target origins and the run cap.
 * {@link ApifyConsent.admitRun} re-reads all of it live before and after any
 * approval, and consumes the proposal before dispatch, so a changed fact,
 * a second use, a declined, edited or unanswerable approval dispatches
 * nothing. Tool-name approvals and remembered tool grants never reach here:
 * every approval this module requests is a per-use `command` confirmation.
 *
 * Candidate and proposal references are opaque random values held only in
 * this process. A restart forgets them, which refuses rather than grants.
 * Request counts are durable when the host supplies a {@link ApifyRequestMeter}
 * (#3161, shared with the run service's ledger); the in-memory fallback is for
 * a host without one.
 *
 * The hosted server keeps candidates and proposals in this process. A
 * standalone CLI or MCP process keeps them in the shared ledger instead
 * ({@link ApifyConsentState}, #3162), so one `brain apify` invocation can
 * inspect what an earlier one discovered; the references stay bound to their
 * principal and session, and a proposal still admits at most once, now across
 * processes.
 *
 * This module lives in core so the CLI, the core MCP wrappers and the hosted
 * bridge share it (#3162). It names no UI type: the host passes its approval
 * surface and provider-folder routing in.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { APIFY_LIMIT_BOUNDS, APIFY_MAX_RUN_USD, checkGovernancePolicy, type EffectiveGovernancePolicy } from "../governance-policy.js";
import { APIFY_API_ORIGIN, APIFY_MCP_ORIGIN, type ApifyAuthority, type ApifyBinding } from "./authority.js";
import type { ApifyLedger } from "./ledger.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { APIFY_QUALIFIED_PROFILES, ApifyProfileInputError, profileInput, type ApifyQualifiedProfile } from "./profiles.js";

export { canonicalJson, sha256 } from "./canonical.js";
export { APIFY_QUALIFIED_PROFILES, type ApifyQualifiedProfile } from "./profiles.js";

/** The policy name an Apify recipient carries in `providers[].allow`. */
export const APIFY_RECIPIENT = "apify";
export type ApifyMode = "deny" | "ask" | "allow";
export type ApifyActorGrant = EffectiveGovernancePolicy["apify"]["actor_grants"][number];

/** Request bounds the host pins; a caller cannot enlarge them. */
export const APIFY_DISCOVERY_LIMITS = Object.freeze({
  /** Catalog query characters; a query names a platform or data type, not brain content. */
  query_chars: 80,
  query_words: 6,
  default_results: 5,
  /** The upstream maximum when input fields are included. */
  max_results: 10,
  /**
   * Apify operations (discover, inspect, prepare, admission) within one turn
   * while the policy sets no `apify.limits`; with limits,
   * `max_requests_per_turn` replaces it and counts every Apify request.
   */
  requests_per_turn: 32,
  description_chars: 600,
  readme_chars: 8_000,
  input_bytes: 64 * 1024,
  input_depth: 16,
  /** Candidates remembered per session; the oldest are forgotten first. */
  candidates_per_session: 200,
  proposal_ttl_ms: 15 * 60_000,
});

/** Stable refusal codes from the contract's machine set. */
export type ApifyConsentCode = "provider_disabled" | "policy_denied" | "approval_required" | "proposal_stale" | "actor_unsupported" | "budget_exceeded" | "upstream_incompatible";

/** A refusal whose message is fixed and actionable; it never carries remote text or a secret. */
export class ApifyConsentError extends Error {
  constructor(readonly code: ApifyConsentCode, readonly reason: string, message: string) {
    super(message);
    this.name = "ApifyConsentError";
  }
}
/** Input the operation's own schema refuses before anything is sent. */
export class ApifyInputError extends TypeError {
  constructor(message: string) { super(message); this.name = "ApifyInputError"; }
}

/** What an approval card is asked to show: the host's permission request, by structure. */
export interface ApifyPermissionRequest {
  toolUseId: string;
  toolName: string;
  description: string;
  input: Record<string, unknown>;
  /** Always a per-use command confirmation: never a rememberable tool grant. */
  kind: "command";
}
/** A live turn's approval surface: the host bridge's `requestPermission`, by structure. */
export interface ApifyApprovalSurface {
  requestPermission(request: ApifyPermissionRequest): Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }>;
}
/** What one earlier turn of the conversation showed its recipient of the provider folders (G2). */
export interface ApifyProviderExposure {
  readonly recipient: string;
  readonly visible: readonly string[];
  readonly hidden: readonly string[];
}
/**
 * The host's provider-folder routing rules (G2), passed in so this module
 * names no host type. Without them, any provider rule refuses as unproven.
 */
export interface ApifyProviderRouting {
  unsupportedProviderSelectors(policy: Pick<EffectiveGovernancePolicy, "providers">): string[];
  providerDeniedFolders(policy: Pick<EffectiveGovernancePolicy, "providers">, typeFolders: Readonly<Record<string, readonly string[]>>, recipient: string | undefined): string[];
  exposureConflicts(exposures: readonly ApifyProviderExposure[], denied: readonly string[]): unknown[];
}

/** What the governance policy says, read anew for every decision. */
export interface ApifyConsentPolicy {
  valid: boolean;
  /** The policy version a proposal binds; any edit makes earlier proposals stale. */
  hash: string;
  enabled: boolean;
  discovery: ApifyMode;
  actors: ApifyMode;
  grants: readonly ApifyActorGrant[];
  providers: EffectiveGovernancePolicy["providers"];
  /** `apify.limits`, or null when the policy sets none (no run is then admitted). */
  limits: EffectiveGovernancePolicy["apify"]["limits"];
}

/**
 * Counts one Apify request against its turn's bound, durably and across
 * processes; throws `budget_exceeded` once the bound is reached. Supplied by
 * the run service's ledger (#3161).
 */
export type ApifyRequestMeter = (scope: { principal_id: string; session_id: string; turn_id: string }, requests: number) => void | Promise<void>;

export function governanceApifyConsentPolicy(brainPath: string): () => ApifyConsentPolicy {
  return () => {
    const checked = checkGovernancePolicy(brainPath);
    const apify = checked.effective.apify;
    return { valid: checked.ok, hash: checked.content_hash ?? checked.status, enabled: checked.ok && apify.enabled === true,
      // An invalid policy has resolved defaults; it denies rather than asks.
      discovery: checked.ok ? apify.discovery : "deny", actors: checked.ok ? apify.actors : "deny",
      grants: checked.ok ? apify.actor_grants : [], providers: checked.effective.providers, limits: checked.ok ? apify.limits : null };
  };
}

/** Who is asking, from where, and how they can be asked. Built by the host for one live call. */
export interface ApifyCallContext {
  readonly principal_id: string;
  readonly session_id: string;
  readonly turn_id: string;
  /** Only an interactive turn can raise an approval card; voice and autonomous turns never can. */
  readonly posture: "interactive" | "voice" | "autonomous";
  /** The live turn's approval surface, or null when nobody can be asked. */
  readonly approvals: ApifyApprovalSurface | null;
  /** The session's recorded provider-folder exposures, this turn's included. Absent: unknown, so restricted policies refuse. */
  readonly exposures?: () => readonly ApifyProviderExposure[];
  /** Each provider type selector's folders, from the brain taxonomy. */
  readonly typeFolders?: Readonly<Record<string, readonly string[]>>;
  /**
   * Remote text is about to reach the caller (G6). Awaited before any result
   * is returned: a failure returns nothing.
   */
  untrusted(event: { operation: "discover" | "inspect" | "results"; detail: string }): void | Promise<void>;
  readonly signal?: AbortSignal;
}

export interface ApifyCandidateSummary {
  /** Opaque, bound to this principal and session; not an Actor id. */
  candidate: string;
  actor: string;
  title: string | null;
  description: string | null;
  developer: string | null;
  pricing_model: string | null;
  deprecated: boolean;
}
export interface ApifyDiscoverResult {
  candidates: ApifyCandidateSummary[];
  /** Always true: every field above came from Apify. */
  untrusted: true;
}

export interface ApifyPricingSummary {
  model: string | null;
  events: Array<{ name: string; title: string | null; price_usd: number | null; tiered: boolean }>;
  platform_usage_paid_by_user: boolean | null;
  minimal_max_total_charge_usd: number | null;
  /** Why the price shown may not be what this account pays; empty only for a fully stated price. */
  uncertainty: string[];
}

export interface ApifyActorFacts {
  actor_id: string;
  actor: string;
  title: string | null;
  description: string | null;
  build_id: string;
  build_number: string;
  build_tag: string;
  schema_sha256: string;
  pricing_sha256: string;
  permission_level: "LIMITED_PERMISSIONS" | "FULL_PERMISSIONS" | null;
  pricing: ApifyPricingSummary;
  input_fields: string[];
  secret_fields: string[];
  required_fields: string[];
  profile_id: string | null;
  eligibility: { executable: boolean; reasons: string[] };
}
export interface ApifyInspectResult extends ApifyActorFacts {
  candidate: string;
  readme: string | null;
  untrusted: true;
}

/** What a reviewer sees before consenting, and what the proposal binds. */
export interface ApifyActorReview {
  actor: { id: string; name: string; title: string | null; purpose: string | null; untrusted: true };
  build: { id: string; number: string; tag: string };
  account_id: string;
  permission_level: string;
  pricing: ApifyPricingSummary;
  schema_sha256: string;
  pricing_sha256: string;
  profile_id: string | null;
  recipient: string;
  input: Record<string, unknown>;
  input_sha256: string;
  origins: string[];
  max_charge_usd: number;
  eligibility: { executable: boolean; reasons: string[] };
  consent: "one-use";
}
export interface ApifyPrepareResult {
  proposal: string;
  review: ApifyActorReview;
  /** How admission will decide: refused by policy, matched by a standing grant, or asked each time. */
  admission: "grant" | "ask";
  expires_at: string;
}

/** What #3161 receives to reserve and dispatch exactly once. */
export interface ApifyRunTicket {
  readonly proposal: string;
  readonly binding: ApifyBinding;
  readonly actor_id: string;
  readonly build_id: string;
  readonly build_number: string;
  readonly profile_id: string;
  /** The live build's input-schema and price-list fingerprints, which the profile must pin exactly. */
  readonly schema_sha256: string;
  readonly pricing_sha256: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly input_sha256: string;
  readonly origins: readonly string[];
  readonly max_charge_usd: number;
  /** Integer microdollars, rounded up. */
  readonly max_charge_microusd: number;
  readonly consent: { source: "grant"; expires_at: string } | { source: "approval" };
  readonly principal_id: string;
  readonly session_id: string;
  readonly turn_id: string;
}

export interface ApifyConsent {
  discover(context: ApifyCallContext, input: { query: string; limit?: number }): Promise<ApifyDiscoverResult>;
  inspect(context: ApifyCallContext, input: { candidate: string }): Promise<ApifyInspectResult>;
  prepare(context: ApifyCallContext, input: { candidate: string; input: unknown; max_charge_usd: number }): Promise<ApifyPrepareResult>;
  /**
   * Re-evaluate a proposal live, obtain consent, consume it, then hand the
   * ticket to `dispatch` exactly once. Any refusal throws before `dispatch`.
   */
  admitRun<T>(context: ApifyCallContext, input: { proposal: string }, dispatch: (ticket: ApifyRunTicket) => Promise<T>): Promise<T>;
}

export interface ApifyConsentOptions {
  authority: ApifyAuthority;
  policy: () => ApifyConsentPolicy;
  /** @internal Test seam; production uses {@link APIFY_QUALIFIED_PROFILES}. */
  profiles?: readonly ApifyQualifiedProfile[];
  /** The durable per-turn request count shared with the run service; without it, counts live in this process. */
  meter?: ApifyRequestMeter;
  /** The host's provider-folder routing (G2). Without it, any provider rule refuses as unproven. */
  routing?: ApifyProviderRouting;
  /** Where candidates and proposals are kept; default this process ({@link memoryConsentState}). */
  state?: ApifyConsentState;
  now?: () => number;
}

/** A discovered Actor, bound to the principal and session that discovered it. */
export interface ApifyStoredCandidate {
  principal_id: string; session_id: string; binding: ApifyBinding;
  actor_id: string; actor: string;
  inspected: ApifyActorFacts | null;
}
export type ApifyProposalState = "prepared" | "admitting" | "consumed" | "refused";
/** A prepared run, bound to everything consent was asked for. */
export interface ApifyStoredProposal {
  principal_id: string; session_id: string; turn_id: string; binding: ApifyBinding; policy_hash: string;
  facts: ApifyActorFacts; input: Record<string, unknown>; input_sha256: string; origins: string[];
  max_charge_usd: number; expires_at: number;
  state: ApifyProposalState;
}
type Candidate = ApifyStoredCandidate;
type Proposal = ApifyStoredProposal;

/**
 * Where consent keeps its opaque references. Every read returns a copy: a
 * change takes effect only through these methods, so the ledger-backed store
 * behaves as the in-memory one does.
 */
export interface ApifyConsentState {
  candidate(ref: string): ApifyStoredCandidate | null;
  /** Remember new candidates, then forget the session's oldest beyond `keep`. */
  addCandidates(entries: ReadonlyArray<readonly [string, ApifyStoredCandidate]>, session_id: string, keep: number): void;
  inspected(ref: string, facts: ApifyActorFacts): void;
  proposal(ref: string): ApifyStoredProposal | null;
  /** Forget spent, refused and expired proposals, then store this one. */
  addProposal(ref: string, proposal: ApifyStoredProposal, now: number): void;
  /** Move a proposal from `from` to `to` in one step; false when it was not in `from`. */
  transition(ref: string, from: ApifyProposalState, to: ApifyProposalState): boolean;
}

/** References held only in this process: a restart forgets them, which refuses rather than grants. */
export function memoryConsentState(): ApifyConsentState {
  const candidates = new Map<string, Candidate>();
  const proposals = new Map<string, Proposal>();
  return {
    candidate: ref => { const found = candidates.get(ref); return found ? structuredClone(found) : null; },
    addCandidates(entries, session_id, keep) {
      for (const [ref, candidate] of entries) candidates.set(ref, structuredClone(candidate));
      const mine = [...candidates].filter(([, candidate]) => candidate.session_id === session_id);
      for (const [ref] of mine.slice(0, Math.max(0, mine.length - keep))) candidates.delete(ref);
    },
    inspected(ref, facts) { const found = candidates.get(ref); if (found) found.inspected = structuredClone(facts); },
    proposal: ref => { const found = proposals.get(ref); return found ? structuredClone(found) : null; },
    addProposal(ref, proposal, at) {
      // Spent, refused and expired proposals refuse the same whether kept or forgotten.
      for (const [key, entry] of proposals) if (entry.expires_at <= at || entry.state === "consumed" || entry.state === "refused") proposals.delete(key);
      proposals.set(ref, structuredClone(proposal));
    },
    transition(ref, from, to) {
      const found = proposals.get(ref);
      if (!found || found.state !== from) return false;
      found.state = to;
      return true;
    },
  };
}

/**
 * References kept in the shared ledger, for a standalone CLI or MCP process
 * (#3162): a later invocation of the same principal and session finds them,
 * and a proposal's one admission is decided by the ledger's write lock.
 */
export function ledgerConsentState(ledger: () => ApifyLedger): ApifyConsentState {
  return {
    candidate: ref => ledger().reference<Candidate>("candidate", ref)?.body ?? null,
    addCandidates(entries, session_id, keep) { ledger().addReferences("candidate", entries.map(([ref, body]) => ({ ref, session_id, state: "found", expires_at: null, body })), keep); },
    inspected(ref, facts) { ledger().updateReference<Candidate>("candidate", ref, body => ({ ...body, inspected: facts })); },
    proposal(ref) {
      const found = ledger().reference<Proposal>("proposal", ref);
      return found ? { ...found.body, state: found.state as ApifyProposalState } : null;
    },
    addProposal(ref, proposal, at) { ledger().addProposalReference(ref, proposal.session_id, proposal.state, proposal.expires_at, proposal, at); },
    transition: (ref, from, to) => ledger().transitionReference(ref, from, to),
  };
}

const ACTOR_ID = /^[A-Za-z0-9]{1,64}$/u;
const ACTOR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const BUILD_NUMBER = /^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$/u;
const BUILD_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const REFERENCE = /^[A-Za-z0-9_-]{43}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

const refuse = (code: ApifyConsentCode, reason: string, message: string) => new ApifyConsentError(code, reason, message);
const STALE_REFERENCE = () => refuse("proposal_stale", "unknown_reference",
  "That Apify reference is unknown, expired or belongs to another conversation. Discover and inspect the Actor again.");

const reference = () => randomBytes(32).toString("base64url");
const clip = (value: unknown, limit: number): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** A plain JSON object with bounded size and depth, without prototype keys; its own canonical copy. */
function plainInput(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new ApifyInputError("Actor input must be a JSON object.");
  let text: string;
  try { text = JSON.stringify(value); } catch { throw new ApifyInputError("Actor input must be plain JSON."); }
  if (Buffer.byteLength(text) > APIFY_DISCOVERY_LIMITS.input_bytes) throw new ApifyInputError(`Actor input exceeds ${APIFY_DISCOVERY_LIMITS.input_bytes} bytes.`);
  const copy = JSON.parse(text) as Record<string, unknown>;
  const walk = (node: unknown, depth: number): void => {
    if (depth > APIFY_DISCOVERY_LIMITS.input_depth) throw new ApifyInputError(`Actor input nests deeper than ${APIFY_DISCOVERY_LIMITS.input_depth} levels.`);
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    const object = record(node);
    if (!object) return;
    for (const key of Object.keys(object)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") throw new ApifyInputError("Actor input uses a reserved key.");
      walk(object[key], depth + 1);
    }
  };
  walk(copy, 0);
  return copy;
}

function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") && !isIP(host)) return true;
  if (isIP(host) === 4) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (isIP(host) === 6) {
    if (host === "::" || host === "::1") return true;
    const mapped = /^::ffff:([0-9.]+)$/u.exec(host);
    if (mapped) return privateHost(mapped[1]!);
    return /^(fc|fd|fe[89ab])/u.test(host) || host.startsWith("::ffff:");
  }
  return false;
}

/** Every web origin the input names. Credentials in a URL, other schemes and private or local hosts refuse. */
function targetOrigins(input: Record<string, unknown>): string[] {
  const origins = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(trimmed)) return;
      let url: URL;
      try { url = new URL(trimmed); } catch { throw new ApifyInputError("Actor input contains a URL that does not parse."); }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new ApifyInputError(`Actor input names an unsupported ${url.protocol} URL.`);
      if (url.username || url.password) throw new ApifyInputError("Actor input must not carry credentials in a URL.");
      if (privateHost(url.hostname)) throw new ApifyInputError("Actor input must not target a private, local or link-local host.");
      origins.add(url.origin);
      return;
    }
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    const object = record(node);
    if (object) for (const value of Object.values(object)) walk(value);
  };
  walk(input);
  return [...origins].sort();
}

/** The pricing entry in force now: the latest that has started. */
function pricingSummary(pricingInfos: unknown, now: number): ApifyPricingSummary {
  const uncertainty: string[] = [];
  const entries = Array.isArray(pricingInfos) ? pricingInfos.map(record).filter((entry): entry is Record<string, unknown> => entry !== null) : [];
  const started = entries.filter(entry => { const at = Date.parse(String(entry.startedAt ?? "")); return Number.isFinite(at) && at <= now; })
    .sort((a, b) => Date.parse(String(b.startedAt)) - Date.parse(String(a.startedAt)));
  if (entries.length > started.length) uncertainty.push("scheduled_price_change");
  const current = started[0];
  if (!current) {
    return { model: null, events: [], platform_usage_paid_by_user: null, minimal_max_total_charge_usd: null,
      uncertainty: [...uncertainty, "pricing_unknown"] };
  }
  const model = typeof current.pricingModel === "string" ? current.pricingModel.slice(0, 64) : null;
  const events: ApifyPricingSummary["events"] = [];
  const charges = record(record(current.pricingPerEvent)?.actorChargeEvents);
  for (const [name, raw] of Object.entries(charges ?? {}).slice(0, 50)) {
    const event = record(raw);
    if (!event) continue;
    const tiered = record(event.eventTieredPricingUsd) !== null;
    const price = typeof event.eventPriceUsd === "number" && Number.isFinite(event.eventPriceUsd) && event.eventPriceUsd >= 0 ? event.eventPriceUsd : null;
    if (tiered) uncertainty.push(`account_tier_unverified:${name.slice(0, 64)}`);
    else if (price === null) uncertainty.push(`event_price_unknown:${name.slice(0, 64)}`);
    events.push({ name: name.slice(0, 64), title: clip(event.eventTitle, 120), price_usd: price, tiered });
  }
  const paidByUser = typeof current.isPPEPlatformUsagePaidByUser === "boolean" ? current.isPPEPlatformUsagePaidByUser : null;
  if (model !== "PAY_PER_EVENT") uncertainty.push("not_pay_per_event");
  else if (paidByUser !== false) uncertainty.push(paidByUser ? "platform_usage_billed_separately" : "platform_usage_billing_unknown");
  if (model === "PAY_PER_EVENT" && !events.length) uncertainty.push("events_unknown");
  const minimal = typeof current.minimalMaxTotalChargeUsd === "number" && Number.isFinite(current.minimalMaxTotalChargeUsd) ? current.minimalMaxTotalChargeUsd : null;
  return { model, events, platform_usage_paid_by_user: paidByUser, minimal_max_total_charge_usd: minimal, uncertainty };
}

function schemaFields(schema: Record<string, unknown> | null) {
  const properties = record(schema?.properties) ?? {};
  return {
    input_fields: Object.keys(properties).sort(),
    secret_fields: Object.entries(properties).filter(([, field]) => record(field)?.isSecret === true).map(([name]) => name).sort(),
    required_fields: Array.isArray(schema?.required) ? schema.required.filter((name): name is string => typeof name === "string").sort() : [],
  };
}

export function createApifyConsent(options: ApifyConsentOptions): ApifyConsent {
  const now = options.now ?? Date.now;
  const profiles = options.profiles ?? APIFY_QUALIFIED_PROFILES;
  const state = options.state ?? memoryConsentState();
  const turnRequests = new Map<string, number>();

  function policyGate(): ApifyConsentPolicy {
    const policy = options.policy();
    if (!policy.valid || !policy.enabled)
      throw refuse("provider_disabled", policy.valid ? "not_enabled" : "policy_invalid",
        policy.valid ? "Apify is disabled. Set apify.enabled: true in context/policies/governance.md to enable it."
          : "Apify is disabled because context/policies/governance.md is invalid. Repair it (brain policy check) before using Apify.");
    return policy;
  }

  /**
   * Counts an operation's Apify requests against this turn's bound: the
   * policy's `max_requests_per_turn` in the shared durable meter when the host
   * supplies one, else the pinned bound in this process.
   */
  async function spendRequest(context: ApifyCallContext, policy: ApifyConsentPolicy, requests = 1): Promise<void> {
    if (options.meter) { await options.meter(context, requests); return; }
    const bound = policy.limits?.max_requests_per_turn ?? APIFY_DISCOVERY_LIMITS.requests_per_turn;
    const key = `${context.session_id}\u0000${context.turn_id}`;
    const used = turnRequests.get(key) ?? 0;
    if (used + requests > bound)
      throw refuse("budget_exceeded", "requests_per_turn", `This turn already made ${used} of its ${bound} Apify requests. Continue in a new turn.`);
    turnRequests.delete(key);
    turnRequests.set(key, used + requests);
    // Bounded memory: forget the least recent turns.
    while (turnRequests.size > 1024) turnRequests.delete(turnRequests.keys().next().value!);
  }

  /** G2: nothing leaves for Apify from a session that has shown it a provider folder Apify may not receive. */
  function routingGate(context: ApifyCallContext, policy: ApifyConsentPolicy): void {
    if (!policy.providers.length) return;
    const restricting = policy.providers.filter(rule => !rule.allow.includes(APIFY_RECIPIENT));
    const selectsTypes = restricting.some(rule => rule.types?.length);
    const routing = options.routing;
    // A selector no folder mask can express cannot be checked against exposures either.
    const unexpressible = !routing || routing.unsupportedProviderSelectors({ providers: restricting }).length > 0;
    if (!routing || !context.exposures || unexpressible || (selectsTypes && !context.typeFolders))
      throw refuse("policy_denied", "recipient_unproven",
        "The provider policy restricts folders and this conversation's exposure to them is unknown here, so nothing was sent to Apify.");
    const denied = routing.providerDeniedFolders(policy, context.typeFolders ?? {}, APIFY_RECIPIENT);
    if (routing.exposureConflicts(context.exposures(), denied).length)
      throw refuse("policy_denied", "recipient_restricted",
        "This conversation has shown folders the provider policy does not allow Apify to receive, so nothing was sent to Apify. Start a new conversation for Apify work.");
  }

  function scoped<T extends { principal_id: string; session_id: string }>(read: (ref: string) => T | null, context: ApifyCallContext, ref: unknown): T {
    if (typeof ref !== "string" || !REFERENCE.test(ref)) throw STALE_REFERENCE();
    const found = read(ref);
    if (!found || found.principal_id !== context.principal_id || found.session_id !== context.session_id) throw STALE_REFERENCE();
    return found;
  }

  /**
   * Ask the live human for one exact operation. Returns only on an unedited
   * approval; every other outcome throws. Voice and autonomous turns, and a
   * turn without a surface, are never prompted.
   */
  async function approve(context: ApifyCallContext, request: Omit<ApifyPermissionRequest, "toolUseId" | "kind">): Promise<void> {
    const noGrantSurface = context.posture !== "interactive" || context.approvals === null;
    if (noGrantSurface) {
      throw refuse("approval_required", "no_grant_surface",
        "This needs a person's approval, and nobody can be asked from here. Ask in an interactive conversation, or add an exact grant through a policy change.");
    }
    const full: ApifyPermissionRequest = { ...request, toolUseId: randomUUID(), kind: "command" };
    const decision = await context.approvals!.requestPermission(full);
    // Each field is read once: an accessor cannot answer the check one way and the use another.
    const behavior = decision.behavior, updatedInput = decision.updatedInput;
    if (context.signal?.aborted) throw refuse("approval_required", "cancelled", "The turn ended before the approval was given; nothing was sent.");
    if (behavior !== "allow") throw refuse("policy_denied", "declined", "The approval was declined; nothing was sent to Apify.");
    if (updatedInput !== undefined)
      throw refuse("proposal_stale", "edited", "The approval came back with a changed request, which nobody reviewed as it is; nothing was sent. Prepare it again as wanted.");
  }

  /** Authoritative REST facts for one Actor's default build, refreshed every time they matter. */
  async function actorFacts(binding: ApifyBinding, actorId: string, context: ApifyCallContext): Promise<ApifyActorFacts> {
    const incompatible = () => refuse("upstream_incompatible", "actor_metadata", "Apify returned Actor metadata this host does not recognise, so nothing was done with it.");
    const signal = context.signal ? { signal: context.signal } : {};
    const actResponse = await options.authority.request(binding, { method: "GET", path: `/v2/acts/${actorId}`, ...signal });
    if (actResponse.status === 404) throw refuse("proposal_stale", "actor_missing", "That Actor no longer exists or is no longer visible to this account.");
    const act = record(record(actResponse.data)?.data);
    if (actResponse.status !== 200 || !act || typeof act.id !== "string" || typeof act.username !== "string" || typeof act.name !== "string") throw incompatible();
    // A redirect alias, a renamed Actor or a different id is a different Actor.
    if (act.id !== actorId) throw refuse("proposal_stale", "actor_substituted", "Apify answered for a different Actor than the one discovered; nothing was approved.");
    const tag = typeof record(act.defaultRunOptions)?.build === "string" ? String(record(act.defaultRunOptions)!.build) : "latest";
    const tagged = record(record(act.taggedBuilds)?.[tag]);
    const reasons: string[] = [];
    let buildId: string | null = typeof tagged?.buildId === "string" && ACTOR_ID.test(tagged.buildId) ? tagged.buildId : null;
    let buildNumber: string | null = typeof tagged?.buildNumber === "string" && BUILD_NUMBER.test(tagged.buildNumber) ? tagged.buildNumber : null;
    let schema: Record<string, unknown> | null = null;
    if (!BUILD_TAG.test(tag) || !buildId || !buildNumber) { reasons.push("build_unresolved"); buildId = null; buildNumber = null; }
    else {
      const buildResponse = await options.authority.request(binding, { method: "GET", path: `/v2/actor-builds/${buildId}`, ...signal });
      const build = record(record(buildResponse.data)?.data);
      if (buildResponse.status !== 200 || !build) throw incompatible();
      if (build.id !== buildId || build.actId !== actorId || build.buildNumber !== buildNumber)
        throw refuse("proposal_stale", "build_substituted", "Apify answered with a different build than the Actor's tag names; nothing was approved.");
      if (build.status !== "SUCCEEDED") reasons.push("build_not_succeeded");
      schema = record(record(build.actorDefinition)?.input);
      if (!schema && typeof build.inputSchema === "string") {
        try { schema = record(JSON.parse(build.inputSchema)); } catch { schema = null; }
      }
      if (!schema) reasons.push("input_schema_unknown");
    }
    const pricing = pricingSummary(act.pricingInfos, now());
    const permission = act.actorPermissionLevel === "LIMITED_PERMISSIONS" || act.actorPermissionLevel === "FULL_PERMISSIONS" ? act.actorPermissionLevel : null;
    if (permission === null) reasons.push("permission_level_unknown");
    else if (permission === "FULL_PERMISSIONS") reasons.push("full_permissions");
    if (pricing.uncertainty.length) reasons.push("pricing_not_bounded");
    if (act.isDeprecated === true) reasons.push("deprecated");
    const schemaSha = sha256(canonicalJson(schema));
    // The whole price list, scheduled changes included: any change is a different price.
    const pricingSha = sha256(canonicalJson(Array.isArray(act.pricingInfos) ? act.pricingInfos : null));
    const named = buildNumber ? profiles.find(entry => entry.actor_id === actorId && entry.build_number === buildNumber) ?? null : null;
    // A profile qualifies the exact schema and price it was measured against, nothing else.
    const profile = named && named.schema_sha256 === schemaSha && named.pricing_sha256 === pricingSha ? named : null;
    if (!named) reasons.push("no_qualified_profile");
    else if (!profile) reasons.push(named.schema_sha256 !== schemaSha ? "profile_schema_mismatch" : "profile_pricing_mismatch");
    return {
      actor_id: actorId, actor: `${act.username}/${act.name}`.slice(0, 201),
      title: clip(act.title, 200), description: clip(act.description, APIFY_DISCOVERY_LIMITS.description_chars),
      build_id: buildId ?? "", build_number: buildNumber ?? "", build_tag: tag.slice(0, 64),
      schema_sha256: schemaSha, pricing_sha256: pricingSha,
      permission_level: permission, pricing, ...schemaFields(schema),
      profile_id: profile?.id ?? null,
      eligibility: { executable: reasons.length === 0, reasons },
    };
  }

  /** The facts a proposal bound, against live ones. */
  function changed(bound: ApifyActorFacts, live: ApifyActorFacts): string | null {
    if (live.actor !== bound.actor) return "actor_renamed";
    if (live.build_id !== bound.build_id || live.build_number !== bound.build_number) return "build_changed";
    if (live.schema_sha256 !== bound.schema_sha256) return "schema_changed";
    if (live.pricing_sha256 !== bound.pricing_sha256) return "pricing_changed";
    if (live.permission_level !== bound.permission_level) return "permission_changed";
    if (live.profile_id !== bound.profile_id) return "profile_changed";
    return null;
  }

  function grantFor(policy: ApifyConsentPolicy, proposal: Proposal): ApifyActorGrant | null {
    const facts = proposal.facts;
    return policy.grants.find(grant => grant.account_id === proposal.binding.account_id && grant.actor_id === facts.actor_id
      && grant.build_number === facts.build_number && facts.profile_id !== null && grant.profile_id === facts.profile_id
      && grant.schema_sha256 === facts.schema_sha256 && grant.pricing_sha256 === facts.pricing_sha256
      && proposal.origins.every(origin => grant.origins.includes(origin))
      && Date.parse(grant.expires_at) > now() && proposal.max_charge_usd <= grant.max_run_usd) ?? null;
  }

  function review(proposal: Proposal): ApifyActorReview {
    const facts = proposal.facts;
    return {
      actor: { id: facts.actor_id, name: facts.actor, title: facts.title, purpose: facts.description, untrusted: true },
      build: { id: facts.build_id, number: facts.build_number, tag: facts.build_tag },
      account_id: proposal.binding.account_id,
      permission_level: facts.permission_level ?? "unknown",
      pricing: facts.pricing, schema_sha256: facts.schema_sha256, pricing_sha256: facts.pricing_sha256, profile_id: facts.profile_id,
      recipient: APIFY_API_ORIGIN, input: structuredClone(proposal.input), input_sha256: proposal.input_sha256,
      origins: [...proposal.origins], max_charge_usd: proposal.max_charge_usd, eligibility: facts.eligibility, consent: "one-use",
    };
  }

  /** Everything a proposal bound, read live. Throws on the first difference. */
  async function revalidate(context: ApifyCallContext, proposal: Proposal): Promise<ApifyConsentPolicy> {
    const policy = policyGate();
    await options.authority.check(proposal.binding);
    if (policy.hash !== proposal.policy_hash)
      throw refuse("proposal_stale", "policy_changed", "The governance policy changed after this Actor run was prepared. Prepare it again under the current policy.");
    if (policy.actors === "deny") throw refuse("policy_denied", "actors_denied", "Running Apify Actors is denied by apify.actors in the governance policy.");
    routingGate(context, policy);
    // Two REST reads: the Actor and its build.
    await spendRequest(context, policy, 2);
    const live = await actorFacts(proposal.binding, proposal.facts.actor_id, context);
    const difference = changed(proposal.facts, live);
    if (difference) throw refuse("proposal_stale", difference, "The Actor's build, input schema, price, permissions or qualification changed after review. Inspect and prepare it again.");
    if (!live.eligibility.executable)
      throw refuse("actor_unsupported", live.eligibility.reasons[0] ?? "unsupported",
        "This Actor build is not qualified for bounded execution here, so it cannot run. It can still be inspected.");
    return policy;
  }

  return {
    async discover(context, input) {
      const raw = record(input);
      if (!raw || Object.keys(raw).some(key => key !== "query" && key !== "limit")) throw new ApifyInputError("Expected { query, limit? }.");
      const query = typeof raw.query === "string" && !CONTROL.test(raw.query) ? raw.query.trim().replace(/ +/gu, " ") : null;
      if (query === null || query.length > APIFY_DISCOVERY_LIMITS.query_chars
        || query.split(" ").filter(Boolean).length > APIFY_DISCOVERY_LIMITS.query_words)
        throw new ApifyInputError(`A catalog query is up to ${APIFY_DISCOVERY_LIMITS.query_words} plain words and ${APIFY_DISCOVERY_LIMITS.query_chars} characters naming a platform or kind of data.`);
      // A catalog query names a platform or data type. Addresses and links are brain content, not catalog terms.
      if (/@|:\/\/|www\.|[0-9]{5,}/iu.test(query)) throw new ApifyInputError("A catalog query must not carry addresses, links or long numbers.");
      const limit = raw.limit === undefined ? APIFY_DISCOVERY_LIMITS.default_results : raw.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > APIFY_DISCOVERY_LIMITS.max_results)
        throw new ApifyInputError(`limit is an integer from 1 to ${APIFY_DISCOVERY_LIMITS.max_results}.`);

      const policy = policyGate();
      if (policy.discovery === "deny") throw refuse("policy_denied", "discovery_denied", "Apify catalog discovery is denied by apify.discovery in the governance policy.");
      routingGate(context, policy);
      await spendRequest(context, policy);
      const { binding } = await options.authority.admit(context.signal ? { signal: context.signal } : {});
      if (policy.discovery === "ask") {
        await approve(context, { toolName: "Apify catalog search",
          description: `Send the catalog query "${query}" to Apify. Finding an Actor does not let it run or spend.`,
          input: { query, limit, recipient: APIFY_MCP_ORIGIN, tools: ["search-actors"], account_id: binding.account_id } });
      }
      const result = await options.authority.catalog(binding, { tool: "search-actors", arguments: { keywords: query, limit, offset: 0 },
        ...(context.signal ? { signal: context.signal } : {}) });
      const cards = record(result.structured)?.actors;
      if (result.isError || !Array.isArray(cards))
        throw refuse("upstream_incompatible", "catalog_envelope", "Apify returned a catalog result this host does not recognise, so nothing was done with it.");
      const found: ApifyCandidateSummary[] = [];
      const fresh: Array<[string, Candidate]> = [];
      for (const raw of cards.slice(0, limit)) {
        const card = record(raw);
        if (!card || typeof card.id !== "string" || !ACTOR_ID.test(card.id) || typeof card.fullName !== "string" || !ACTOR_NAME.test(card.fullName)) continue;
        const ref = reference();
        fresh.push([ref, { principal_id: context.principal_id, session_id: context.session_id, binding, actor_id: card.id, actor: card.fullName, inspected: null }]);
        found.push({ candidate: ref, actor: card.fullName, title: clip(card.title, 200), description: clip(card.description, APIFY_DISCOVERY_LIMITS.description_chars),
          developer: clip(record(card.developer)?.username, 100), pricing_model: clip(record(card.pricing)?.model, 64), deprecated: card.isDeprecated === true });
      }
      await context.untrusted({ operation: "discover", detail: `apify search-actors: ${found.length} candidates` });
      state.addCandidates(fresh, context.session_id, APIFY_DISCOVERY_LIMITS.candidates_per_session);
      return { candidates: found, untrusted: true };
    },

    async inspect(context, input) {
      const raw = record(input);
      if (!raw || Object.keys(raw).some(key => key !== "candidate")) throw new ApifyInputError("Expected { candidate }.");
      const candidate = scoped(state.candidate, context, raw.candidate);
      const policy = policyGate();
      // Inspection sends the chosen identifier, so it follows discovery policy.
      if (policy.discovery === "deny") throw refuse("policy_denied", "discovery_denied", "Apify catalog discovery is denied by apify.discovery in the governance policy.");
      await options.authority.check(candidate.binding);
      routingGate(context, policy);
      // The Actor and build reads, and one catalog call.
      await spendRequest(context, policy, 3);
      if (policy.discovery === "ask") {
        await approve(context, { toolName: "Apify Actor inspection",
          description: `Ask Apify for the details of ${candidate.actor}. Inspecting an Actor does not let it run or spend.`,
          input: { actor: candidate.actor, actor_id: candidate.actor_id, recipient: [APIFY_API_ORIGIN, APIFY_MCP_ORIGIN], account_id: candidate.binding.account_id } });
      }
      const facts = await actorFacts(candidate.binding, candidate.actor_id, context);
      if (facts.actor !== candidate.actor)
        throw refuse("proposal_stale", "actor_substituted", "The Actor Apify describes now is not the one discovered under that name. Discover it again.");
      const details = await options.authority.catalog(candidate.binding, { tool: "fetch-actor-details",
        arguments: { actor: candidate.actor_id, output: { readme: true } }, ...(context.signal ? { signal: context.signal } : {}) });
      const readme = details.isError ? null : clip(details.text, APIFY_DISCOVERY_LIMITS.readme_chars);
      await context.untrusted({ operation: "inspect", detail: `apify actor ${candidate.actor_id}` });
      state.inspected(raw.candidate as string, facts);
      return { candidate: raw.candidate as string, ...facts, readme, untrusted: true };
    },

    async prepare(context, input) {
      const raw = record(input);
      if (!raw || Object.keys(raw).some(key => !["candidate", "input", "max_charge_usd"].includes(key))) throw new ApifyInputError("Expected { candidate, input, max_charge_usd }.");
      const candidate = scoped(state.candidate, context, raw.candidate);
      const cap = raw.max_charge_usd;
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0 || cap > APIFY_MAX_RUN_USD) throw new ApifyInputError("max_charge_usd is a positive amount in USD.");
      const actorInput = plainInput(raw.input);
      if (!candidate.inspected) throw refuse("proposal_stale", "not_inspected", "Inspect this Actor before preparing a run, so its build, schema and price can be reviewed.");
      const policy = policyGate();
      if (policy.actors === "deny") throw refuse("policy_denied", "actors_denied", "Running Apify Actors is denied by apify.actors in the governance policy.");
      await options.authority.check(candidate.binding);
      const bound = candidate.inspected;
      const unknown = Object.keys(actorInput).filter(key => !bound.input_fields.includes(key));
      if (unknown.length) throw new ApifyInputError(`Actor input names fields its schema does not define: ${unknown.sort().join(", ")}.`);
      const secrets = Object.keys(actorInput).filter(key => bound.secret_fields.includes(key));
      if (secrets.length) throw new ApifyInputError(`Actor input sets secret fields, which never leave the host this way: ${secrets.join(", ")}.`);
      const missing = bound.required_fields.filter(key => !(key in actorInput));
      if (missing.length) throw new ApifyInputError(`Actor input lacks required fields: ${missing.join(", ")}.`);
      const origins = targetOrigins(actorInput);
      const qualified = profiles.find(entry => entry.id === bound.profile_id) ?? null;
      if (qualified) {
        // The qualified profile validates the whole input against the exact build's schema now, not only at dispatch.
        try { profileInput(qualified, actorInput, policy.limits?.max_result_items ?? APIFY_LIMIT_BOUNDS.result_items); }
        catch (error) { if (error instanceof ApifyProfileInputError) throw new ApifyInputError(error.message); throw error; }
      }
      const minimum = bound.pricing.minimal_max_total_charge_usd;
      if (minimum !== null && cap < minimum)
        throw new ApifyInputError(`max_charge_usd is below this Actor's minimum run charge of $${minimum}.`);
      routingGate(context, policy);
      await spendRequest(context, policy, 2);
      const live = await actorFacts(candidate.binding, candidate.actor_id, context);
      const difference = changed(bound, live);
      if (difference) throw refuse("proposal_stale", difference, "The Actor changed since it was inspected. Inspect it again before preparing a run.");
      const proposal: Proposal = {
        principal_id: context.principal_id, session_id: context.session_id, turn_id: context.turn_id, binding: candidate.binding,
        policy_hash: policy.hash, facts: live, input: actorInput, input_sha256: sha256(canonicalJson(actorInput)), origins,
        max_charge_usd: cap, expires_at: now() + APIFY_DISCOVERY_LIMITS.proposal_ttl_ms, state: "prepared",
      };
      const ref = reference();
      state.addProposal(ref, proposal, now());
      return { proposal: ref, review: review(proposal), admission: policy.actors === "allow" && grantFor(policy, proposal) ? "grant" : "ask",
        expires_at: new Date(proposal.expires_at).toISOString() };
    },

    async admitRun(context, input, dispatch) {
      const raw = record(input);
      if (!raw || Object.keys(raw).some(key => key !== "proposal")) throw new ApifyInputError("Expected { proposal }.");
      const proposal = scoped(state.proposal, context, raw.proposal);
      const ref = raw.proposal as string;
      // One admission at a time, and each proposal admits at most once, across processes where the state is shared.
      if (proposal.turn_id !== context.turn_id || proposal.expires_at <= now() || proposal.state !== "prepared"
        || !state.transition(ref, "prepared", "admitting")) throw STALE_REFERENCE();
      let admitting = true;
      try {
        let policy = await revalidate(context, proposal);
        let grant = policy.actors === "allow" ? grantFor(policy, proposal) : null;
        if (!grant) {
          await approve(context, { toolName: "Apify Actor run",
            description: `Run ${proposal.facts.actor} build ${proposal.facts.build_number} once, with the input shown, charging at most $${proposal.max_charge_usd}. Approving does not allow any later run.`,
            input: review(proposal) as unknown as Record<string, unknown> });
          // Waiting for a person takes time: everything is read again.
          policy = await revalidate(context, proposal);
          grant = null;
        } else {
          // The grant matched under the policy just read; it must still be the one in force.
          policy = policyGate();
          if (policy.hash !== proposal.policy_hash || !grantFor(policy, proposal)) throw refuse("proposal_stale", "grant_changed", "The standing grant changed; prepare the run again.");
        }
        await options.authority.check(proposal.binding);
        admitting = false;
        if (!state.transition(ref, "admitting", "consumed")) throw STALE_REFERENCE();
        const facts = proposal.facts;
        const ticket: ApifyRunTicket = Object.freeze({
          proposal: raw.proposal as string, binding: proposal.binding, actor_id: facts.actor_id, build_id: facts.build_id,
          build_number: facts.build_number, profile_id: facts.profile_id!, schema_sha256: facts.schema_sha256, pricing_sha256: facts.pricing_sha256,
          input: deepFreeze(structuredClone(proposal.input)),
          input_sha256: proposal.input_sha256, origins: Object.freeze([...proposal.origins]), max_charge_usd: proposal.max_charge_usd,
          max_charge_microusd: Math.ceil(Math.round(proposal.max_charge_usd * 1e9) / 1e3),
          consent: grant ? { source: "grant" as const, expires_at: grant.expires_at } : { source: "approval" as const },
          principal_id: proposal.principal_id, session_id: proposal.session_id, turn_id: proposal.turn_id,
        });
        return await dispatch(ticket);
      } catch (error) {
        // An unrecordable refusal leaves the proposal admitting, which never admits again.
        if (admitting) try { state.transition(ref, "admitting", "refused"); } catch { /* the original refusal stands */ }
        throw error;
      }
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
