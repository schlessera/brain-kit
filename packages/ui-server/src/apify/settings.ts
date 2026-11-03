/**
 * The owner's Apify settings (#3163): what Settings › Accounts › Apify reads,
 * and how its controls change the policy.
 *
 * Reading combines the provider state (#3159), the effective `apify` policy
 * block and this brain's ledger totals (#3161). Nothing here contacts Apify
 * unless the owner asks for a refresh, and no field carries a token.
 *
 * Editing adds no policy writer. A control names one change; this module
 * turns it into the complete proposed `governance.md` and hands it to the
 * existing policy proposals (`createPolicyProposals`), the only privileged
 * policy writer. The owner then approves or declines that exact review, and
 * only an approval writes it, inside a `user` journal window like any other
 * user-history operation. The control itself never writes. Only the owner who
 * proposed a change can decide it; agents never reach these routes.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { checkGovernancePolicy, GOVERNANCE_POLICY_PATH } from "@schlessera/brain-common/internal/governance-policy";
import { liability, type ApifyLedger, type ApifyRuns, type ApifyStatus, type ApifyCoverageScope } from "@schlessera/brain-common/internal/apify";
import type { PolicyChangeReview } from "@schlessera/brain-ui-sdk/tool-contracts";
import type {
  ApifyGrantRead, ApifyPolicyChange, ApifyPolicyMode, ApifyPolicyProposalRead, ApifyPolicyRead, ApifySettingsRead, ApifySpendRead,
  ApifySpendScopeRead, ApifyUnresolvedRunRead,
} from "@schlessera/brain-ui-sdk/protocol";
import type { PolicyProposals, PolicyProposalTurn } from "../brain/policy-proposal.js";

/** A refusal with an HTTP status and a fixed message; it never carries policy text or a secret. */
export class ApifySettingsError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 422 | 503, readonly code: string, message: string) {
    super(message);
    this.name = "ApifySettingsError";
  }
}

const MODES = new Set<ApifyPolicyMode>(["deny", "ask", "allow"]);
const ID = /^[A-Za-z0-9]{1,64}$/u;
const BUILD = /^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$/u;
const PROFILE = /^[a-z0-9][a-z0-9._@-]{0,127}$/u;

/** One control's change, or null when the body is not exactly one known change. */
export function parseApifyPolicyChange(raw: unknown): ApifyPolicyChange | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length !== 1) return null;
  const [key, value] = entries[0]!;
  if (key === "enabled") return typeof value === "boolean" ? { enabled: value } : null;
  if (key === "discovery" || key === "actors")
    return typeof value === "string" && MODES.has(value as ApifyPolicyMode) ? { [key]: value as ApifyPolicyMode } as ApifyPolicyChange : null;
  if (key !== "remove_grant" || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const grant = value as Record<string, unknown>;
  if (Object.keys(grant).sort().join(",") !== "account_id,actor_id,build_number,expires_at,profile_id") return null;
  if (typeof grant.account_id !== "string" || !ID.test(grant.account_id) || typeof grant.actor_id !== "string" || !ID.test(grant.actor_id)
    || typeof grant.build_number !== "string" || !BUILD.test(grant.build_number) || typeof grant.profile_id !== "string" || !PROFILE.test(grant.profile_id)
    || typeof grant.expires_at !== "string" || !Number.isFinite(Date.parse(grant.expires_at))) return null;
  return { remove_grant: { account_id: grant.account_id, actor_id: grant.actor_id, build_number: grant.build_number,
    profile_id: grant.profile_id, expires_at: new Date(Date.parse(grant.expires_at)).toISOString() } };
}

const MODE_LABEL: Record<ApifyPolicyMode, string> = { deny: "Deny", ask: "Ask", allow: "Allow" };
/** The one-line rationale the review shows. Fixed words plus validated identifiers only. */
export function apifyChangeRationale(change: ApifyPolicyChange): string {
  if ("enabled" in change) return change.enabled ? "Settings: turn Apify on. This approves no search and no run." : "Settings: turn Apify off.";
  if ("discovery" in change) return `Settings: set Apify catalog search to ${MODE_LABEL[change.discovery]}.`;
  if ("actors" in change) return `Settings: set running Apify Actors to ${MODE_LABEL[change.actors]}.`;
  const grant = change.remove_grant;
  return `Settings: revoke the Apify grant for Actor ${grant.actor_id} build ${grant.build_number}. Future runs ask again.`;
}

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };
/** YAML's Date and the policy's ISO string name one instant; compare them as the string. */
function plain(value: unknown): Plain {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry)]));
  return value as Plain;
}
const same = (left: unknown, right: unknown) => JSON.stringify(plain(left)) === JSON.stringify(plain(right));

/** A number YAML reads back unchanged: no exponent form, which YAML 1.1 may read as a string. */
function yamlNumber(value: number): string {
  if (!Number.isFinite(value)) throw new ApifySettingsError(422, "unsupported_layout", "This policy has a value Settings cannot rewrite. Edit the policy file instead.");
  const text = String(value);
  return /e/iu.test(text) ? value.toFixed(12).replace(/\.?0+$/u, "") : text;
}
function yamlScalar(value: Plain): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return yamlNumber(value);
  if (typeof value === "string") return MODES.has(value as ApifyPolicyMode) ? value : JSON.stringify(value);
  throw new ApifySettingsError(422, "unsupported_layout", "This policy has a value Settings cannot rewrite. Edit the policy file instead.");
}
/** Block YAML for the `apify` value: mappings, lists of scalars or mappings, and scalars. */
function yamlBlock(key: string, value: Plain, indent: string): string[] {
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}${key}: []`];
    const lines = [`${indent}${key}:`];
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const inner = Object.entries(item).flatMap(([name, entry]) => yamlBlock(name, entry, `${indent}    `));
        if (!inner.length) { lines.push(`${indent}  - {}`); continue; }
        lines.push(`${indent}  - ${inner[0]!.slice(indent.length + 4)}`, ...inner.slice(1));
      } else if (Array.isArray(item)) throw new ApifySettingsError(422, "unsupported_layout", "This policy has a value Settings cannot rewrite. Edit the policy file instead.");
      else lines.push(`${indent}  - ${yamlScalar(item)}`);
    }
    return lines;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return [`${indent}${key}: {}`];
    return [`${indent}${key}:`, ...entries.flatMap(([name, entry]) => yamlBlock(name, entry, `${indent}  `))];
  }
  return [`${indent}${key}: ${yamlScalar(value)}`];
}

const FRONTMATTER = /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?\r?\n)?((?:---|\.\.\.)[ \t]*(?:\r?\n|$))/u;
const TOP_LEVEL = /^[^\s#]/u;

/**
 * The complete proposed policy with one change to its `apify` block. Every
 * other byte stays as it was: only the top-level `apify:` lines are replaced
 * (or added before the closing delimiter). The result is parsed back and must
 * equal the current data with exactly this change, or nothing is proposed.
 */
export function editApifyPolicy(current: string | null, change: ApifyPolicyChange): string {
  const unsupported = () => new ApifySettingsError(422, "unsupported_layout", "Settings cannot rewrite this policy's layout safely. Edit the policy file instead; nothing was proposed.");
  const text = current ?? "---\nschema_version: 1\n---\n";
  const match = FRONTMATTER.exec(text);
  if (!match) throw unsupported();
  let data: Record<string, unknown>;
  try { data = parseFrontmatter(text, { dataOnly: true }).data as Record<string, unknown>; }
  catch { throw new ApifySettingsError(422, "policy_invalid", "The policy file does not parse, so Settings cannot change it. Repair the policy file; nothing was proposed."); }
  const before = (data.apify && typeof data.apify === "object" && !Array.isArray(data.apify) ? plain(data.apify) : {}) as Record<string, Plain>;
  if (data.apify !== undefined && (typeof data.apify !== "object" || data.apify === null || Array.isArray(data.apify))) throw unsupported();
  const after: Record<string, Plain> = structuredClone(before);
  if ("enabled" in change) after.enabled = change.enabled;
  else if ("discovery" in change) after.discovery = change.discovery;
  else if ("actors" in change) after.actors = change.actors;
  else {
    const grants = Array.isArray(before.actor_grants) ? before.actor_grants as Array<Record<string, Plain>> : [];
    const target = change.remove_grant;
    const keep = grants.filter(grant => !(grant.account_id === target.account_id && grant.actor_id === target.actor_id
      && grant.build_number === target.build_number && grant.profile_id === target.profile_id
      && typeof grant.expires_at === "string" && Date.parse(grant.expires_at) === Date.parse(target.expires_at)));
    if (keep.length === grants.length) throw new ApifySettingsError(409, "stale", "That grant is no longer in the policy. Reload Settings; nothing was proposed.");
    after.actor_grants = keep;
  }
  if (same(before, after)) throw new ApifySettingsError(409, "unchanged", "The policy already says this. Nothing was proposed.");

  const open = match[1]!, body = match[2] ?? "", close = match[3]!;
  const newline = /\r\n/u.test(body || open) ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  const block = yamlBlock("apify", after, "");
  const start = lines.findIndex(line => /^apify[ \t]*:/u.test(line));
  if (start === -1) lines.push(...block);
  else {
    let end = start + 1;
    while (end < lines.length && !TOP_LEVEL.test(lines[end]!)) end++;
    // Blank lines and comments just before the next key belong to it, not to this block.
    while (end > start + 1 && /^\s*(?:#.*)?$/u.test(lines[end - 1]!)) end--;
    if (lines.slice(start + 1).some((line, index) => start + 1 + index >= end && /^apify[ \t]*:/u.test(line))) throw unsupported();
    lines.splice(start, end - start, ...block);
  }
  const next = `${open}${lines.join(newline)}${newline}${close}${text.slice(match[0].length)}`;
  let parsed: Record<string, unknown>;
  try { parsed = parseFrontmatter(next, { dataOnly: true }).data as Record<string, unknown>; } catch { throw unsupported(); }
  const keys = new Set([...Object.keys(data), ...Object.keys(parsed)]);
  for (const key of keys) {
    if (key === "apify") { if (!same(parsed.apify, after)) throw unsupported(); }
    else if (!same(parsed[key], data[key])) throw unsupported();
  }
  return next;
}

/** The effective policy facts Settings shows, with each grant's current applicability. */
export function readApifyPolicy(brainPath: string, status: Pick<ApifyStatus, "account" | "pending_account">, now = Date.now()): ApifyPolicyRead {
  const checked = checkGovernancePolicy(brainPath);
  const apify = checked.effective.apify, budgets = checked.effective.budgets;
  // The token's account: a changed account is the one the token belongs to now.
  const current = status.pending_account?.id ?? status.account?.id ?? null;
  const grants: ApifyGrantRead[] = apify.actor_grants.map(grant => ({
    account_id: grant.account_id, actor_id: grant.actor_id, build_number: grant.build_number, profile_id: grant.profile_id,
    origins: [...grant.origins], expires_at: grant.expires_at, max_run_usd: grant.max_run_usd,
    status: Date.parse(grant.expires_at) <= now ? "expired" : current !== null && grant.account_id !== current ? "other_account" : "active",
  }));
  return { path: GOVERNANCE_POLICY_PATH, hash: checked.content_hash, valid: checked.ok, enabled: checked.ok && apify.enabled === true,
    discovery: apify.discovery, actors: apify.actors, grants, limits: apify.limits ? { ...apify.limits } : null,
    budgets: { turn_usd: budgets.turn.block_usd, session_usd: budgets.session.block_usd, day_usd: budgets.day.block_usd } };
}

const usd = (micro: number) => micro / 1_000_000;
const scopeRead = (scope: ApifyCoverageScope): ApifySpendScopeRead => ({ ...scope });

export interface ApifySpendSource {
  ledgerPath: string;
  ledger: () => ApifyLedger;
  runs: Pick<ApifyRuns, "coverage">;
  brain_id: string;
  now?: () => number;
}

/** This brain's Apify spend from its ledger. A missing ledger is `absent`; a failed read is `unavailable`, never zero. */
export function readApifySpend(source: ApifySpendSource, account_id: string | null, scope?: { session_id: string; turn_id: string }): ApifySpendRead {
  const observed_at = new Date((source.now ?? Date.now)()).toISOString();
  if (!existsSync(source.ledgerPath)) return { ledger: "absent", observed_at, coverage: null, day: null, brain_day: null, ...(scope ? { turn: null } : {}), unresolved: [] };
  try {
    const coverage = source.runs.coverage({ account_id: account_id ?? "", session_id: scope?.session_id ?? "", turn_id: scope?.turn_id ?? "" });
    const by = (name: ApifyCoverageScope["scope"]) => coverage.scopes.find(entry => entry.scope === name) ?? null;
    const rows = source.ledger().unsettled(source.brain_id).filter(row => !scope || (row.turn_id === scope.turn_id && row.session_id === scope.session_id));
    const unresolved: ApifyUnresolvedRunRead[] = rows.slice(0, 50).map(row => ({
      key: createHash("sha256").update(row.handle).digest("hex").slice(0, 16),
      actor_id: row.actor_id, build_number: row.build_number, state: row.state, abort: row.abort_state, cost_basis: row.cost_basis,
      reserved_usd: usd(row.reserved_micro), charged_usd: row.charged_micro === null ? null : usd(row.charged_micro),
      liability_usd: usd(liability(row)),
      remote_outcome_unknown: row.state === "unknown", session_id: row.session_id, turn_id: row.turn_id,
      started_at: new Date(row.dispatched_at ?? row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(),
    }));
    const day = account_id ? by("day") : null, brainDay = by("brain_day");
    return { ledger: "read", observed_at, coverage: coverage.coverage, day: day && scopeRead(day), brain_day: brainDay && scopeRead(brainDay),
      ...(scope ? { turn: by("turn") && scopeRead(by("turn")!) } : {}), unresolved };
  } catch {
    return { ledger: "unavailable", observed_at, coverage: null, day: null, brain_day: null, ...(scope ? { turn: null } : {}), unresolved: [] };
  }
}

export function apifySettingsRead(status: ApifyStatus, policy: ApifyPolicyRead, spend: ApifySpendRead): ApifySettingsRead {
  return { state: status.state, reason: status.reason, account: status.account, pending_account: status.pending_account,
    checked_at: status.checked_at, policy, spend };
}

/** The `user` journal window a settings edit is written in, as for any user-history operation. */
export interface ApifySettingsJournal {
  begin(turnId: string, metadata: { sessionId: null; actor: "user"; model: null; profile: "strict"; policyHash: string | null }, stop: (error: Error) => void, signal?: AbortSignal): Promise<void>;
  finish(turnId: string): Promise<void>;
}

export interface ApifyPolicyEditsOptions {
  root: string;
  proposals: PolicyProposals;
  journal: ApifySettingsJournal;
  /** The live human-owner check; an edit loses its approval the moment it fails. */
  authorized(principalId: string): boolean;
  /** How long an unanswered review stays open before it is declined. */
  timeoutMs?: number;
}

/** At most this many unanswered Settings reviews per owner. */
const MAX_PENDING = 4;

export function createApifyPolicyEdits(options: ApifyPolicyEditsOptions) {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const pending = new Map<string, { principalId: string; answer(approve: boolean): void; done: Promise<PolicyChangeReview> }>();
  const read = (): string | null => {
    try { return readFileSync(join(options.root, GOVERNANCE_POLICY_PATH), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  return {
    /** Propose one change against the policy version the owner saw; resolves once its review is pending. */
    async propose(principalId: string, change: ApifyPolicyChange, baseHash: string | null): Promise<ApifyPolicyProposalRead> {
      if (!options.authorized(principalId)) throw new ApifySettingsError(409, "not_authorized", "This owner no longer has current authority. Nothing was proposed.");
      if ([...pending.values()].filter(entry => entry.principalId === principalId).length >= MAX_PENDING)
        throw new ApifySettingsError(409, "busy", "Answer the open policy reviews first. Nothing was proposed.");
      const current = read();
      const hash = current === null ? null : createHash("sha256").update(current, "utf8").digest("hex");
      if (hash !== baseHash) throw new ApifySettingsError(409, "stale", "The policy changed since Settings read it. Reload Settings; nothing was proposed.");
      const content = editApifyPolicy(current, change);
      const turnId = `settings-apify-${randomUUID()}`, requestId = `apify-${randomUUID()}`, key = `${turnId}:${requestId}`;
      const controller = new AbortController();
      let answer!: (approve: boolean) => void;
      const decision = new Promise<boolean>(resolve => { answer = resolve; });
      let shown!: (review: PolicyChangeReview) => void, failed!: (error: unknown) => void;
      const first = new Promise<PolicyChangeReview>((resolve, reject) => { shown = resolve; failed = reject; });
      let journaled = false;
      const timer = setTimeout(() => answer(false), timeoutMs);
      timer.unref?.();
      const turn: PolicyProposalTurn = {
        principalId, turnId, sessionId: () => null, signal: controller.signal,
        isAuthorized: () => options.authorized(principalId), isAvailable: () => true,
        approve: async review => {
          shown(structuredClone(review));
          if (!await decision) return false;
          // Approved: the write happens inside a user journal window, like a revert or a removal.
          await options.journal.begin(turnId, { sessionId: null, actor: "user", model: null, profile: "strict", policyHash: review.baseHash },
            () => controller.abort(), controller.signal);
          journaled = true;
          return true;
        },
        emit: () => undefined,
      };
      const done = options.proposals.propose(turn, requestId, { content, rationale: apifyChangeRationale(change) }).finally(async () => {
        clearTimeout(timer);
        pending.delete(key);
        if (journaled) await options.journal.finish(turnId).catch(() => undefined);
      });
      done.then(review => shown(review), failed);
      pending.set(key, { principalId, answer, done });
      try { return { turn_id: turnId, request_id: requestId, review: await first }; }
      catch (error) {
        answer(false);
        throw error instanceof ApifySettingsError ? error : new ApifySettingsError(422, "policy_invalid",
          `The proposed policy did not validate, so nothing was proposed: ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}`);
      }
    },
    /**
     * The owner's one answer to a review they proposed. A repeated or late
     * answer reads the recorded outcome; it never writes again.
     */
    async decide(principalId: string, turnId: string, requestId: string, approve: boolean): Promise<PolicyChangeReview> {
      const entry = pending.get(`${turnId}:${requestId}`);
      if (entry && entry.principalId === principalId) {
        entry.answer(approve);
        return structuredClone(await entry.done);
      }
      const recorded = options.proposals.read(principalId, turnId, requestId);
      if (!recorded) throw new ApifySettingsError(404, "not_found", "No policy review is open for this request.");
      return recorded;
    },
    /** Decline every open review: shutdown or test teardown. */
    close() { for (const entry of pending.values()) entry.answer(false); },
  };
}
export type ApifyPolicyEdits = ReturnType<typeof createApifyPolicyEdits>;
