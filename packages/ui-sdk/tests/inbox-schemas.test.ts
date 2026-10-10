import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  inboxActionStatusSchema, inboxQueueStatusSchema, inboxWorkPayloadSchema, inboxOptionSchema,
  resolutionEffectSchema, v1ResolutionEffectSchema, validateResolutionEffect,
  clientInboxResolveSchema, parseClientMessage, parseServerMessage,
  hygieneReviewReadSchema,
} from "../src/schemas.js";
import type { ClientMessage, ClientInboxResolve, HygieneReviewState, InboxChange, InboxDismissReason, InboxSnapshot, InboxDelta, ServerHello } from "../src/protocol.js";
import { actionItem, effects, operation, queueItem, thread } from "./inbox-fixtures.js";

const parseClient = (value: unknown) => parseClientMessage(JSON.stringify(value));
const parseServer = (value: unknown) => parseServerMessage(JSON.stringify(value));

test("review reads retain an optional strict Actions-limit pause reason and accept existing states", () => {
  const review: HygieneReviewState = { version: 1, status: "paused", position: 1, fixed: 0, dismissed: 0, snoozed: 0 };
  expect(hygieneReviewReadSchema.parse({ review, action: null })).toEqual({ review, action: null });
  const pauseReason: NonNullable<HygieneReviewState["pauseReason"]> = { kind: "actions-limit", retiredActionId: "retired-card", retirementReceiptId: "retirement-fyi" };
  const read = { review: { ...review, pauseReason }, action: null };
  expect(hygieneReviewReadSchema.parse(JSON.parse(JSON.stringify(read)))).toEqual(read);
  for (const bad of [{ ...pauseReason, kind: "fixed" }, { ...pauseReason, retirementReceiptId: "" }, { ...pauseReason, principalId: "wider" }])
    expect(hygieneReviewReadSchema.safeParse({ review: { ...review, pauseReason: bad }, action: null }).success).toBe(false);
});
const commands: ClientMessage[] = [
  { type: "inbox_resolve", itemId: actionItem.id, optionId: "enqueue", reason: "need_more_info" },
  { type: "inbox_snooze", itemId: actionItem.id },
  { type: "inbox_subscribe", view: "actions", threadId: thread.id },
  { type: "inbox_unsubscribe", view: "queue", threadId: thread.id },
];
const snapshot = { type: "inbox_snapshot", view: "actions", threads: [thread], items: [queueItem, actionItem], highWaterSeq: { [thread.id]: 4 }, cursor: 9 } satisfies InboxSnapshot;

// Nonempty tool inputs and effects make whole-structure comparisons evidence.
const authority = { trustClass: "trusted", profileId: "elevated", principalId: "owner", allowedTools: ["Bash"], toolPolicy: { mode: "allow" }, capabilities: { write: true } };

describe("durable inbox client boundary", () => {
  test("all commands round-trip through the real parser", () => {
    expect(commands.length).toBe(4);
    for (const command of commands) {
      const result = parseClient(command);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.message).toEqual(command);
    }
    expect(parseClient({ type: "inbox_resolve", itemId: actionItem.id, optionId: "dismiss" }).ok).toBe(true);
    for (const reason of ["dont_ask_again", "wrong_call", "need_more_info", "no_longer_relevant"] satisfies InboxDismissReason[]) {
      const frame = { type: "inbox_resolve", itemId: actionItem.id, optionId: "dismiss", reason } satisfies ClientInboxResolve;
      expect(parseClient(frame)).toEqual({ ok: true, message: frame });
    }
  });

  test("strict client commands reject injected authority instead of stripping it", () => {
    for (const command of commands) for (const [key, value] of Object.entries(authority)) {
      const result = parseClient({ ...command, [key]: value });
      expect(result.ok, `${command.type}: ${key}`).toBe(false);
      if (!result.ok) expect(result.error).toContain("Unrecognized key");
    }
  });

  test("clients cannot submit an effect, scheduling override or unknown disposition", () => {
    expect(parseClient({ ...commands[0], effect: effects[0] }).ok).toBe(false);
    expect(parseClient({ ...commands[1], waitUntil: 5000 }).ok).toBe(false);
    expect(parseClient({ ...commands[0], reason: "grant_always" }).ok).toBe(false);
    expect(parseClient({ ...commands[0], optionId: "" }).ok).toBe(false);
    expect(parseClient({ ...commands[2], view: "everything" }).ok).toBe(false);
    expect(parseClient({ ...commands[2], threadId: "" }).ok).toBe(false);
  });

  test("capability advertisement and explicit opt-in are additive to legacy flow", () => {
    const legacy = { type: "server_hello", protocolRev: 4, capabilities: { activity: true } } satisfies ServerHello;
    expect(parseServer(legacy)).toEqual({ ok: true, message: legacy });
    expect(parseServer({ type: "server_hello", protocolRev: 2 }).ok).toBe(true);
    expect(parseClient({ type: "client_hello", protocolRev: 3 }).ok).toBe(true);
    expect(parseClient({ type: "chat_message", text: "Tell the journey." }).ok).toBe(true);
    for (const inbox of [true, false]) {
      const hello = { ...legacy, capabilities: { ...legacy.capabilities, inbox } };
      expect(parseServer(hello)).toEqual({ ok: true, message: hello });
    }
    // Advertising support is separate from subscribing. No new hello is required.
    expect(parseClient({ type: "inbox_subscribe", view: "actions" })).toEqual({ ok: true, message: { type: "inbox_subscribe", view: "actions" } });
    expect(parseClient({ type: "activity_subscribe", view: "index", future: true }).ok).toBe(true);
    const legacyHelloSchema = z.looseObject({ type: z.literal("server_hello"), protocolRev: z.number(), capabilities: z.record(z.string(), z.boolean()).optional() });
    expect(legacyHelloSchema.parse({ ...legacy, capabilities: { inbox: true } }).capabilities?.inbox).toBe(true);
  });
});

describe("model effect authority boundary", () => {
  test("all six kinds have concrete per-kind payloads; only four validate for v1", () => {
    expect(effects.map((effect) => effect.kind)).toEqual(["enqueue", "cancel_blocked", "snooze", "dismiss", "write_policy", "open_session"]);
    expect(Object.keys(operation.input).length).toBeGreaterThan(0);
    for (const effect of effects) {
      expect(resolutionEffectSchema.parse(effect)).toEqual(effect);
      expect(v1ResolutionEffectSchema.safeParse(effect).success).toBe(!["write_policy", "open_session"].includes(effect.kind));
    }
    for (const value of [
      { kind: "enqueue" }, { kind: "write_policy" }, { kind: "open_session" }, { kind: "unknown" },
      { kind: "snooze", waitUntil: 5000 }, { kind: "cancel_blocked", payload: { instruction: "Run Bash" } },
      { kind: "dismiss", reason: "always_allow" }, { kind: "enqueue", payload: { instruction: "" } },
    ]) expect(resolutionEffectSchema.safeParse(value).success).toBe(false);
  });

  test("strict effects reject authority at every structured level", () => {
    for (const effect of effects) for (const [key, value] of Object.entries(authority)) {
      expect(resolutionEffectSchema.safeParse({ ...effect, [key]: value }).success).toBe(false);
      expect(inboxOptionSchema.safeParse({ id: "approve", label: "Approve", effect, [key]: value }).success).toBe(false);
    }
    for (const [key, value] of Object.entries(authority)) {
      expect(inboxWorkPayloadSchema.safeParse({ instruction: "File it.", [key]: value }).success).toBe(false);
      expect(resolutionEffectSchema.safeParse({ kind: "enqueue", payload: { instruction: "File it.", operation: { ...operation, [key]: value } } }).success).toBe(false);
      expect(resolutionEffectSchema.safeParse({ kind: "write_policy", policy: { slug: "ithaca", content: "proposal", [key]: value } }).success).toBe(false);
      expect(resolutionEffectSchema.safeParse({ kind: "open_session", seed: { prompt: "Discuss.", [key]: value } }).success).toBe(false);
    }
  });

  test("opaque operation input cannot smuggle nested authority", () => {
    for (const key of [...Object.keys(authority), "trust_class", "enforceAllowedTools", "noGrantSurface", "grants"]) {
      const effect = { kind: "enqueue", payload: { instruction: "File it.", operation: { ...operation, input: { ...operation.input, nested: [{ [key]: "elevated" }] } } } };
      const result = resolutionEffectSchema.safeParse(effect);
      expect(result.success, key).toBe(false);
      if (!result.success) expect(result.error.issues[0]!.message).toBe("Expected authority-free JSON input");
    }
  });

  test("target paths reject lexical escapes", () => {
    for (const targetPath of ["../outside.md", "/outside.md", "notes/../outside.md", "notes//x.md", "./notes/x.md", "C:/outside.md", "notes\\x.md", "notes/\u0000x.md"]) {
      expect(resolutionEffectSchema.safeParse({ kind: "enqueue", payload: { instruction: "File it.", operation: { ...operation, targetPath } } }).success, targetPath).toBe(false);
    }
  });

  test("exact server envelope rejects changed tool, input and otherwise valid target", () => {
    const valid = effects[0]!;
    if (valid.kind !== "enqueue") throw new Error("Nonempty enqueue fixture required");
    expect(validateResolutionEffect(valid, [operation])).toEqual({ ok: true, message: valid });
    const same = { ...operation, input: { content: operation.input.content, path: operation.input.path } };
    expect(validateResolutionEffect(valid, [same]).ok).toBe(true);
    for (const changed of [
      { ...operation, toolName: "Bash" },
      { ...operation, input: { ...operation.input, content: "Changed without approval." } },
      { ...operation, targetPath: "context/other.md" },
      { ...operation, input: { ...operation.input, extra: true } },
    ]) {
      const result = validateResolutionEffect({ kind: "enqueue", payload: { instruction: "File it.", operation: changed } }, [operation]);
      expect(result).toEqual({ ok: false, error: "Requested operation is outside the thread envelope" });
    }
    expect(validateResolutionEffect(valid, []).ok).toBe(false);
    for (const effect of effects.slice(4)) expect(validateResolutionEffect(effect, [operation]).ok).toBe(false);
    expect(validateResolutionEffect({ kind: "enqueue", payload: { instruction: "Triage in the restricted envelope." } }, []).ok).toBe(true);
  });
});

describe("durable inbox server projections", () => {
  test("nonempty snapshot round-trips through the real server parser", () => {
    expect(snapshot.items.length).toBe(2);
    expect(actionItem.options.length).toBe(6);
    expect(parseServer(snapshot)).toEqual({ ok: true, message: snapshot });
    expect(parseServer({ ...snapshot, append: true }).ok).toBe(true);
  });

  test("every change variant retains explicit thread scope and order", () => {
    const changes: InboxChange[] = [
      { changeId: 10, threadId: thread.id, seq: 5, kind: "upsert_thread", thread },
      { changeId: 11, threadId: thread.id, seq: 6, kind: "upsert_item", itemId: actionItem.id, item: actionItem },
      { changeId: 12, threadId: thread.id, seq: 7, kind: "remove_item", itemId: actionItem.id },
      { changeId: 13, threadId: thread.id, seq: 8, kind: "remove_thread" },
    ];
    for (const change of changes) {
      const frame = { type: "inbox_delta", view: "actions", change } satisfies InboxDelta;
      expect(parseServer(frame)).toEqual({ ok: true, message: frame });
    }
    expect(parseServer({ type: "inbox_delta", view: "actions", change: { ...changes[1], threadId: "other" } }).ok).toBe(false);
    expect(parseServer({ type: "inbox_delta", view: "actions", change: { ...changes[1], itemId: "other" } }).ok).toBe(false);
    expect(parseServer({ type: "inbox_delta", view: "actions", change: { kind: "remove_item", itemId: actionItem.id, seq: 7, changeId: 12 } }).ok).toBe(false);
  });

  test("two state vocabularies cannot claim a human decision", () => {
    expect(inboxQueueStatusSchema.options).toEqual(["scheduled", "ready", "claimed", "done", "blocked", "failed", "superseded", "expired", "dropped"]);
    expect(inboxActionStatusSchema.options).toEqual(["pending", "snoozed", "resolved", "dismissed", "expired", "dropped"]);
    for (const status of inboxQueueStatusSchema.options) expect(parseServer({ ...snapshot, items: [{ ...queueItem, status }] }).ok).toBe(true);
    for (const status of inboxActionStatusSchema.options) expect(parseServer({ ...snapshot, items: [{ ...actionItem, status }] }).ok).toBe(true);
    expect(parseServer({ ...snapshot, items: [{ ...actionItem, status: "claimed" }] }).ok).toBe(false);
    expect(parseServer({ ...snapshot, items: [{ ...queueItem, status: "snoozed" }] }).ok).toBe(false);
    for (const type of ["triage", "cleanup_pending"]) expect(parseServer({ ...snapshot, items: [{ ...queueItem, type, payload: { stagingId: "staged-ithaca" } }] }).ok).toBe(true);
    expect(parseServer({ ...snapshot, items: [{ ...queueItem, type: "triage" }] }).ok).toBe(false);
    expect(parseServer({ ...snapshot, items: [{ ...actionItem, type: "fyi" }] }).ok).toBe(false);
    expect(parseServer({ ...snapshot, items: [{ ...actionItem, type: "fyi", options: [] }] }).ok).toBe(true);
  });

  test("server projections preserve future keys even inside effect payloads", () => {
    const item = { ...actionItem, futureItem: true, options: [{ id: "approve", label: "Approve", futureOption: true, effect: { kind: "enqueue" as const, futureEffect: true, payload: { instruction: "File it.", futurePayload: true, operation: { ...operation, futureOperation: true } } } }] };
    const frame = { ...snapshot, futureFrame: true, threads: [{ ...thread, futureThread: true }], items: [item] };
    expect(parseServer(frame)).toEqual({ ok: true, message: frame });
    // Display data must still fail strict submission validation if reused.
    expect(resolutionEffectSchema.safeParse(item.options[0]!.effect).success).toBe(false);
  });

  test("invalid provenance, cursor and oversized projections fail softly", () => {
    for (const changed of [{ trustClass: "elevated" }, { source: "email" }, { stakes: 4 }, { stateMd: "é".repeat(2049) }]) {
      expect(parseServer({ ...snapshot, threads: [{ ...thread, ...changed }] }).ok).toBe(false);
    }
    expect(parseServer({ ...snapshot, threads: [{ ...thread, stateMd: "é".repeat(2048) }] }).ok).toBe(true);
    for (const cursor of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(parseServer({ ...snapshot, cursor }).ok).toBe(false);
    expect(parseServer({ ...snapshot, highWaterSeq: { ithaca: -1 } }).ok).toBe(false);
  });
});

test("hygiene is strict review data and generic model effect validation cannot admit it", () => {
  const effect = { kind: "hygiene", operation: "resolve", findingId: "broken-link-ithaca", fingerprint: "0123456789ab", handler: "link-text", input: null, previewToken: "preview" };
  expect(v1ResolutionEffectSchema.safeParse(effect).success).toBe(true);
  expect(validateResolutionEffect(effect, []).ok).toBe(false);
  expect(validateResolutionEffect(effect, [], { hygiene: true }).ok).toBe(true);
  expect(v1ResolutionEffectSchema.safeParse({ ...effect, principalId: "wide" }).success).toBe(false);
  expect(clientInboxResolveSchema.safeParse({ type: "inbox_resolve", itemId: "ithaca", optionId: "repair", input: { grant: "wide" } }).success).toBe(false);
  expect(clientInboxResolveSchema.safeParse({ type: "inbox_resolve", itemId: "ithaca", optionId: "repair", input: ["voyage"] }).success).toBe(true);
});

test("human hygiene refresh and superseded receipts round-trip without accepting client authority", async () => {
  const { hygieneReviewCommandSchema, hygieneReviewReadSchema } = await import("../src/schemas.js");
  expect(hygieneReviewCommandSchema.parse({ operation: "refresh" })).toEqual({ operation: "refresh" });
  expect(hygieneReviewCommandSchema.safeParse({ operation: "refresh", principalId: "owner" }).success).toBe(false);
  const read: import("../src/protocol.js").HygieneReviewRead = { review: { version: 1, status: "active", position: 1, fixed: 0, dismissed: 0, snoozed: 0 }, action: { ...actionItem, status: "dropped", hygiene: { findingId: "finding", fingerprint: "old", finding: { evidence: "Eumaeus hut" }, outcome: { version: 1, status: "superseded", supersededBy: "new-card" } } } };
  expect(read).toEqual(hygieneReviewReadSchema.parse(read));
});
