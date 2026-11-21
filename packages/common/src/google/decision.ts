/**
 * The Google decision function (plan §6, #4204): one policy block, one
 * validated call and the facts only the host knows in, one decision out.
 *
 * Pure and deterministic. It reads no clock, no store and no network: the
 * host does the work of §6 steps 1 to 3 that needs I/O (the transport pin,
 * the connected account, strict input, pre-reads), looks up what it keeps
 * (remembered approvals, session allowances, the turn's card-less count,
 * the session's taint, the G2 routing verdict) and passes the results here.
 * This function then decides in the plan's order:
 *
 * 1. availability: the owner, an enabled block naming an account, the
 *    operation's service listed;
 * 2. input: the call validates against its tool's strict schema and names
 *    its operation;
 * 4. effect: the call's class, computed here by `classifyGoogleCall`;
 * 5. mode: the override or the class mode, capped by the class;
 * 6. entities: hidden labels on every target, then send recipients;
 * 7. limits: ids per call, then the turn's card-less reversible items;
 * 8. standing admission: policy `allow` or a remembered approval while
 *    untainted, only a session allowance while tainted, in standalone only
 *    `standalone.reversible: allow` with mode `allow`;
 * 9. card need and posture: voice and standalone never show a card,
 *    autonomous turns refuse;
 * 10. routing: a read or a card-less write needs the G2 verdict `allowed`;
 * 11. card: which standing choice the card may offer.
 *
 * Steps 12 and 13 (record, execute, provenance) belong to the host.
 *
 * Every fact the host omits, or supplies in a shape this function does not
 * read, counts against the call: an unknown taint is tainted, an unknown
 * count stops standing admission, unknown recipients or target labels
 * refuse, an unknown routing verdict is unproven, an unknown posture or
 * principal refuses. Nothing unknown ever admits.
 */
import { matchGoogleAllowList } from "./address.js";
import {
  escalateGoogleEffect, GOOGLE_EFFECT_CLASSES, GOOGLE_INPUT_SCHEMAS, GOOGLE_OPERATION_SPECS, GOOGLE_SERVICES,
  gmailModifyActions, googleOperationOf, isGoogleOperation,
  type GmailDraftInput, type GmailModifyInput, type GoogleEffectClass, type GoogleError, type GoogleErrorCode,
  type GoogleOperation, type GoogleToolName,
} from "./catalog.js";
import { classifyGoogleCall, type GoogleCallFacts } from "./classify.js";
import {
  effectiveGoogleMode, GOOGLE_ACCOUNT_ALIAS_PATTERN, GOOGLE_POLICY_BOUNDS,
  type GoogleModeSource, type GooglePolicy, type GooglePolicyMode,
} from "./policy.js";

/** Who is calling: the brain's owner, another principal, or nobody the host could establish. */
export const GOOGLE_PRINCIPAL_KINDS = ["owner", "not_owner", "none"] as const;
export type GooglePrincipalKind = typeof GOOGLE_PRINCIPAL_KINDS[number];

/** The surface a call arrives on (plan §10). */
export const GOOGLE_POSTURES = ["interactive", "voice", "autonomous", "standalone"] as const;
export type GooglePosture = typeof GOOGLE_POSTURES[number];

/** The G2 routing verdict for recipient `google`, as the host's provider routing computes it. */
export const GOOGLE_ROUTING_VERDICTS = ["allowed", "recipient_restricted", "recipient_unproven"] as const;
export type GoogleRoutingVerdict = typeof GOOGLE_ROUTING_VERDICTS[number];

/**
 * The bounds of a session allowance (plan §7): at most 24 hours, never past
 * the host process that granted it, at most 100 items in all. The host keeps
 * the clock and the store (#4212) and passes only live allowances; one that
 * claims more than 100 remaining items is not read as live.
 */
export const GOOGLE_SESSION_ALLOWANCE_LIMITS = Object.freeze({ items: 100, lifetimeMs: 24 * 60 * 60 * 1000 });

/**
 * A live remembered approval ("Allow always") the host found for this
 * principal, brain and account identity: one operation and one approval
 * entity (`archive`, `label:<id>`, `drafts`, …).
 */
export interface GoogleStandingApproval {
  operation: GoogleOperation;
  entity: string;
}

/** A live session allowance ("Allow for the rest of this session") and the items it may still admit. */
export interface GoogleSessionAllowance extends GoogleStandingApproval {
  remaining_items: number;
}

/** What only the host knows about this call. Every field the host omits counts against the call. */
export interface GoogleDecisionFacts {
  principal: GooglePrincipalKind;
  posture: GooglePosture;
  /** Whether the session is tainted. Unknown is tainted. A standalone call has no session and no taint. */
  tainted?: boolean;
  /** Live remembered approvals for this principal, brain and account identity. Read only while untainted. */
  remembered_approvals?: readonly GoogleStandingApproval[];
  /** Live session allowances for this session. Read only while tainted. */
  session_allowances?: readonly GoogleSessionAllowance[];
  /** Whether this turn can show the owner an approval card. Unknown is no. */
  card_available?: boolean;
  /** The G2 routing verdict for recipient `google`. Unknown is `recipient_unproven`. */
  routing?: GoogleRoutingVerdict;
  /** Card-less reversible items this turn has already used. Unknown stops standing admission. */
  turn_reversible_items?: number;
  /**
   * The items a modify or trash acts on once the host resolved its targets:
   * the message ids a thread target resolves to. Required for a thread
   * target; never lowers the count of the ids given.
   */
  items?: number;
  /** For a send: every To, Cc and Bcc mailbox the host parsed from the draft's raw headers, never from model input. */
  recipients?: readonly string[];
  /** The account's primary address and verified send-as aliases, resolved by the host: what `self` matches. */
  self_addresses?: readonly string[];
  /**
   * Every label id on every target the call names: each modified or trashed
   * message, every message of a thread read, the message replied to or
   * quoted and its thread, the draft. Needed whenever `hidden_labels` is not
   * empty and the call has a target.
   */
  target_label_ids?: readonly string[];
}

/**
 * The call: its operation and input as validated by `parseGoogleToolCall`
 * (they are validated again here), the classification facts from the host's
 * pre-reads, and optionally the class the host computed itself, which can
 * only raise the class computed here.
 */
export interface GoogleDecisionCall {
  operation: string;
  input: unknown;
  facts?: GoogleCallFacts;
  effect?: GoogleEffectClass;
}

/** The §6 step that refused. */
export type GoogleDecisionStep = 1 | 2 | 5 | 6 | 7 | 9 | 10;

/** Why a call was refused. The model sees `error`; `cause` is the host's, for its record. */
export const GOOGLE_REFUSAL_CAUSES = [
  // 1. availability
  "no_principal", "not_owner", "not_enabled", "policy_invalid", "no_account", "service_not_enabled", "decision_error",
  // 2. input
  "unknown_operation", "schema", "operation_mismatch",
  // 5. mode
  "class_denied", "operation_denied",
  // 6. entities
  "target_labels_unknown", "hidden_label", "recipients_unknown", "send_to_empty", "no_recipients", "too_many_recipients",
  "recipient_not_allowed",
  // 7. limits
  "item_count_unknown", "items_per_call",
  // 9. card need and posture
  "autonomous_turn", "posture_unknown", "voice_posture", "no_approval_surface", "standalone_irreversible",
  "standalone_not_allowed", "standalone_needs_card",
  // 10. routing
  "recipient_restricted", "recipient_unproven",
] as const;
export type GoogleRefusalCause = typeof GOOGLE_REFUSAL_CAUSES[number];

/** What admitted a call without a card. */
export type GoogleAdmission = "policy" | "remembered_approval" | "session_allowance";

/** Why a call needs a card. */
export type GoogleCardCause = "irreversible" | "mode_ask" | "tainted" | "turn_limit";

/** The standing choices a card may offer beside allowing once. */
export interface GoogleCardOffers {
  /** "Allow always for <entity>": a reversible call in an untainted session. */
  allow_always: boolean;
  /** "Allow for the rest of this session": a reversible call in a tainted session. */
  allow_for_session: boolean;
}

interface GoogleDecisionDetail {
  /** The operation, or null when it is not one. */
  operation: GoogleOperation | null;
  /** The computed class; `irreversible` when it could not be computed. */
  effect: GoogleEffectClass;
  /** The effective mode, once step 5 ran. */
  mode: GooglePolicyMode | null;
  mode_source: GoogleModeSource | null;
  /** The items the call acts on (0 for a read), or null when unknown. */
  items: number | null;
  /** The approval entities the call touches, sorted; empty when nothing can be remembered. */
  entities: string[];
  /** Whether the session counts as tainted. Always false standalone. */
  tainted: boolean;
}

export type GoogleDecision =
  | (GoogleDecisionDetail & { outcome: "refused"; step: GoogleDecisionStep; cause: GoogleRefusalCause; error: GoogleError })
  | (GoogleDecisionDetail & { outcome: "admitted"; admission: GoogleAdmission })
  | (GoogleDecisionDetail & { outcome: "needs_card"; cause: GoogleCardCause; offers: GoogleCardOffers });

// ------------------------------------------------------------------ refusals

const REFUSALS: Record<GoogleRefusalCause, { code: GoogleErrorCode; message: (detail: GoogleDecisionDetail) => string }> = {
  no_principal: { code: "policy_denied", message: () => "The Google tools serve the brain's owner, and this call has no principal the host could establish." },
  not_owner: { code: "policy_denied", message: () => "The Google tools serve the brain's owner only." },
  not_enabled: { code: "unavailable", message: () => "Google is not enabled: the governance policy needs a google block with enabled: true." },
  policy_invalid: { code: "unavailable", message: () => "Google is unavailable because its policy block could not be read." },
  no_account: { code: "unavailable", message: () => "Google is unavailable: the policy's google block names no account." },
  service_not_enabled: { code: "unavailable", message: detail => `${serviceName(detail)} is not enabled: the policy's google.services does not list it.` },
  decision_error: { code: "unavailable", message: () => "The host could not decide this Google call, so nothing was sent." },
  unknown_operation: { code: "invalid_input", message: () => "This is not a Google operation." },
  schema: { code: "invalid_input", message: () => "The input was refused by the tool's schema." },
  operation_mismatch: { code: "invalid_input", message: () => "The input names a different operation than the call." },
  class_denied: { code: "policy_denied", message: detail => `The governance policy denies ${detail.effect} Google calls (google.modes.${detail.effect}: deny); nothing was sent.` },
  operation_denied: { code: "policy_denied", message: detail => `The governance policy denies ${detail.operation} (google.operations); nothing was sent.` },
  target_labels_unknown: { code: "policy_denied", message: () => "The host could not establish the labels of what this call targets, so nothing was sent." },
  hidden_label: { code: "not_found", message: () => GOOGLE_NOT_FOUND_MESSAGE },
  recipients_unknown: { code: "policy_denied", message: () => "The host could not read this draft's recipients, so nothing was sent." },
  send_to_empty: { code: "policy_denied", message: () => "No send is allowed: the policy's google.gmail.send_to is empty. Nothing was sent." },
  no_recipients: { code: "policy_denied", message: () => "This draft has no recipient; nothing was sent." },
  too_many_recipients: { code: "policy_denied", message: () => "This draft has more recipients than the policy's google.gmail.max_recipients allows; nothing was sent." },
  recipient_not_allowed: { code: "policy_denied", message: () => "A recipient of this draft does not match the policy's google.gmail.send_to; nothing was sent." },
  item_count_unknown: { code: "policy_denied", message: () => "The host could not count the messages this call acts on, so nothing was changed." },
  items_per_call: { code: "policy_denied", message: () => "This call acts on more messages than the policy's google.limits.items_per_call allows; split it. Nothing was changed." },
  autonomous_turn: { code: "policy_denied", message: () => "Google is not available to unattended turns." },
  posture_unknown: { code: "policy_denied", message: () => "The host could not establish how this turn runs, so nothing was sent." },
  voice_posture: { code: "approval_declined", message: () => "Voice cannot approve a Google call. Nothing was sent; ask for it in a typed conversation." },
  no_approval_surface: { code: "policy_denied", message: () => "This call needs the owner's approval and this turn cannot show it; nothing was sent." },
  standalone_irreversible: { code: "policy_denied", message: () => "brain google never makes an irreversible Google call; use a hosted conversation, where it asks first." },
  standalone_not_allowed: { code: "policy_denied", message: () => "brain google may make this change only under the policy's google.standalone.reversible: allow." },
  standalone_needs_card: { code: "policy_denied", message: () => "This change needs the owner's approval, and brain google cannot ask for it; its policy mode must be allow." },
  recipient_restricted: { code: "policy_denied", message: () => "This conversation has shown content the governance policy keeps from Google, so Google was sent nothing." },
  recipient_unproven: { code: "policy_denied", message: () => "The host could not establish that this conversation's content may go to Google, so Google was sent nothing." },
};

/**
 * What a hidden target answers: exactly what a missing one does, so a refusal
 * does not tell the model a hidden thread exists. The host answers a real
 * miss with the same error.
 */
export const GOOGLE_NOT_FOUND_MESSAGE = "No such Gmail thread, message or draft was found.";

const SERVICE_NAMES: Record<string, string> = { gmail: "Gmail" };
const serviceName = (detail: GoogleDecisionDetail): string =>
  (detail.operation && SERVICE_NAMES[GOOGLE_OPERATION_SPECS[detail.operation].service]) ?? "This Google service";

const STEP: Record<GoogleRefusalCause, GoogleDecisionStep> = {
  no_principal: 1, not_owner: 1, not_enabled: 1, policy_invalid: 1, no_account: 1, service_not_enabled: 1, decision_error: 1,
  unknown_operation: 2, schema: 2, operation_mismatch: 2,
  class_denied: 5, operation_denied: 5,
  target_labels_unknown: 6, hidden_label: 6, recipients_unknown: 6, send_to_empty: 6, no_recipients: 6, too_many_recipients: 6,
  recipient_not_allowed: 6,
  item_count_unknown: 7, items_per_call: 7,
  autonomous_turn: 9, posture_unknown: 9, voice_posture: 9, no_approval_surface: 9, standalone_irreversible: 9,
  standalone_not_allowed: 9, standalone_needs_card: 9,
  recipient_restricted: 10, recipient_unproven: 10,
};

function refused(cause: GoogleRefusalCause, detail: GoogleDecisionDetail): GoogleDecision {
  const { code, message } = REFUSALS[cause];
  // A hidden target reads as a plain miss: no reason names why.
  const reason = cause === "hidden_label" ? null : cause;
  return { ...detail, outcome: "refused", step: STEP[cause], cause, error: { code, reason, message: message(detail) } };
}

// ------------------------------------------------------------------ fact readers

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const isStrings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => (values as readonly unknown[]).includes(value);

/**
 * Whether a resolved block can be read at all: every field present with a
 * shape the decision understands. Values the schema would also bound (modes,
 * limits) are checked here too, so a block built by hand cannot widen what
 * the schema allows. A block that fails disables Google for the call.
 */
function readable(policy: unknown): policy is GooglePolicy {
  if (!isRecord(policy)) return false;
  const { enabled, account, services, modes, operations, gmail, standalone, limits } = policy;
  return typeof enabled === "boolean"
    && (account === null || (typeof account === "string" && GOOGLE_ACCOUNT_ALIAS_PATTERN.test(account) && account.toLowerCase() !== "auto"))
    && isStrings(services) && services.every(service => oneOf(GOOGLE_SERVICES, service))
    && isRecord(modes) && isRecord(operations) && Object.keys(operations).every(isGoogleOperation)
    && isRecord(gmail) && isStrings(gmail.send_to) && isCount(gmail.max_recipients, GOOGLE_POLICY_BOUNDS.maxRecipients) && isStrings(gmail.hidden_labels)
    && isRecord(standalone)
    && isRecord(limits) && isCount(limits.items_per_call, GOOGLE_POLICY_BOUNDS.itemsPerCall)
    && isCount(limits.reversible_per_turn, GOOGLE_POLICY_BOUNDS.reversiblePerTurn);
}

/** Operations whose input names ids, which `limits.items_per_call` bounds. */
const ID_OPERATIONS: ReadonlySet<GoogleOperation> = new Set(["gmail.modify", "gmail.trash"]);

/**
 * The items a call acts on: the ids of a modify or trash (a thread target
 * counts the messages the host resolved, never fewer than the ids given;
 * null when the host gave no count), one for any other write, none for a
 * read.
 */
function itemsOf(operation: GoogleOperation, input: Record<string, unknown>, resolved: unknown): number | null {
  if (ID_OPERATIONS.has(operation)) {
    const { message_ids, thread_ids } = input as Pick<GmailModifyInput, "message_ids" | "thread_ids">;
    const given = (message_ids ?? thread_ids ?? []).length;
    const count = isCount(resolved) ? resolved : null;
    if (thread_ids !== undefined) return count === null ? null : Math.max(count, given);
    return Math.max(given, count ?? 0);
  }
  return GOOGLE_OPERATION_SPECS[operation].base === "read" ? 0 : 1;
}

/** The approval entities a call touches (plan §4): modify actions, `drafts`, or none. */
function entitiesOf(operation: GoogleOperation, input: Record<string, unknown>): string[] {
  switch (GOOGLE_OPERATION_SPECS[operation].entity) {
    case "action": return gmailModifyActions(input as GmailModifyInput);
    case "drafts": return ["drafts"];
    default: return [];
  }
}

/** Whether a call names a thread, message or draft that `hidden_labels` can hide. A search's hits are filtered by the host instead. */
function hasTarget(operation: GoogleOperation, input: Record<string, unknown>): boolean {
  if (operation === "gmail.search" || operation === "gmail.labels.list") return false;
  if (operation === "gmail.draft.save") {
    const draft = input as GmailDraftInput;
    return draft.action !== "create" || draft.quote_message_id !== undefined;
  }
  return true;
}

/** Every entity has a matching standing record, and there is at least one entity. */
function covered<T extends GoogleStandingApproval>(records: unknown, operation: GoogleOperation, entities: readonly string[], usable: (record: T) => boolean): boolean {
  if (!Array.isArray(records) || entities.length === 0) return false;
  return entities.every(entity => records.some(record => isRecord(record) && record.operation === operation && record.entity === entity && usable(record as unknown as T)));
}

// ------------------------------------------------------------------ the decision

/**
 * Decides one Google call (plan §6 steps 1, 2 and 4 to 11) from the
 * resolved `google` policy block (`effective.google`; absent, Google is
 * disabled), the call, and the host's facts. Never throws: a failure to
 * decide refuses.
 */
export function decideGoogleCall(policy: GooglePolicy | null | undefined, call: GoogleDecisionCall, facts: GoogleDecisionFacts): GoogleDecision {
  const detail: GoogleDecisionDetail = { operation: null, effect: "irreversible", mode: null, mode_source: null, items: null, entities: [], tainted: true };
  try {
    return decide(policy, call, facts ?? ({} as GoogleDecisionFacts), detail);
  } catch {
    return refused("decision_error", detail);
  }
}

function decide(policy: GooglePolicy | null | undefined, call: GoogleDecisionCall, facts: GoogleDecisionFacts, detail: GoogleDecisionDetail): GoogleDecision {
  const posture = facts.posture;
  const standalone = posture === "standalone";
  // A standalone call has no session, so no taint; in a session, unknown taint is tainted.
  detail.tainted = standalone ? false : facts.tainted !== false;

  // 1. Availability. The owner, an enabled block, an account; the transport
  // pin and the connected account are the host's to check before this.
  if (facts.principal !== "owner") return refused(facts.principal === "not_owner" ? "not_owner" : "no_principal", detail);
  if (policy === null || policy === undefined) return refused("not_enabled", detail);
  if (!readable(policy)) return refused("policy_invalid", detail);
  if (policy.enabled !== true) return refused("not_enabled", detail);
  if (policy.account === null) return refused("no_account", detail);
  // The service check needs a known operation, so an unknown id is refused as input here.
  if (!isGoogleOperation(call.operation)) return refused("unknown_operation", detail);
  const operation = call.operation;
  detail.operation = operation;
  const spec = GOOGLE_OPERATION_SPECS[operation];
  if (!policy.services.includes(spec.service)) return refused("service_not_enabled", detail);

  // 2. Input, validated again against the operation's own tool schema.
  const parsed = GOOGLE_INPUT_SCHEMAS[spec.tool as GoogleToolName].safeParse(call.input);
  if (!parsed.success) return refused("schema", detail);
  const input = parsed.data as Record<string, unknown>;
  if (googleOperationOf(spec.tool, input as never) !== operation) return refused("operation_mismatch", detail);
  detail.entities = entitiesOf(operation, input);
  detail.items = itemsOf(operation, input, facts.items);

  // 4. Effect. A standalone call has no snapshot store, so no host fact may
  // relax an escalation there (a draft update escalates, plan §10). A class
  // the host supplies can only raise this one; one it misnames is irreversible.
  let effect = classifyGoogleCall(operation, call.input, standalone ? {} : call.facts ?? {});
  if (call.effect !== undefined) effect = escalateGoogleEffect(effect, oneOf(GOOGLE_EFFECT_CLASSES, call.effect) ? call.effect : "irreversible");
  detail.effect = effect;

  // 5. Mode: the override or the class mode, capped by the computed class. Deny refuses before any card.
  const { mode, source } = effectiveGoogleMode(policy, operation, effect);
  detail.mode = mode;
  detail.mode_source = source;
  if (mode === "deny") return refused(source === "operation" ? "operation_denied" : "class_denied", detail);

  // 6. Entities. Hidden labels first, so nothing about a hidden target
  // (its recipients included) is revealed before it reads as missing.
  const hidden = policy.gmail.hidden_labels;
  if (hidden.length > 0 && hasTarget(operation, input)) {
    if (!isStrings(facts.target_label_ids)) return refused("target_labels_unknown", detail);
    if (facts.target_label_ids.some(label => hidden.includes(label))) return refused("hidden_label", detail);
  }
  if (operation === "gmail.draft.send") {
    const recipients = facts.recipients;
    if (!isStrings(recipients)) return refused("recipients_unknown", detail);
    // An empty allow-list opens nothing.
    if (policy.gmail.send_to.length === 0) return refused("send_to_empty", detail);
    if (recipients.length === 0) return refused("no_recipients", detail);
    if (recipients.length > policy.gmail.max_recipients) return refused("too_many_recipients", detail);
    // `self` matches only the addresses the host resolved; none supplied, it matches nothing.
    const self = isStrings(facts.self_addresses) ? facts.self_addresses : [];
    if (matchGoogleAllowList(recipients, policy.gmail.send_to, self).some(match => match.entry === null)) return refused("recipient_not_allowed", detail);
  }

  // 7. Limits. Ids above items_per_call refuse; card-less reversible items
  // above reversible_per_turn stop standing admission, so the call asks.
  const items = detail.items;
  if (ID_OPERATIONS.has(operation)) {
    if (items === null) return refused("item_count_unknown", detail);
    if (items > policy.limits.items_per_call) return refused("items_per_call", detail);
  }
  const used = facts.turn_reversible_items;
  const withinTurn = items !== null && isCount(used) && used + items <= policy.limits.reversible_per_turn;

  // 8. Standing admission. Reads run on their mode; irreversible calls always ask.
  let admission: GoogleAdmission | null = null;
  let cardCause: GoogleCardCause = "irreversible";
  if (effect === "read") {
    admission = "policy";
  } else if (effect === "reversible") {
    if (!withinTurn) cardCause = "turn_limit";
    else if (standalone) {
      // No session: no taint, no remembered approval, no allowance; only the standalone key with mode allow.
      if (mode === "allow" && policy.standalone.reversible === "allow") admission = "policy";
      else cardCause = "mode_ask";
    } else if (detail.tainted) {
      // G6: policy allow and remembered approvals do not apply; only a session allowance with room for these items.
      const room = (record: GoogleSessionAllowance) =>
        isCount(record.remaining_items, GOOGLE_SESSION_ALLOWANCE_LIMITS.items) && items !== null && record.remaining_items >= items;
      if (covered(facts.session_allowances, operation, detail.entities, room)) admission = "session_allowance";
      else cardCause = "tainted";
    } else if (mode === "allow") {
      admission = "policy";
    } else if (covered(facts.remembered_approvals, operation, detail.entities, () => true)) {
      admission = "remembered_approval";
    } else {
      cardCause = "mode_ask";
    }
  }

  // 9. Card need and posture. Voice never grants but runs what standing
  // admission admitted; a terminal never shows a card; unattended turns refuse.
  switch (posture) {
    case "interactive":
      if (!admission && facts.card_available !== true) return refused("no_approval_surface", detail);
      break;
    case "voice":
      if (!admission) return refused("voice_posture", detail);
      break;
    case "standalone":
      if (!admission) {
        if (effect === "irreversible") return refused("standalone_irreversible", detail);
        return refused(policy.standalone.reversible === "allow" ? "standalone_needs_card" : "standalone_not_allowed", detail);
      }
      break;
    case "autonomous":
      return refused("autonomous_turn", detail);
    default:
      return refused("posture_unknown", detail);
  }

  // 10. Routing. A read or a card-less write sends model-chosen text to
  // Google; a write whose exact payload is on a card is gated by the card.
  if (admission) {
    if (facts.routing === "recipient_restricted") return refused("recipient_restricted", detail);
    if (facts.routing !== "allowed") return refused("recipient_unproven", detail);
    return { ...detail, outcome: "admitted", admission };
  }

  // 11. The card. A reversible card offers one standing choice for its
  // entities, by taint; an irreversible card offers none.
  const rememberable = effect === "reversible" && detail.entities.length > 0;
  return { ...detail, outcome: "needs_card", cause: cardCause,
    offers: { allow_always: rememberable && !detail.tainted, allow_for_session: rememberable && detail.tainted } };
}
