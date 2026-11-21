import { describe, expect, test } from "bun:test";
import {
  classifyGoogleCall, escalateGoogleEffect, GOOGLE_OPERATIONS, GOOGLE_OPERATION_SPECS,
  type GoogleCallFacts, type GoogleEffectClass,
} from "@schlessera/brain-common/internal/google-operations";

const MESSAGE = "18f3a2b4c5d6e7f8";
const THREAD = "18f3a2b4c5d6e7f0";
const DRAFT = "r-7350000000000000012";
const OTHER_DRAFT = "r-7350000000000000013";
const RECORDED = "a".repeat(64);
const CHANGED = "b".repeat(64);

/** Facts for a draft brain-kit created and has not seen change, with one field overridden. */
const draftFacts = (overrides: Record<string, unknown> = {}): GoogleCallFacts => ({
  gmail: { draft: { draft_id: DRAFT, created_by_brain_kit: true, current_fingerprint: RECORDED, recorded_fingerprint: RECORDED, ...overrides } as never },
});
const modify = (change: Record<string, string[]>) => ({ message_ids: [MESSAGE], ...change });
const update = { action: "update", draft_id: DRAFT, body: "The shroud is finished." };

interface Row { name: string; operation: string; input: unknown; facts?: GoogleCallFacts; expected: GoogleEffectClass }

const rows: Row[] = [
  // Reads stay reads.
  { name: "search is a read", operation: "gmail.search", input: { query: "from:penelope@example.com" }, expected: "read" },
  { name: "a thread read is a read", operation: "gmail.thread.get", input: { target: "thread", id: THREAD }, expected: "read" },
  { name: "a message read is a read", operation: "gmail.message.get", input: { target: "message", id: MESSAGE }, expected: "read" },
  { name: "a draft read is a read", operation: "gmail.draft.get", input: { target: "draft", id: DRAFT }, expected: "read" },
  { name: "the label list is a read", operation: "gmail.labels.list", input: { target: "labels" }, expected: "read" },

  // Modify: reversible for INBOX, UNREAD, STARRED and user labels.
  { name: "archive (remove INBOX) is reversible", operation: "gmail.modify", input: modify({ remove_label_ids: ["INBOX"] }), expected: "reversible" },
  { name: "unarchive (add INBOX) is reversible", operation: "gmail.modify", input: modify({ add_label_ids: ["INBOX"] }), expected: "reversible" },
  { name: "mark read (remove UNREAD) is reversible", operation: "gmail.modify", input: modify({ remove_label_ids: ["UNREAD"] }), expected: "reversible" },
  { name: "mark unread (add UNREAD) is reversible", operation: "gmail.modify", input: modify({ add_label_ids: ["UNREAD"] }), expected: "reversible" },
  { name: "star (add STARRED) is reversible", operation: "gmail.modify", input: modify({ add_label_ids: ["STARRED"] }), expected: "reversible" },
  { name: "unstar (remove STARRED) is reversible", operation: "gmail.modify", input: modify({ remove_label_ids: ["STARRED"] }), expected: "reversible" },
  { name: "adding and removing user labels is reversible", operation: "gmail.modify", input: { thread_ids: [THREAD], add_label_ids: ["Label_42"], remove_label_ids: ["Label_7", "STARRED"] }, expected: "reversible" },

  // Modify: every other system label escalates.
  { name: "modify adding IMPORTANT escalates", operation: "gmail.modify", input: modify({ add_label_ids: ["IMPORTANT"] }), expected: "irreversible" },
  { name: "modify removing IMPORTANT escalates", operation: "gmail.modify", input: modify({ remove_label_ids: ["IMPORTANT"] }), expected: "irreversible" },
  { name: "modify adding SPAM escalates", operation: "gmail.modify", input: modify({ add_label_ids: ["SPAM"] }), expected: "irreversible" },
  { name: "modify adding TRASH escalates", operation: "gmail.modify", input: modify({ add_label_ids: ["TRASH"] }), expected: "irreversible" },
  { name: "modify removing a category escalates", operation: "gmail.modify", input: modify({ remove_label_ids: ["CATEGORY_PROMOTIONS"] }), expected: "irreversible" },
  { name: "modify adding a superstar escalates", operation: "gmail.modify", input: modify({ add_label_ids: ["YELLOW_STAR"] }), expected: "irreversible" },
  { name: "modify naming an unknown system label escalates", operation: "gmail.modify", input: modify({ add_label_ids: ["MYSTERY_LABEL"] }), expected: "irreversible" },
  { name: "one escalating label among reversible ones escalates", operation: "gmail.modify", input: modify({ remove_label_ids: ["INBOX", "UNREAD", "SENT"] }), expected: "irreversible" },

  // Trash stays irreversible.
  { name: "trash stays irreversible", operation: "gmail.trash", input: { thread_ids: [THREAD] }, expected: "irreversible" },
  { name: "trash stays irreversible whatever the facts", operation: "gmail.trash", input: { message_ids: [MESSAGE] }, facts: draftFacts(), expected: "irreversible" },

  // Draft save: create and reply are reversible; an update needs proof.
  { name: "creating a draft is reversible", operation: "gmail.draft.save", input: { action: "create", to: ["penelope@example.com"], subject: "The loom", body: "Tonight." }, expected: "reversible" },
  { name: "replying is reversible", operation: "gmail.draft.save", input: { action: "reply", message_id: MESSAGE, body: "Home soon." }, expected: "reversible" },
  { name: "updating an unchanged brain-kit draft is reversible", operation: "gmail.draft.save", input: update, facts: draftFacts(), expected: "reversible" },
  { name: "updating a draft brain-kit did not create escalates", operation: "gmail.draft.save", input: update, facts: draftFacts({ created_by_brain_kit: false }), expected: "irreversible" },
  { name: "updating a draft changed since brain-kit recorded it escalates", operation: "gmail.draft.save", input: update, facts: draftFacts({ current_fingerprint: CHANGED }), expected: "irreversible" },
  { name: "updating without draft facts escalates", operation: "gmail.draft.save", input: update, expected: "irreversible" },
  { name: "updating with facts for another draft escalates", operation: "gmail.draft.save", input: update, facts: draftFacts({ draft_id: OTHER_DRAFT }), expected: "irreversible" },
  { name: "updating without a current fingerprint escalates", operation: "gmail.draft.save", input: update, facts: draftFacts({ current_fingerprint: null, recorded_fingerprint: null }), expected: "irreversible" },
  { name: "updating without a recorded fingerprint escalates", operation: "gmail.draft.save", input: update, facts: draftFacts({ recorded_fingerprint: null }), expected: "irreversible" },
  { name: "updating with a malformed fingerprint escalates", operation: "gmail.draft.save", input: update, facts: draftFacts({ current_fingerprint: "loom", recorded_fingerprint: "loom" }), expected: "irreversible" },
  { name: "updating with a non-boolean creator fact escalates", operation: "gmail.draft.save", input: update, facts: draftFacts({ created_by_brain_kit: "yes" }), expected: "irreversible" },

  // Delete and send are irreversible.
  { name: "deleting a draft is irreversible", operation: "gmail.draft.delete", input: { action: "delete", draft_id: DRAFT }, facts: draftFacts(), expected: "irreversible" },
  { name: "sending a draft is irreversible", operation: "gmail.draft.send", input: { draft_id: DRAFT }, expected: "irreversible" },

  // Anything the classifier does not recognise is irreversible.
  { name: "an unknown operation is irreversible", operation: "gmail.filters.create", input: {}, expected: "irreversible" },
  { name: "a calendar operation not yet in the catalog is irreversible", operation: "calendar.events.list", input: {}, expected: "irreversible" },
  { name: "an input its schema refuses is irreversible", operation: "gmail.search", input: { query: "is:unread", raw: true }, expected: "irreversible" },
  { name: "an input naming another operation is irreversible", operation: "gmail.draft.save", input: { action: "delete", draft_id: DRAFT }, expected: "irreversible" },
  { name: "a read input naming another target is irreversible", operation: "gmail.thread.get", input: { target: "labels" }, expected: "irreversible" },
];

describe("classifyGoogleCall", () => {
  for (const row of rows) {
    test(row.name, () => expect(classifyGoogleCall(row.operation, row.input, row.facts)).toBe(row.expected));
  }

  test("facts that throw when read escalate", () => {
    const facts = { get gmail(): never { throw new Error("ledger unreadable"); } };
    expect(classifyGoogleCall("gmail.draft.save", update, facts)).toBe("irreversible");
  });

  test("no call is classified below its operation's base class", () => {
    const below = rows.filter(row => {
      const base = GOOGLE_OPERATION_SPECS[row.operation as keyof typeof GOOGLE_OPERATION_SPECS]?.base ?? "irreversible";
      return escalateGoogleEffect(base, classifyGoogleCall(row.operation, row.input, row.facts)) !== classifyGoogleCall(row.operation, row.input, row.facts);
    }).map(row => row.name);
    expect(rows.length).toBeGreaterThan(30);
    expect(below).toEqual([]);
  });

  test("every operation in the catalog has a classified row", () => {
    expect(GOOGLE_OPERATIONS.filter(operation => !rows.some(row => row.operation === operation))).toEqual([]);
  });
});

describe("escalateGoogleEffect", () => {
  test("returns the higher class and never a lower one", () => {
    expect([
      escalateGoogleEffect("read", "reversible"),
      escalateGoogleEffect("reversible", "read"),
      escalateGoogleEffect("irreversible", "read"),
      escalateGoogleEffect("reversible", "irreversible"),
      escalateGoogleEffect("read", "read"),
    ]).toEqual(["reversible", "reversible", "irreversible", "irreversible", "read"]);
  });
});
