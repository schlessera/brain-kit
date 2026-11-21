/**
 * The effect classifier (plan §1, §4, §6 step 4): the class of one call,
 * computed from the validated input and facts only the host can read.
 *
 * - The base class comes from the catalog.
 * - Escalations only raise it. Nothing lowers a class: the result is the
 *   highest of the base and every escalation, so a fact can make a call
 *   irreversible but never make an irreversible call anything less.
 * - An unknown operation, an input its tool's schema refuses, or an input
 *   that names a different operation is `irreversible`.
 * - Facts are supplied by the host from its own pre-reads and records. A fact
 *   an escalation needs that is missing, malformed or for another object
 *   counts against the call: it escalates.
 */
import {
  escalateGoogleEffect, GOOGLE_INPUT_SCHEMAS, GOOGLE_OPERATION_SPECS, googleOperationOf, isGoogleOperation,
  type GmailDraftInput, type GmailModifyInput, type GoogleEffectClass, type GoogleOperation, type GoogleToolName,
} from "./catalog.js";
import { GMAIL_REVERSIBLE_SYSTEM_LABELS, gmailLabelKind, isGmailDraftId, isGoogleDigest } from "./ids.js";

/**
 * What the host knows about the draft a `draft.save` update targets, from its
 * own ledger and a pre-read of the draft's raw message.
 */
export interface GmailDraftFacts {
  /** The draft these facts describe; facts for any other draft do not apply. */
  draft_id: string;
  /** Whether brain-kit's own records show it created this draft. */
  created_by_brain_kit: boolean;
  /** The sha256 of the draft's current raw message, from the host's pre-read. */
  current_fingerprint: string | null;
  /** brain-kit's last recorded post-write fingerprint for this draft. */
  recorded_fingerprint: string | null;
}

export interface GmailCallFacts {
  draft?: GmailDraftFacts;
}

/** Host-supplied facts, by service. Calendar's (ACL, the resulting event) join here. */
export interface GoogleCallFacts {
  gmail?: GmailCallFacts;
}

type Escalation = (input: never, facts: GoogleCallFacts) => GoogleEffectClass;

const REVERSIBLE_SYSTEM = new Set<string>(GMAIL_REVERSIBLE_SYSTEM_LABELS);

/** A modify that adds or removes any system label but INBOX, UNREAD and STARRED, known or not, is irreversible. */
function modifyEscalation(input: GmailModifyInput): GoogleEffectClass {
  const touched = [...(input.add_label_ids ?? []), ...(input.remove_label_ids ?? [])];
  return touched.some(id => gmailLabelKind(id) !== "user" && !REVERSIBLE_SYSTEM.has(id)) ? "irreversible" : "reversible";
}

/**
 * Updating a draft is reversible only when brain-kit created it and its
 * current fingerprint equals the post-write fingerprint brain-kit recorded:
 * otherwise the update would overwrite text brain-kit has no snapshot of.
 */
function draftSaveEscalation(input: GmailDraftInput, facts: GoogleCallFacts): GoogleEffectClass {
  if (input.action !== "update") return "reversible";
  const draft = facts.gmail?.draft;
  const proven = draft !== undefined
    && isGmailDraftId(draft.draft_id) && draft.draft_id === input.draft_id
    && draft.created_by_brain_kit === true
    && isGoogleDigest(draft.current_fingerprint) && isGoogleDigest(draft.recorded_fingerprint)
    && draft.current_fingerprint === draft.recorded_fingerprint;
  return proven ? "reversible" : "irreversible";
}

/** Every escalation of plan §4, by operation. An operation without one keeps its base class. */
const ESCALATIONS: Partial<Record<GoogleOperation, Escalation>> = {
  "gmail.modify": modifyEscalation as Escalation,
  "gmail.draft.save": draftSaveEscalation as Escalation,
};

/**
 * The effect class of one call. `input` is the tool input as the model sent
 * it; it is validated again here, so an unvalidated or mismatched input can
 * only be irreversible.
 */
export function classifyGoogleCall(operation: string, input: unknown, facts: GoogleCallFacts = {}): GoogleEffectClass {
  if (!isGoogleOperation(operation)) return "irreversible";
  const spec = GOOGLE_OPERATION_SPECS[operation];
  const parsed = GOOGLE_INPUT_SCHEMAS[spec.tool as GoogleToolName].safeParse(input);
  if (!parsed.success) return "irreversible";
  if (googleOperationOf(spec.tool, parsed.data as never) !== operation) return "irreversible";
  const escalation = ESCALATIONS[operation];
  if (!escalation) return spec.base;
  let escalated: GoogleEffectClass;
  try {
    escalated = escalation(parsed.data as never, facts ?? {});
  } catch {
    escalated = "irreversible";
  }
  return escalateGoogleEffect(spec.base, escalated);
}
