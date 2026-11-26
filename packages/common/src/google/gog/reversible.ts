/** Shared host/standalone preparation. Callers hold the account write lock,
 * decide with these facts, and durably record the inverse before execute. */
import { GOOGLE_NOT_FOUND_MESSAGE } from "../decision.js";
import { createHash } from "node:crypto";
import { GMAIL_LIMITS, type GmailDraftInput, type GmailModifyInput, type GoogleError } from "../catalog.js";
import { parseGoogleMailbox, parseGoogleMailboxList, type GoogleMailbox } from "../address.js";
import { isGmailMessageId, isGmailThreadId, isGmailLabelId, GMAIL_REVERSIBLE_SYSTEM_LABELS, gmailLabelKind } from "../ids.js";
import type { GmailRawDraft } from "../mime.js";
import type { GoogleCallFacts } from "../classify.js";
import type { GmailMessageRecord } from "../records.js";
import { isTargetIndependentGogFailure, type GogExecution, type GogResult, type GogTransport } from "./transport.js";
import { GOG_DRAFT_SAVE_INPUT, type GogOperationInput } from "./argv.js";
import { GOG_THREADING_HEADER_CHARS } from "./write-codecs.js";

export class GooglePreparationError extends Error {
  constructor(readonly error: GoogleError) { super(error.message); this.name = "GooglePreparationError"; }
}
const fail = (code: GoogleError["code"], reason: string | null, message: string): never => { throw new GooglePreparationError({ code, reason, message }); };
const missing = (): never => fail("not_found", null, GOOGLE_NOT_FOUND_MESSAGE);
const unreadable = (): never => fail("draft_not_displayable", "draft_not_displayable", "The draft cannot be represented completely as plain text; nothing was changed.");
const shape = (): never => fail("transport_incompatible", "unexpected_shape", "The Google pre-read did not match its target.");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sorted = (values: readonly string[]) => [...new Set(values)].sort();
const same = (a: readonly string[], b: readonly string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const unknown = (): { ok: false; error: GoogleError } => ({ ok: false, error: { code: "outcome_unknown", reason: "write_unconfirmed", message: "The write may have happened, but its result could not be confirmed. Check before trying again." } });

export interface GmailWritePreparationContext {
  transport: GogTransport;
  accountIdentity: string;
  hiddenLabels: readonly string[];
}
/** Body-free operation intent, followed by the identity/fingerprint at confirmation. */
export interface GmailPreparedInverse {
  inverse: Record<string, unknown>;
  precondition: Record<string, unknown>;
  snapshot: Uint8Array | null;
}
export type GmailComposedMessage = Pick<GmailRawDraft, "digest" | "bytes" | "to" | "cc" | "bcc" | "reply_to" | "subject" | "in_reply_to" | "references"> & {
  from: GoogleMailbox; body_text: string;
};

export function gmailWriteReader(ctx: GmailWritePreparationContext) {
  const execution = { accountIdentity: ctx.accountIdentity };
  const hidden = (labels: readonly string[]) => { if (labels.some(id => ctx.hiddenLabels.includes(id))) missing(); };
  const value = <T>(answer: GogResult<T>): T => {
    if (answer.ok) return answer.value;
    // A target's failed pre-read cannot distinguish hidden mail from a miss.
    if (answer.error.code === "not_found" || (ctx.hiddenLabels.length && !isTargetIndependentGogFailure(answer.error))) missing();
    throw new GooglePreparationError(answer.error);
  };
  const thread = async (id: string) => {
    if (!isGmailThreadId(id)) return missing();
    const found = value(await ctx.transport.execute("gmail.thread.get", { thread_id: id }, execution));
    if (found.id !== id || !found.messages.length) return missing();
    hidden(found.messages.flatMap(m => m.label_ids));
    return found;
  };
  const message = async (id: string, requireThread = false) => {
    const found = value(await ctx.transport.execute("gmail.message.get", { message_id: id }, execution));
    if (found.id !== id || !isGmailMessageId(found.id) || !found.label_ids.every(isGmailLabelId)) return missing();
    hidden(found.label_ids);
    if (requireThread || ctx.hiddenLabels.length) {
      const full = await thread(found.thread_id);
      const member = full.messages.find(m => m.id === id);
      if (!member) return missing();
      return { message: found, thread: full };
    }
    return { message: found, thread: null };
  };
  return { execution, hidden, value, thread, message };
}

export async function prepareGmailModify(ctx: GmailWritePreparationContext, input: GmailModifyInput) {
  const read = gmailWriteReader(ctx);
  const add = input.add_label_ids ?? [], remove = input.remove_label_ids ?? [];
  if ([...add, ...remove].some(id => gmailLabelKind(id) !== "user" && !(GMAIL_REVERSIBLE_SYSTEM_LABELS as readonly string[]).includes(id)))
    fail("policy_denied", "unsupported_label", "Only INBOX, UNREAD, STARRED and user label ids can be modified.");
  // gog v0.48.1 resolveLabelIDs checks an exact map key before the lowercase
  // key. fetchLabelNameToID mixes ids and lowercase names in that same map.
  // Refuse ambiguous names regardless of response order, even if today's exact
  // id happens to win. Hidden and missing ids follow this same read boundary.
  // The directory read names no target, so its own failure keeps its cause.
  const listed = await ctx.transport.execute("gmail.labels.list", {}, read.execution);
  if (!listed.ok) throw new GooglePreparationError(listed.error);
  const labels = listed.value;
  const requested = [...add, ...remove];
  const labelSet = labels.filter(label => requested.includes(label.id) || requested.some(id => label.name?.toLowerCase() === id.toLowerCase()))
    .map(label => ({ id: label.id, name: label.name })).sort((a, b) => a.id.localeCompare(b.id));
  if (requested.some(id => ctx.hiddenLabels.includes(id) ||
      (gmailLabelKind(id) === "user" && !labels.some(label => label.id === id)) ||
      labels.some(label => label.id !== id && label.name?.toLowerCase() === id.toLowerCase()))) missing();
  let ids = input.message_ids ?? [];
  if (input.thread_ids) {
    ids = [];
    for (const id of input.thread_ids) {
      const thread = await read.thread(id);
      ids = sorted([...ids, ...thread.messages.map(m => m.id)]);
      if (ids.length > GMAIL_LIMITS.idsPerCall) fail("invalid_input", "items_per_call", "A modify can target at most 25 messages.");
    }
  }
  if (!ids.length || ids.length > GMAIL_LIMITS.idsPerCall || !ids.every(isGmailMessageId)) shape();
  const messages: GmailMessageRecord[] = [];
  for (const id of ids) messages.push((await read.message(id)).message);
  const changes = messages.flatMap(message => {
    const added = add.filter(id => !message.label_ids.includes(id));
    const removed = remove.filter(id => message.label_ids.includes(id));
    return added.length || removed.length ? [{ message_id: message.id, add_label_ids: removed, remove_label_ids: added }] : [];
  });
  const payload = { message_ids: ids, add_label_ids: add, remove_label_ids: remove };
  const inverse: GmailPreparedInverse = { inverse: { kind: "gmail.modify", changes }, snapshot: null,
    precondition: { labels: labelSet, before: messages.map(m => ({ message_id: m.id, label_ids: sorted(m.label_ids) })),
      after: messages.filter(m => changes.some(c => c.message_id === m.id)).map(m => ({ message_id: m.id, label_ids: sorted([...m.label_ids.filter(l => !remove.includes(l)), ...add]) })) } };
  return { payload, inverse, facts: { items: ids.length, target_label_ids: sorted(messages.flatMap(m => m.label_ids)) }, classificationFacts: {} as GoogleCallFacts,
    async execute(finalAdmission: NonNullable<GogExecution["finalAdmission"]>) {
      const result = await ctx.transport.execute("gmail.modify", { message_ids: ids, ...(add.length ? { add_label_ids: add } : {}), ...(remove.length ? { remove_label_ids: remove } : {}) }, { ...read.execution, finalAdmission });
      if (!result.ok) return result;
      if (!same(result.value.message_ids, ids) || !same(result.value.add_label_ids, add) || !same(result.value.remove_label_ids, remove)) return unknown();
      return { ok: true as const, result: { ...payload, message_ids: changes.map(c => c.message_id) } };
    } };
}

function mailbox(address: string): GoogleMailbox {
  const parsed = parseGoogleMailbox(address);
  if (!parsed.ok) return unreadable();
  // gog takes bare addresses, so the card shows those same addresses.
  return { ...parsed.mailbox, display_name: null };
}
/** An omitted update field: gog v0.48.1 keepDraftRecipients keeps the stored mailbox, display name included. */
const kept = (stored: GoogleMailbox): GoogleMailbox => ({ ...mailbox(stored.address), display_name: stored.display_name?.trim() ? stored.display_name : null });
function mailboxList(header: string | null): GoogleMailbox[] {
  if (!header) return [];
  const parsed = parseGoogleMailboxList(header);
  if (!parsed.ok) return unreadable();
  return parsed.mailboxes.map(m => mailbox(m.address));
}
function displayable(parsed: GmailRawDraft | null): asserts parsed is GmailRawDraft & { from: GoogleMailbox; body_text: string } {
  if (!parsed || !parsed.from || parsed.html_part || parsed.attachment || parsed.unreadable_headers || parsed.unreadable_body || parsed.body_text === null) unreadable();
}

export interface GmailDraftProvenance { createdByBrainKit: boolean; fingerprint: string | null }
export async function prepareGmailDraft(ctx: GmailWritePreparationContext, input: GmailDraftInput, provenance: GmailDraftProvenance) {
  const read = gmailWriteReader(ctx);
  let to = (input.to ?? []).map(mailbox), cc = (input.cc ?? []).map(mailbox), bcc = (input.bcc ?? []).map(mailbox);
  let subject = input.subject ?? "", body = input.body ?? "", threadId: string | null = null;
  let snapshot: Uint8Array | null = null, previous: GmailRawDraft | null = null;
  let targetLabels: string[] = [], sourceFingerprint: string | null = null;
  let inReplyTo: string[] = [], references: string[] = [];
  if (input.body !== undefined && !input.body.trim()) fail("invalid_input", "draft_body_blank", "A plain-text draft body must not be blank.");
  if (input.action === "delete") fail("invalid_input", "operation_mismatch", "Draft deletion is not a reversible save.");
  if (input.action === "update") {
    const draft = read.value(await ctx.transport.execute("gmail.draft.get", { draft_id: input.draft_id! }, read.execution));
    if (draft.draft.id !== input.draft_id || !draft.raw) return missing();
    previous = draft.parsed; displayable(previous);
    // A compose update cannot faithfully retain an arbitrary send-as or Reply-To.
    if (previous.from.address !== ctx.accountIdentity || previous.reply_to.length) unreadable();
    snapshot = draft.raw;
    threadId = draft.draft.message?.thread_id ?? null;
    targetLabels = [...(draft.draft.message?.label_ids ?? [])];
    read.hidden(targetLabels);
    if (ctx.hiddenLabels.length) {
      if (!threadId) return missing();
      targetLabels = (await read.thread(threadId)).messages.flatMap(m => m.label_ids);
    }
    to = input.to ? to : previous.to.map(kept);
    cc = input.cc ? cc : previous.cc.map(kept);
    bcc = input.bcc ? bcc : previous.bcc.map(kept);
    subject = input.subject ?? previous.subject ?? "";
    body = input.body ?? previous.body_text;
    // gog v0.48.1 buildDraftMessage (gmail_drafts.go) carries lineage only with
    // an In-Reply-To, and fills an empty References from it.
    inReplyTo = previous.in_reply_to;
    references = !inReplyTo.length ? [] : previous.references.length ? previous.references : [...inReplyTo];
  }
  const sourceId = input.action === "reply" ? input.message_id : input.quote_message_id;
  if (sourceId) {
    const fetched = await read.message(sourceId, true);
    const source = fetched.thread!.messages.find(m => m.id === sourceId)!;
    targetLabels = fetched.thread!.messages.flatMap(m => m.label_ids);
    sourceFingerprint = digest(fetched.thread);
    if (source.body_text === null) unreadable();
    if (input.action === "reply") {
      threadId = fetched.thread!.id;
      // Source-derived: gog v0.48.1 replyInfoFromMessage in gmail_reply.go reads
      // both headers raw, tests membership with the untrimmed Message-ID, and
      // trims only when it writes them. Only ASCII space or tab may pad an id,
      // because gog appends the raw Message-ID and any other edge character
      // would land inside the written References. Each id must be one the
      // post-save raw parser reads back (mime.ts MESSAGE_IDS), the card holds
      // at most 100, and gog's echo of the whole header must fit its codec.
      const pad = (value: string) => value.replace(/^[\t ]+|[\t ]+$/g, "");
      const raw = source.message_id_header ?? "";
      const parent = pad(raw);
      const prior = pad(source.references_header ?? "");
      const ids = (value: string) => value ? value.split(/[\t ]+/) : [];
      const valid = (id: string) => id.length <= GMAIL_LIMITS.headerChars && /^<[\x21-\x3b\x3d\x3f-\x7e]+@[\x21-\x3b\x3d\x3f-\x7e]+>$/.test(id);
      const written = pad(prior.includes(raw) ? prior : prior ? `${prior} ${raw}` : raw);
      inReplyTo = [parent];
      references = ids(prior);
      if (!prior.includes(raw)) references.push(parent);
      if (source.label_ids.includes("DRAFT") || !valid(parent) || !references.every(valid) || references.length > 100 || written.length > GOG_THREADING_HEADER_CHARS)
        fail("draft_not_displayable", "reply_threading_unreadable", "The reply target has no representable Message-ID or References, or is an unsent draft.");
      const sender = mailboxList(source.reply_to || source.from);
      if (!sender.length) unreadable();
      const recipients = input.reply_all ? [...sender, ...mailboxList(source.to), ...mailboxList(source.cc)] : sender;
      const seen = new Set<string>([ctx.accountIdentity.toLowerCase()]);
      const unique = recipients.filter(m => { const key = m.address.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
      if (!unique.length) fail("invalid_input", "reply_no_recipient", "The reply has no recipient after removing this account.");
      to = input.reply_all ? unique.filter(m => sender.some(s => s.address === m.address) || mailboxList(source.to).some(s => s.address === m.address)) : unique;
      cc = unique.filter(m => !to.includes(m));
      subject = /^re:/i.test(source.subject ?? "") ? source.subject! : `Re: ${source.subject ?? ""}`;
    }
    body += `\n\n${(source.body_text ?? "").split("\n").map(line => `> ${line}`).join("\n")}`;
  }
  subject = subject.trim();
  if (!subject) fail("invalid_input", "draft_subject_blank", "gog requires a nonblank subject, including for an update.");
  if (!body.trim()) fail("invalid_input", "draft_body_blank", "A plain-text draft body must not be blank.");
  if (body.length > GMAIL_LIMITS.draftBodyChars)
    fail("draft_not_displayable", "composed_body_too_large", "The complete draft body, including any quoted text, exceeds 32768 characters.");
  body = body.replace(/\r\n?/g, "\n");
  const composed = { from: mailbox(ctx.accountIdentity), to, cc, bcc, reply_to: [], subject, body_text: body, in_reply_to: inReplyTo, references };
  const serialized = JSON.stringify(composed);
  const message: GmailComposedMessage = { ...composed, digest: digest(composed), bytes: new TextEncoder().encode(serialized).length };
  const candidate = { action: input.action === "update" ? "update" : "create",
    ...(input.action !== "update" || input.to !== undefined ? { to: to.map(m => m.address) } : {}),
    ...(input.action !== "update" || input.cc !== undefined ? { cc: cc.map(m => m.address) } : {}),
    ...(input.action !== "update" || input.bcc !== undefined ? { bcc: bcc.map(m => m.address) } : {}),
    // Unlike recipients, gog's update validate() requires an explicit subject.
    subject, body,
    ...(input.action === "update" ? { draft_id: input.draft_id } : {}), ...(input.action === "reply" ? { reply_to_message_id: input.message_id } : {}) };
  const parsed = GOG_DRAFT_SAVE_INPUT.safeParse(candidate);
  if (!parsed.success) unreadable();
  const outbound = parsed.data as GogOperationInput<"gmail.draft.save">;
  const payload = { action: input.action as "create" | "reply" | "update", draft_id: input.draft_id ?? null, thread_id: threadId, message };
  const inverse: GmailPreparedInverse = { inverse: { kind: input.action === "update" ? "gmail.draft.restore" : "gmail.draft.delete",
      ...(input.draft_id ? { draft_id: input.draft_id } : {}), created_by_brain_kit: input.action !== "update" || provenance.createdByBrainKit },
    precondition: { before_fingerprint: previous?.digest ?? null, source_fingerprint: sourceFingerprint }, snapshot };
  const classificationFacts: GoogleCallFacts = input.action === "update" ? { gmail: { draft: { draft_id: input.draft_id!, created_by_brain_kit: provenance.createdByBrainKit,
    current_fingerprint: previous!.digest, recorded_fingerprint: provenance.fingerprint } } } : {};
  return { payload, inverse, classificationFacts, facts: { items: 1, target_label_ids: targetLabels },
    async execute(finalAdmission: NonNullable<GogExecution["finalAdmission"]>) {
      const result = await ctx.transport.execute("gmail.draft.save", outbound, { ...read.execution, finalAdmission });
      if (!result.ok) return result;
      if (input.action === "update" && result.value.draft_id !== input.draft_id) return unknown();
      const after = await ctx.transport.execute("gmail.draft.get", { draft_id: result.value.draft_id }, read.execution);
      if (!after.ok || after.value.draft.id !== result.value.draft_id || after.value.draft.message?.id !== result.value.message_id) return unknown();
      const current = after.value.parsed;
      try { displayable(current); } catch { return unknown(); }
      // Only claim a post-write fingerprint for the composed contents we observed.
      if (current.from.address !== ctx.accountIdentity || !same(current.to.map(m => m.address), to.map(m => m.address)) ||
          !same(current.cc.map(m => m.address), cc.map(m => m.address)) || !same(current.bcc.map(m => m.address), bcc.map(m => m.address)) ||
          current.reply_to.length || JSON.stringify(current.in_reply_to) !== JSON.stringify(inReplyTo) || JSON.stringify(current.references) !== JSON.stringify(references) || current.subject !== subject || current.body_text.replace(/\n$/, "") !== body.replace(/\n$/, "")) return unknown();
      const receipt = { draft_id: result.value.draft_id, fingerprint: current.digest };
      return { ok: true as const, result: receipt, inverseResult: { id: receipt.draft_id, fingerprint: receipt.fingerprint } };
    } };
}
