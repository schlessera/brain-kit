import { expect, test } from "bun:test";
import { GOOGLE_MAIL_APPROVAL_SCHEMA, GMAIL_LIMITS, type GoogleMailApproval } from "../src/tool-contracts/google.js";
import { serverToolApprovalRequestSchema, clientToolApprovalSchema } from "../src/schemas.js";

const sender = { address: "odysseus@ithaca.invalid", local: "odysseus", domain: "ithaca.invalid", display_name: "Odysseus" };
const message = { digest: "a".repeat(64), bytes: 400, from: sender, to: [sender], cc: [], bcc: [], reply_to: [],
  subject: "Return to Ithaca", in_reply_to: [], references: [], body_text: "The fleet returns." };
const base = { effect: "reversible" as const, tainted: false, entities: ["INBOX"], offers: { allow_always: true, allow_for_session: false } };
const cards = [
  { ...base, operation: "gmail.modify", payload: { message_ids: ["abcdef123"], add_label_ids: [], remove_label_ids: ["INBOX"] } },
  { ...base, operation: "gmail.trash", effect: "irreversible", offers: { allow_always: false, allow_for_session: false }, payload: { message_ids: ["abcdef123"] } },
  { ...base, operation: "gmail.draft.save", payload: { action: "create", draft_id: null, thread_id: null, message } },
  { ...base, operation: "gmail.draft.delete", effect: "irreversible", offers: { allow_always: false, allow_for_session: false }, payload: { draft_id: "r123", digest: message.digest } },
  { ...base, operation: "gmail.draft.send", effect: "irreversible", offers: { allow_always: false, allow_for_session: false }, payload: { draft_id: "r123", thread_id: null, send_as: sender, message } },
] satisfies GoogleMailApproval[];
for (const card of cards) test(`google approval accepts ${card.operation}`, () => {
  expect(GOOGLE_MAIL_APPROVAL_SCHEMA.parse(card)).toEqual(card);
  expect(serverToolApprovalRequestSchema.safeParse({ type: "tool_approval_request", toolUseId: "card", toolName: "gmail", kind: "google", input: card }).success).toBe(true);
});
test("google approval rejects invalid offers and unknown fields", () => {
  for (const invalid of [
    { ...cards[0], tainted: true },
    { ...cards[0], offers: { allow_always: false, allow_for_session: true } },
    { ...cards[4], offers: base.offers },
    { ...cards[3], effect: "reversible" },
    { ...cards[0], extra: true },
    { ...cards[0], payload: { ...cards[0]!.payload, extra: true } },
    { ...cards[0], offers: { ...base.offers, extra: true } },
  ]) expect(GOOGLE_MAIL_APPROVAL_SCHEMA.safeParse(invalid).success).toBe(false);
});
test("google approval refuses truncated and over-bound outbound text", () => {
  for (const invalid of [
    { ...message, body_text: "a".repeat(GMAIL_LIMITS.draftBodyChars + 1) },
    { ...message, body_truncated: true },
    { ...message, body_text: null },
    { ...message, from: null },
    { ...message, unreadable_body: true },
  ]) {
    const card = { ...cards[2], payload: { ...cards[2]!.payload, message: invalid } };
    expect(GOOGLE_MAIL_APPROVAL_SCHEMA.safeParse(card).success).toBe(false);
    expect(serverToolApprovalRequestSchema.safeParse({ type: "tool_approval_request", toolUseId: "card", toolName: "gmail", kind: "google", input: card }).success).toBe(false);
  }
  expect(GOOGLE_MAIL_APPROVAL_SCHEMA.safeParse({ ...cards[2], payload: { ...cards[2]!.payload, message: { ...message, body_text: "a".repeat(GMAIL_LIMITS.draftBodyChars) } } }).success).toBe(true);
});
test("google session answer has its own wire field", () => {
  expect(clientToolApprovalSchema.parse({ type: "tool_approval", toolUseId: "card", forSession: true }).forSession).toBe(true);
  expect(clientToolApprovalSchema.safeParse({ type: "tool_approval", toolUseId: "card", forSession: "yes" }).success).toBe(false);
});

test("google approval validates operation payloads, identifiers and verified sender", () => {
  for (const invalid of [
    { ...cards[0], payload: cards[4]!.payload },
    { ...cards[0], payload: { ...cards[0]!.payload, message_ids: [] } },
    { ...cards[0], payload: { ...cards[0]!.payload, message_ids: ["not-an-id"] } },
    { ...cards[3], payload: { draft_id: "r123", digest: "A".repeat(64) } },
    { ...cards[2], payload: { ...cards[2]!.payload, action: "update", draft_id: null } },
    { ...cards[2], payload: { ...cards[2]!.payload, action: "reply", thread_id: null } },
    { ...cards[4], payload: { ...cards[4]!.payload, send_as: { ...sender, address: "athena@ithaca.invalid", local: "athena" } } },
    { ...cards[2], payload: { ...cards[2]!.payload, message: { ...message, from: { ...sender, local: "athena" } } } },
  ]) expect(GOOGLE_MAIL_APPROVAL_SCHEMA.safeParse(invalid).success).toBe(false);
  for (const payload of [
    { action: "reply", draft_id: null, thread_id: "abcdef123", message },
    { action: "update", draft_id: "r123", thread_id: null, message },
  ]) expect(GOOGLE_MAIL_APPROVAL_SCHEMA.safeParse({ ...cards[2], payload }).success).toBe(true);
});
test("google approval accepts only the standing choice appropriate to its taint", () => {
  for (const card of cards.filter(card => card.effect === "reversible")) {
    expect(GOOGLE_MAIL_APPROVAL_SCHEMA.safeParse({ ...card, tainted: true,
      offers: { allow_always: false, allow_for_session: true } }).success).toBe(true);
    expect(GOOGLE_MAIL_APPROVAL_SCHEMA.safeParse({ ...card,
      offers: { allow_always: true, allow_for_session: true } }).success).toBe(false);
  }
});
