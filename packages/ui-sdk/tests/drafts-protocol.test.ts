import { expect, test } from "bun:test";
import { SESSION_DRAFT_LIMITS } from "../src/protocol.js";
import { draftSchema, parseClientMessage, parseServerMessage } from "../src/schemas.js";

test("chat_message carries an optional draftRef naming a positive revision", () => {
  const frame = { type: "chat_message", text: "Sail for Ithaca", requestId: "r1", draftRef: { draftId: "draft-ithaca", revision: 2 } } as const;
  expect(parseClientMessage(JSON.stringify(frame))).toEqual({ ok: true, message: frame });
  for (const draftRef of [{ draftId: "draft-ithaca", revision: 0 }, { draftId: "", revision: 1 }, { draftId: "d", revision: 1.5 }]) {
    expect(parseClientMessage(JSON.stringify({ ...frame, draftRef })).ok).toBe(false);
  }
});

test("server_hello keeps its booleans readable beside the draft limits, and a bad bound costs only itself", () => {
  const hello = { type: "server_hello", protocolRev: 4, capabilities: { inbox: true, sessionDrafts: true }, sessionDraftLimits: SESSION_DRAFT_LIMITS };
  expect(parseServerMessage(JSON.stringify(hello))).toEqual({ ok: true, message: hello });
  const malformed = parseServerMessage(JSON.stringify({ ...hello, sessionDraftLimits: { maxTextBytes: "lots" } }));
  expect(malformed).toEqual({ ok: true, message: { type: "server_hello", protocolRev: 4, capabilities: { inbox: true, sessionDrafts: true } } });
  // Why the limits are not inside capabilities: the record is boolean-valued.
  expect(parseServerMessage(JSON.stringify({ ...hello, capabilities: { inbox: true, sessionDrafts: SESSION_DRAFT_LIMITS } })).ok).toBe(false);
});

test("a draft response validates its images as canonical base64 of an allowed type", () => {
  const draft = { draftId: "d", sessionId: null, revision: 1, updatedAt: 1, text: "Ithaca",
    attachments: [{ attachmentId: "a", mime: "image/png", bytes: "iVBORw0KGgo=", name: null }] };
  expect(draftSchema.safeParse(draft).success).toBe(true);
  expect(draftSchema.safeParse({ ...draft, attachments: [{ ...draft.attachments[0], mime: "image/svg+xml" }] }).success).toBe(false);
  expect(draftSchema.safeParse({ ...draft, attachments: [{ ...draft.attachments[0], bytes: "data:image/png;base64,AAAA" }] }).success).toBe(false);
});
