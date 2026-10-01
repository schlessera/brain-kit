// ============================================================
// Runtime wire-protocol schemas
//
// Both endpoints previously CAST parsed JSON to the protocol interfaces; these
// zod schemas make the boundary real: servers validate every inbound client
// frame. Each schema is assignability-bound to its protocol.ts interface via
// `satisfies z.ZodType<...>`; the compile-time equality test additionally
// checks exact keys, optionality, and nested values in both directions.
//
// Validation policy (matches the additive-only protocol contract):
// - Durable inbox commands and model-submitted effects use strict schemas.
//   Server frames remain loose; see the authority boundary below.
// - Other unknown OBJECT KEYS are PRESERVED (z.looseObject) — a newer peer may add
//   optional fields and they must survive the boundary.
// - Unknown FRAME TYPES fail the union — receivers should treat that as
//   "ignore frame" (client) or "protocol error" (server), never as a crash.
// - Size limits are enforced here, at the boundary, not deep in handlers.
// ============================================================

import { z } from "zod";
import { isThinkingLevel } from "./protocol.js";
import type { ThinkingLevel } from "./protocol.js";

const thinkingLevelSchema = z.custom<ThinkingLevel>(isThinkingLevel, "Invalid thinking level");

import { ASK_USER_FORM_INPUT_SCHEMA, ASK_USER_FORM_ANSWER_SCHEMA, type AskUserFormNode, type AskUserFormAnswers } from "./tool-contracts/form.js";
import { BLOCK_SCHEMA } from "./tool-contracts/blocks.js";

import type {
  AskUserAnnotation,
  ClientHello,
  QueueAddRequest, QueueAddResult,
  ClientInboxResolve, ClientInboxSnooze, ClientInboxSubscribe, ClientInboxUnsubscribe,
  InboxView, InboxQueueStatus, InboxActionStatus, InboxDismissReason, InboxThread,
  InboxOperation, InboxWorkPayload, ResolutionEffect, V1ResolutionEffect, InboxOption,
  InboxItemBase, InboxQueueItem, InboxActionItem, InboxItem, InboxChange, InboxSnapshot, InboxDelta,
  ClientRetryTurn,
  ClientRetryStatus,
  ServerRetryReceipt,
  MessagePart,
  SessionHistoryMessage,
  ServerAskUserListRequest,
  ServerAskUserRankRequest,
  ServerAskUserFormRequest,
  ServerAskUserRequest,
  ServerError,
  ServerHello,
  ServerLocationRequest,
  ServerMaskRequest,
  ServerMessage,
  ServerResultMessage,
  MessageBlock,
  MessageSource,
  ServerMessageBlocks,
  ServerSessionHistory,
  ServerSessionInfo,
  ServerStatus,
  ServerTextDelta,
  ServerThinkingDelta,
  ServerToolApprovalRequest,
  ServerToolInputDelta,
  ServerToolResult,
  ServerToolUseComplete,
  ServerToolUseStart,
  ClientAskUserCancel,
  ClientAskUserListResponse,
  ClientAskUserRankResponse,
  ClientAskUserFormResponse,
  ClientAskUserResponse,
  ClientCancelRequest,
  ClientChatMessage,
  ClientEnvironment,
  ClientLocationError,
  ClientLocationResponse,
  ClientMaskError,
  ClientMaskResponse,
  ClientMessage,
  ClientSessionResume,
  ApprovalChannel,
  ClientToolApproval,
  ClientToolDenial,
  ClientActivitySubscribe,
  ClientActivityUnsubscribe,
  ClientLocalExchange,
  LocalAnswer,
  LocalExchange,
  ServerLocalExchangeResult,
  ActivitySpan,
  ActivitySpanEvent,
  ServerActivitySnapshot,
  ServerActivityDelta,
  ModelUsage,
  TurnFailure,
  TurnRetry,
  TurnUsage,
} from "./protocol.js";
import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  LOCAL_ANSWER_CLOSE,
  MAX_LOCAL_ANSWER_CHARS,
  MAX_LOCAL_CONTEXT_CHARS,
  MAX_LOCAL_EXCHANGES_PER_MESSAGE,
} from "./protocol.js";

// --- Boundary limits ---

/** Cap on one client→server WS frame (must fit a max-attachment chat message). */
export const MAX_CLIENT_FRAME_BYTES = 12_000_000;
/** Cap on a chat message's text (characters). */
export const MAX_PROMPT_CHARS = 200_000;
/** Cap on any short id (sessionId, toolUseId, requestId, turnId, providerId). */
const MAX_ID_CHARS = 256;
/** Cap on one ask-user answer / annotation value. */
const MAX_ANSWER_CHARS = 20_000;
/** Cap on entries in the ask-user answers/annotations records. */
const MAX_ANSWER_KEYS = 64;
/** Cap on entries in a tool-approval `updatedInput` object. */
const MAX_INPUT_KEYS = 256;
/** Cap on the serialized size of a tool-approval `updatedInput`. */
const MAX_INPUT_SERIALIZED_CHARS = 512_000;
/** Max JSON nesting depth accepted at the boundary. */
const MAX_JSON_DEPTH = 64;
/** base64 inflates ~4/3 over MAX_IMAGE_BYTES decoded bytes. */
const MAX_IMAGE_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8;

const id = z.string().min(1).max(MAX_ID_CHARS);

/** Decoded byte count of a base64 string (without decoding it). */
function decodedBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * Cardinality pre-check. A `.refine()` on a record runs AFTER every key and
 * value has been validated, so a 500k-key object burns hundreds of ms before
 * being rejected. This gate runs first and costs one Object.keys().
 */
function boundedRecord<T extends z.ZodTypeAny>(
  keySchema: z.ZodString,
  valueSchema: T,
  maxKeys: number,
  label: string
) {
  return z
    .custom<Record<string, unknown>>(
      (val) =>
        typeof val === "object" &&
        val !== null &&
        !Array.isArray(val) &&
        Object.keys(val).length <= maxKeys,
      { message: `${label} must be an object with at most ${maxKeys} entries` }
    )
    .pipe(z.record(keySchema, valueSchema));
}

/** Depth of a parsed JSON value; bails out as soon as `max` is exceeded. */
function exceedsDepth(value: unknown, max: number): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > max) return true;
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
    } else if (node !== null && typeof node === "object") {
      for (const child of Object.values(node as Record<string, unknown>)) {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return false;
}

// --- Client → Server frames ---

const chatImageAttachmentSchema = z
  .looseObject({
    // Canonical base64 only: no `data:` prefix (protocol.ts forbids it), no
    // stray characters, length a multiple of 4. A host that trusts
    // parseClientMessage must not have to re-check this itself.
    data: z
      .string()
      .min(1)
      .max(MAX_IMAGE_BASE64_CHARS)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, { message: "attachment data must be base64" })
      .refine((d) => d.length % 4 === 0, {
        message: "attachment data length must be a multiple of 4",
      }),
    mediaType: z.enum(ALLOWED_IMAGE_MEDIA_TYPES),
  })
  .refine((a) => decodedBase64Bytes(a.data) <= MAX_IMAGE_BYTES, {
    message: `image exceeds ${MAX_IMAGE_BYTES} decoded bytes`,
  });

/**
 * Is this a real BCP-47 tag / IANA zone, not merely tag-SHAPED?
 *
 * A character class is not enough here. These two values are the only
 * free-form strings that reach the agent's system prompt, and
 * `ignore-previous-instructions-now` is a perfectly well-formed sequence of
 * hyphen-separated ASCII — so the check has to be "does the platform's own
 * locale/timezone database accept this", which no instruction can satisfy.
 */
function isCanonicalLocale(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

function isKnownTimeZone(zone: string): boolean {
  try {
    // Throws RangeError for anything the ICU database doesn't know.
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Client-reported device capabilities.
 *
 * Every field is an enum, a boolean, a bounded integer, or a string the
 * platform itself recognizes — because this object is rendered into the
 * agent's system prompt, and anything that can open an authenticated socket
 * would otherwise be writing system-prompt text.
 *
 * Unknown keys are STRIPPED rather than rejected, per the additive-only
 * protocol contract at the top of this file: a newer client that adds a field
 * must degrade on an older server, not fail to send every message.
 */
export const clientEnvironmentSchema = z.object({
  formFactor: z.enum(["phone", "tablet", "desktop"]),
  standalone: z.boolean().optional(),
  touch: z.boolean().optional(),
  camera: z.boolean().optional(),
  microphone: z.boolean().optional(),
  geolocation: z.boolean().optional(),
  share: z.boolean().optional(),
  shareFiles: z.boolean().optional(),
  viewportWidth: z.number().int().min(1).max(20_000).optional(),
  /** BCP-47, validated against Intl (en, en-GB, zh-Hans-CN). */
  locale: z.string().max(35).refine(isCanonicalLocale, { message: "not a valid BCP-47 locale" }).optional(),
  /** IANA zone, validated against the ICU database (Europe/Berlin, UTC). */
  timeZone: z.string().max(64).refine(isKnownTimeZone, { message: "not a known IANA time zone" }).optional(),
}) satisfies z.ZodType<ClientEnvironment>;

export const clientHelloSchema = z.looseObject({
  type: z.literal("client_hello"),
  protocolRev: z.number(),
  capabilities: z.record(z.string(), z.boolean()).optional(),
}) satisfies z.ZodType<ClientHello>;

export const messageSourceSchema = z.enum([
  "typed",
  "voice-dictate",
  "voice-conversation",
]) satisfies z.ZodType<MessageSource>;

/**
 * `source` as a peer sends it. A value this build does not know reads as
 * absent (`typed`) rather than failing the frame: a newer client's source
 * must not cost its message, and a newer host's must not cost the history.
 */
const optionalMessageSource = messageSourceSchema.optional().catch(undefined);

/**
 * A locally answered command (#582). The id and the command are written into
 * the block the context travels in on the prompt, so both are restricted to
 * characters that cannot break out of it, and the context may not close it.
 */
export const localExchangeSchema = z.looseObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  command: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  prompt: z.string().min(1).max(200),
  answer: z.unknown().refine(
    (value) => {
      try {
        const json = JSON.stringify(value);
        return json !== undefined && json.length <= MAX_LOCAL_ANSWER_CHARS;
      } catch {
        return false; // circular / non-serializable
      }
    },
    { message: `answer must serialize to at most ${MAX_LOCAL_ANSWER_CHARS} chars` }
  ),
  context: z
    .string()
    .max(MAX_LOCAL_CONTEXT_CHARS)
    .refine((text) => !text.includes(LOCAL_ANSWER_CLOSE), {
      message: `context may not contain ${LOCAL_ANSWER_CLOSE}`,
    }),
}) satisfies z.ZodType<LocalExchange>;

export const clientLocalExchangeSchema = z.looseObject({
  type: z.literal("local_exchange"),
  sessionId: id,
  exchange: localExchangeSchema,
}) satisfies z.ZodType<ClientLocalExchange>;

export const clientChatMessageSchema = z
  .looseObject({
    type: z.literal("chat_message"),
    text: z.string().max(MAX_PROMPT_CHARS),
    sessionId: id.optional(),
    providerId: id.optional(),
    draftId: id.optional(),
    requestId: id.optional(),
    thinkingLevel: thinkingLevelSchema.optional(),
    attachments: z.array(chatImageAttachmentSchema).max(MAX_IMAGES_PER_MESSAGE).optional(),
    client: clientEnvironmentSchema.optional(),
    source: optionalMessageSource,
    localExchanges: z.array(localExchangeSchema).max(MAX_LOCAL_EXCHANGES_PER_MESSAGE).optional(),
  })
  .refine(
    (m) =>
      (m.attachments ?? []).reduce((sum, a) => sum + decodedBase64Bytes(a.data), 0) <=
      MAX_TOTAL_IMAGE_BYTES,
    { message: `attachments exceed ${MAX_TOTAL_IMAGE_BYTES} total decoded bytes` }
  ) satisfies z.ZodType<ClientChatMessage>;

const approvalChannelSchema = z.enum(["card", "voice"]) satisfies z.ZodType<ApprovalChannel>;

export const clientToolApprovalSchema = z.looseObject({
  type: z.literal("tool_approval"),
  toolUseId: id,
  // Forwarded verbatim into the backend's permission decision (and from
  // there into an agent SDK's serializer), so it must be bounded on every
  // axis: key length, cardinality, and total serialized size.
  updatedInput: boundedRecord(
    z.string().max(MAX_ANSWER_CHARS),
    z.unknown(),
    MAX_INPUT_KEYS,
    "updatedInput"
  )
    .refine(
      (val) => {
        try {
          return JSON.stringify(val).length <= MAX_INPUT_SERIALIZED_CHARS;
        } catch {
          return false; // circular / non-serializable
        }
      },
      { message: `updatedInput must serialize to at most ${MAX_INPUT_SERIALIZED_CHARS} chars` }
    )
    .optional(),
  always: z.boolean().optional(),
  channel: approvalChannelSchema.optional(),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientToolApproval>;

export const clientToolDenialSchema = z.looseObject({
  type: z.literal("tool_denial"),
  toolUseId: id,
  message: z.string().max(MAX_ANSWER_CHARS),
  channel: approvalChannelSchema.optional(),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientToolDenial>;

export const clientCancelSchema = z.looseObject({
  type: z.literal("cancel"),
  sessionId: id.optional(),
}) satisfies z.ZodType<ClientCancelRequest>;

export const clientSessionResumeSchema = z.looseObject({
  type: z.literal("session_resume"),
  sessionId: id,
}) satisfies z.ZodType<ClientSessionResume>;

const askUserAnnotationSchema = z.looseObject({
  preview: z.string().max(MAX_ANSWER_CHARS).optional(),
  notes: z.string().max(MAX_ANSWER_CHARS).optional(),
}) satisfies z.ZodType<AskUserAnnotation>;

export const clientAskUserResponseSchema = z.looseObject({
  type: z.literal("ask_user_response"),
  requestId: id,
  answers: boundedRecord(
    z.string().max(MAX_ANSWER_CHARS),
    z.string().max(MAX_ANSWER_CHARS),
    MAX_ANSWER_KEYS,
    "answers"
  ),
  annotations: boundedRecord(
    z.string().max(MAX_ANSWER_CHARS),
    askUserAnnotationSchema,
    MAX_ANSWER_KEYS,
    "annotations"
  ).optional(),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientAskUserResponse>;

export const clientAskUserCancelSchema = z.looseObject({
  type: z.literal("ask_user_cancel"),
  requestId: id,
  reason: z.string().max(MAX_ANSWER_CHARS).optional(),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientAskUserCancel>;

/**
 * The answers to an `ask_user_list_request`, keyed by item id. The tool caps a
 * list at 30 items, so 64 keys is the same bound `ask_user` uses with room to
 * spare; which ids and labels are real is the handler's check, against the
 * request it holds.
 */
export const clientAskUserListResponseSchema = z.looseObject({
  type: z.literal("ask_user_list_response"),
  requestId: id,
  answers: boundedRecord(
    z.string().max(MAX_ANSWER_CHARS),
    z.string().max(MAX_ANSWER_CHARS),
    MAX_ANSWER_KEYS,
    "answers"
  ),
  notes: boundedRecord(
    z.string().max(MAX_ANSWER_CHARS),
    z.string().max(MAX_ANSWER_CHARS),
    MAX_ANSWER_KEYS,
    "notes"
  ).optional(),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientAskUserListResponse>;


export const clientAskUserFormResponseSchema = z.looseObject({
  type: z.literal("ask_user_form_response"), requestId: id,
  answers: z.custom<AskUserFormAnswers>((value) => z.record(z.string().min(1).max(64), ASK_USER_FORM_ANSWER_SCHEMA).safeParse(value).success),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientAskUserFormResponse>;


export const clientAskUserRankResponseSchema = z.looseObject({
  type: z.literal("ask_user_rank_response"),
  requestId: id,
  order: z.array(z.string().min(1).max(64)).min(2).max(15),
  unchanged: z.boolean(),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientAskUserRankResponse>;


const geoCoordsSchema = z.looseObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative(),
  altitude: z.number().nullable().optional(),
  altitudeAccuracy: z.number().nullable().optional(),
  heading: z.number().nullable().optional(),
  speed: z.number().nullable().optional(),
});

export const clientLocationResponseSchema = z.looseObject({
  type: z.literal("location_response"),
  requestId: id,
  coords: geoCoordsSchema,
  // Epoch millis, bounded by the JS Date range so a backend formatting it
  // can't hit a RangeError.
  timestamp: z.number().int().min(0).max(8.64e15),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientLocationResponse>;

export const clientLocationErrorSchema = z.looseObject({
  type: z.literal("location_error"),
  requestId: id,
  code: z.number().int().min(0).max(3),
  message: z.string().max(MAX_ANSWER_CHARS),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientLocationError>;

/**
 * A mask is a PNG of the same dimensions as the image it covers. Bounded by the
 * same decoded-byte budget as a chat image: a mask is mostly flat colour and
 * compresses hard, so anything near this ceiling is not a mask.
 */
export const clientMaskResponseSchema = z.looseObject({
  type: z.literal("mask_response"),
  requestId: id,
  maskPng: z
    .string()
    .max(MAX_IMAGE_BASE64_CHARS)
    .refine((b64) => decodedBase64Bytes(b64) <= MAX_IMAGE_BYTES, {
      message: `mask exceeds ${MAX_IMAGE_BYTES} decoded bytes`,
    }),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientMaskResponse>;

export const clientMaskErrorSchema = z.looseObject({
  type: z.literal("mask_error"),
  requestId: id,
  code: z.enum(["cancelled", "failed"]),
  message: z.string().max(MAX_ANSWER_CHARS),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientMaskError>;

const activityView = z.enum(["index", "session", "run"]);

export const clientActivitySubscribeSchema = z.looseObject({
  type: z.literal("activity_subscribe"),
  view: activityView,
  sessionId: id.optional(),
  runId: id.optional(),
}) satisfies z.ZodType<ClientActivitySubscribe>;

export const clientActivityUnsubscribeSchema = z.looseObject({
  type: z.literal("activity_unsubscribe"),
  view: activityView,
  sessionId: id.optional(),
  runId: id.optional(),
}) satisfies z.ZodType<ClientActivityUnsubscribe>;

export const clientRetryTurnSchema = z.looseObject({ type: z.literal("retry_turn"), sessionId: id, failedTurnId: id, requestId: id }) satisfies z.ZodType<ClientRetryTurn>;
export const clientRetryStatusSchema = z.looseObject({ type: z.literal("retry_status"), sessionId: id, requestId: id }) satisfies z.ZodType<ClientRetryStatus>;

// --- Durable inbox submissions: a separate strict authority boundary ---

export const inboxViewSchema = z.enum(["queue", "actions"]) satisfies z.ZodType<InboxView>;
export const inboxQueueStatusSchema = z.enum(["scheduled", "ready", "claimed", "done", "blocked", "failed", "superseded", "expired", "dropped"]) satisfies z.ZodType<InboxQueueStatus>;
export const inboxActionStatusSchema = z.enum(["pending", "snoozed", "resolved", "dismissed", "expired", "dropped"]) satisfies z.ZodType<InboxActionStatus>;
export const inboxDismissReasonSchema = z.enum(["dont_ask_again", "wrong_call", "need_more_info", "no_longer_relevant"]) satisfies z.ZodType<InboxDismissReason>;
const inboxTime = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const inboxSeq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const inboxText = z.string().min(1).max(MAX_PROMPT_CHARS);
const inboxTargetPath = z.string().min(1).max(4096).refine((path) =>
  !/[\\\x00-\x1f\x7f]/.test(path) && !path.startsWith("/") && !/^[a-zA-Z]:/.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "Expected a canonical brain-relative target path"
);

// Tool-specific input is inert JSON. Deny authority fields even when nested
// inside it; arbitrary JSON must not become a second route around strictObject.
const inboxAuthorityKeys = new Set([
  "trust", "trustclass", "profile", "profileid", "providerid", "principal", "principalid",
  "allowedtools", "toolpolicy", "capability", "capabilities", "grant", "grants",
  "enforceallowedtools", "nograntsurface", "authority", "envelope",
]);
function isInboxOperationInput(input: Record<string, unknown>): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  const seen = new Set<object>();
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > MAX_JSON_DEPTH) return false;
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") { if (!Number.isFinite(value)) return false; continue; }
    if (typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) stack.push({ value: entry, depth: depth + 1 });
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
      for (const [key, entry] of Object.entries(value)) {
        if (inboxAuthorityKeys.has(key.replace(/[_-]/g, "").toLowerCase())) return false;
        stack.push({ value: entry, depth: depth + 1 });
      }
    }
  }
  return true;
}

export const inboxOperationSchema = z.strictObject({
  toolName: id,
  input: z.record(z.string(), z.unknown()).refine(isInboxOperationInput, "Expected authority-free JSON input"),
  targetPath: inboxTargetPath,
}) satisfies z.ZodType<InboxOperation>;
export const inboxWorkPayloadSchema = z.strictObject({
  instruction: inboxText,
  operation: inboxOperationSchema.optional(),
}) satisfies z.ZodType<InboxWorkPayload>;
const enqueueEffectSchema = z.strictObject({ kind: z.literal("enqueue"), payload: inboxWorkPayloadSchema });
const cancelBlockedEffectSchema = z.strictObject({ kind: z.literal("cancel_blocked") });
const snoozeEffectSchema = z.strictObject({ kind: z.literal("snooze") });
const dismissEffectSchema = z.strictObject({ kind: z.literal("dismiss"), reason: inboxDismissReasonSchema.optional() });
const writePolicyEffectSchema = z.strictObject({
  kind: z.literal("write_policy"),
  policy: z.strictObject({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(128), content: inboxText }),
});
const openSessionEffectSchema = z.strictObject({
  kind: z.literal("open_session"), seed: z.strictObject({ prompt: inboxText }),
});
/** All six data variants; this is NOT the schema for v1 execution. */
export const resolutionEffectSchema = z.discriminatedUnion("kind", [
  enqueueEffectSchema, cancelBlockedEffectSchema, snoozeEffectSchema, dismissEffectSchema,
  writePolicyEffectSchema, openSessionEffectSchema,
]) satisfies z.ZodType<ResolutionEffect>;
/** Use at creation/application in v1: deferred kinds fail validation. */
export const v1ResolutionEffectSchema = z.discriminatedUnion("kind", [
  enqueueEffectSchema, cancelBlockedEffectSchema, snoozeEffectSchema, dismissEffectSchema,
]) satisfies z.ZodType<V1ResolutionEffect>;
export const inboxOptionSchema = z.strictObject({ id, label: inboxText, effect: resolutionEffectSchema }) satisfies z.ZodType<InboxOption>;

// Compare exact JSON values, independent of object key order. An approved
// operation binds the entire input and target, rather than just a tool name.
function sameInboxInput(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, i) => sameInboxInput(value, right[i]));
  }
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every((key) => Object.hasOwn(right, key) && sameInboxInput((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/**
 * Validate v1 data against a server-owned set of exact permitted operations.
 * This does not mint authority or prove runtime containment. The server must
 * derive/revalidate that set for the principal and thread at each application.
 */
export function validateResolutionEffect(
  value: unknown, allowedOperations: readonly InboxOperation[]
): ParseFrameResult<V1ResolutionEffect> {
  const parsed = v1ResolutionEffectSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: "Invalid or unavailable v1 resolution effect" };
  const effect = parsed.data;
  if (effect.kind === "enqueue" && effect.payload.operation) {
    const operation = effect.payload.operation;
    if (!allowedOperations.some((allowed) => allowed.toolName === operation.toolName &&
      allowed.targetPath === operation.targetPath && sameInboxInput(allowed.input, operation.input))) {
      return { ok: false, error: "Requested operation is outside the thread envelope" };
    }
  }
  return { ok: true, message: effect };
}

export const clientInboxResolveSchema = z.strictObject({
  type: z.literal("inbox_resolve"), itemId: id, optionId: id, reason: inboxDismissReasonSchema.optional(),
}) satisfies z.ZodType<ClientInboxResolve>;
export const clientInboxSnoozeSchema = z.strictObject({ type: z.literal("inbox_snooze"), itemId: id }) satisfies z.ZodType<ClientInboxSnooze>;
export const clientInboxSubscribeSchema = z.strictObject({ type: z.literal("inbox_subscribe"), view: inboxViewSchema, threadId: id.optional() }) satisfies z.ZodType<ClientInboxSubscribe>;
export const clientInboxUnsubscribeSchema = z.strictObject({ type: z.literal("inbox_unsubscribe"), view: inboxViewSchema, threadId: id.optional() }) satisfies z.ZodType<ClientInboxUnsubscribe>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  clientRetryTurnSchema,
  clientRetryStatusSchema,
  clientHelloSchema,
  clientChatMessageSchema,
  clientToolApprovalSchema,
  clientToolDenialSchema,
  clientCancelSchema,
  clientSessionResumeSchema,
  clientAskUserResponseSchema,
  clientAskUserCancelSchema,
  clientAskUserListResponseSchema,
  clientAskUserRankResponseSchema,
  clientAskUserFormResponseSchema,
  clientLocationResponseSchema,
  clientLocationErrorSchema,
  clientMaskResponseSchema,
  clientMaskErrorSchema,
  clientActivitySubscribeSchema,
  clientActivityUnsubscribeSchema,
  clientLocalExchangeSchema,
  clientInboxResolveSchema, clientInboxSnoozeSchema, clientInboxSubscribeSchema, clientInboxUnsubscribeSchema,
]) satisfies z.ZodType<ClientMessage>;

// --- Boundary helper ---

/**
 * UTF-8 byte length, without `Buffer`.
 *
 * These parsers run on BOTH ends of the socket, and the client end is a
 * browser bundle: reaching for Node's `Buffer` here made `ui-react` fail to
 * compile the moment it imported the SDK client, which is the build telling us
 * a browser package had picked up a Node global. `TextEncoder` is in every
 * runtime this ships to.
 */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export type ParseFrameResult<T> =
  | { ok: true; message: T }
  | { ok: false; error: string };

/**
 * Parse + validate one inbound client frame. The single entry point a server
 * should feed raw WS data through: enforces the byte cap (BEFORE decoding
 * binary input to a string), JSON-decodes, and schema-validates. Never
 * throws. Servers should ALSO set a socket-level max payload so oversized
 * frames are dropped before they are materialized at all.
 */
export function parseClientMessage(
  raw: string | ArrayBufferView | ArrayBuffer
): ParseFrameResult<ClientMessage> {
  // Binary input: reject on raw byte length without decoding.
  if (typeof raw !== "string") {
    if (raw.byteLength > MAX_CLIENT_FRAME_BYTES) {
      return { ok: false, error: `Frame exceeds ${MAX_CLIENT_FRAME_BYTES} bytes` };
    }
  }
  const text =
    typeof raw === "string"
      ? raw
      : // ArrayBuffer or any view over one (Uint8Array, DataView, Buffer) —
        // decoding a view via toString() would stringify the byte list.
        new TextDecoder().decode(raw as unknown as ArrayBuffer);
  if (typeof raw === "string" && utf8ByteLength(text) > MAX_CLIENT_FRAME_BYTES) {
    return { ok: false, error: `Frame exceeds ${MAX_CLIENT_FRAME_BYTES} bytes` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "Frame is not valid JSON" };
  }
  // Bun's JSON.parse is iterative, so a 500k-deep document parses fine and
  // only explodes later when something re-serializes it (unknown keys are
  // RETAINED by looseObject, so depth survives the boundary).
  if (exceedsDepth(json, MAX_JSON_DEPTH)) {
    return { ok: false, error: `Frame nesting exceeds ${MAX_JSON_DEPTH} levels` };
  }
  const parsed = clientMessageSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    // The path can contain client-supplied record keys — truncate so an
    // oversized key can't be amplified back into the error frame.
    const where = first ? (first.path.join(".") || "(root)").slice(0, 120) : "";
    return {
      ok: false,
      error: `Invalid frame${first ? `: ${where} ${first.message}` : ""}`,
    };
  }
  return { ok: true, message: parsed.data as ClientMessage };
}

// ============================================================
// Server → client frames (W1)
//
// The other direction, added because "the server is the trusted peer" stops
// being the whole story the moment a second client exists, and because a
// client that CASTS its inbound frames cannot tell a protocol drift from a
// bug in its own rendering. The receiving policy is deliberately softer than
// the server's: a frame that fails validation is DROPPED and reported, never
// thrown, because the protocol is additive by contract and a client that
// hard-fails an unrecognised frame turns every additive server change into a
// breaking one.
//
// Same rules as above otherwise: `looseObject` so a newer peer's optional
// fields survive the boundary. `satisfies` checks assignability here; the
// compile-time equality test guards exact, recursive parity.
// ============================================================

/**
 * Cap on one server→client frame.
 *
 * Sized from the server's own history chunker (400 KB per chunk) with room
 * for the envelope and a large single tool result, NOT from the client frame
 * cap — the two directions carry different things. A `session_history` replay
 * is split precisely so no single frame approaches this.
 */
export const MAX_SERVER_FRAME_BYTES = 2_000_000;

// A discriminated union upstream, so it must be one here too: a flat object
// with three optional fields would accept `{ kind: "tool" }` with no index.
const messagePartSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("thinking"), text: z.string() }),
  z.looseObject({ kind: z.literal("text"), text: z.string() }),
  z.looseObject({ kind: z.literal("tool"), toolIndex: z.number() }),
]) satisfies z.ZodType<MessagePart>;

export const messageBlockSchema = z.looseObject({
  partIndex: z.number().int().min(0),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  block: BLOCK_SCHEMA,
  confidence: z.number().min(0).max(1),
}) satisfies z.ZodType<MessageBlock>;

const localAnswerSchema = z.looseObject({
  exchangeId: z.string().max(MAX_ID_CHARS),
  command: z.string().max(MAX_ID_CHARS),
  answer: z.unknown(),
}) satisfies z.ZodType<LocalAnswer>;

/**
 * A turn's provider failure (#575). Where it rides a frame it is caught to
 * `undefined` when unreadable: the frame is a turn's terminal, and dropping
 * it over an additive field would leave the turn hanging.
 */
const turnFailureSchema = z.looseObject({
  errorClass: z.string().max(MAX_ID_CHARS),
  status: z.number().int().optional(),
  message: z.string(),
  authAction: z.enum(["relogin", "check_account", "check_config"]).optional().catch(undefined),
}) satisfies z.ZodType<TurnFailure>;

const turnRetrySchema = z.looseObject({
  attempt: z.number().int().min(1),
  maxAttempts: z.number().int().min(1).optional(),
  delayMs: z.number().min(0).optional(),
  errorClass: z.string().max(MAX_ID_CHARS).optional(),
  status: z.number().int().optional(),
}) satisfies z.ZodType<TurnRetry>;

const historyMessageSchema = z.looseObject({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  thinking: z.string().optional(),
  toolCalls: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      input: z.record(z.string(), z.unknown()),
      output: z.string().optional(),
      isError: z.boolean().optional(),
    })
  ),
  parts: z.array(messagePartSchema).optional(),
  attachmentCount: z.number().optional(),
  blocks: z.array(messageBlockSchema).optional(),
  source: optionalMessageSource,
  // A replayed answer this build cannot read is dropped, not the history.
  thinkingLevel: thinkingLevelSchema.optional().catch(undefined),
  effectiveThinkingLevel: thinkingLevelSchema.optional().catch(undefined),
  localAnswer: localAnswerSchema.optional().catch(undefined),
  failure: turnFailureSchema.optional().catch(undefined),
  retryOfTurnId: id.optional().catch(undefined),
}) satisfies z.ZodType<SessionHistoryMessage>;

/** Every session-scoped frame carries these, both optional on the wire. */
const sessionScoped = {
  sessionId: z.string().max(MAX_ID_CHARS).optional(),
  turnId: z.string().max(MAX_ID_CHARS).optional(),
};

export const serverHelloSchema = z.looseObject({
  type: z.literal("server_hello"),
  protocolRev: z.number(),
  capabilities: z.record(z.string(), z.boolean()).optional(),
}) satisfies z.ZodType<ServerHello>;

export const serverTextDeltaSchema = z.looseObject({
  type: z.literal("text_delta"),
  text: z.string(),
  ...sessionScoped,
}) satisfies z.ZodType<ServerTextDelta>;

export const serverThinkingDeltaSchema = z.looseObject({
  type: z.literal("thinking_delta"),
  text: z.string(),
  ...sessionScoped,
}) satisfies z.ZodType<ServerThinkingDelta>;

export const serverToolUseStartSchema = z.looseObject({
  type: z.literal("tool_use_start"),
  toolUseId: z.string().max(MAX_ID_CHARS),
  toolName: z.string(),
  parentToolUseId: z.string().max(MAX_ID_CHARS).optional(),
  ...sessionScoped,
}) satisfies z.ZodType<ServerToolUseStart>;

export const serverToolInputDeltaSchema = z.looseObject({
  type: z.literal("tool_input_delta"),
  toolUseId: z.string().max(MAX_ID_CHARS),
  partialJson: z.string(),
  ...sessionScoped,
}) satisfies z.ZodType<ServerToolInputDelta>;

export const serverToolUseCompleteSchema = z.looseObject({
  type: z.literal("tool_use_complete"),
  toolUseId: z.string().max(MAX_ID_CHARS),
  toolName: z.string(),
  parentToolUseId: z.string().max(MAX_ID_CHARS).optional(),
  input: z.record(z.string(), z.unknown()),
  ...sessionScoped,
}) satisfies z.ZodType<ServerToolUseComplete>;

export const serverToolResultSchema = z.looseObject({
  type: z.literal("tool_result"),
  toolUseId: z.string().max(MAX_ID_CHARS),
  output: z.string(),
  isError: z.boolean(),
  ...sessionScoped,
}) satisfies z.ZodType<ServerToolResult>;

export const serverToolApprovalRequestSchema = z.looseObject({
  type: z.literal("tool_approval_request"),
  toolUseId: z.string().max(MAX_ID_CHARS),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  description: z.string().optional(),
  kind: z.enum(["tool", "command"]).optional(),
  rememberable: z.boolean().optional(),
  ...sessionScoped,
}) satisfies z.ZodType<ServerToolApprovalRequest>;

const modelUsageSchema = z.looseObject({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  costUsd: z.number().optional(),
}) satisfies z.ZodType<ModelUsage>;

const turnUsageSchema = modelUsageSchema.extend({
  perModel: z.record(z.string(), modelUsageSchema).optional(),
}) satisfies z.ZodType<TurnUsage>;

export const serverResultSchema = z.looseObject({
  type: z.literal("result"),
  sessionId: z.string().max(MAX_ID_CHARS),
  outcome: z.enum(["success", "error", "cancelled"]).optional(),
  // Absent means "unknown", 0 means "actually free" — so this must stay
  // optional rather than defaulting.
  costUsd: z.number().optional(),
  durationMs: z.number(),
  numTurns: z.number(),
  isError: z.boolean(),
  usage: turnUsageSchema.optional(),
  outcomeDetail: z.string().max(200).optional(),
  failure: turnFailureSchema.optional().catch(undefined),
  retryOfTurnId: id.optional().catch(undefined),
}) satisfies z.ZodType<ServerResultMessage>;

export const serverErrorSchema = z.looseObject({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
  requestId: id.optional(),
  failure: turnFailureSchema.optional().catch(undefined),
  ...sessionScoped,
}) satisfies z.ZodType<ServerError>;

export const serverStatusSchema = z.looseObject({
  type: z.literal("status"),
  status: z.enum(["thinking", "tool_executing", "idle", "cancelled", "queued"]),
  detail: z.string().optional(),
  retry: turnRetrySchema.optional().catch(undefined),
  activeSessionId: z.string().max(MAX_ID_CHARS).optional(),
  requestId: id.optional(),
  thinkingLevel: thinkingLevelSchema.optional().catch(undefined),
  effectiveThinkingLevel: thinkingLevelSchema.optional().catch(undefined),
  ...sessionScoped,
}) satisfies z.ZodType<ServerStatus>;

export const serverSessionInfoSchema = z.looseObject({
  type: z.literal("session_info"),
  sessionId: z.string().max(MAX_ID_CHARS),
  isNew: z.boolean(),
  providerId: z.string().max(MAX_ID_CHARS).optional(),
  backendId: z.string().max(MAX_ID_CHARS).optional(),
  draftId: z.string().max(MAX_ID_CHARS).optional(),
  requestId: id.optional(),
  thinkingLevel: thinkingLevelSchema.optional().catch(undefined),
  effectiveThinkingLevel: thinkingLevelSchema.optional().catch(undefined),
}) satisfies z.ZodType<ServerSessionInfo>;

export const serverSessionHistorySchema = z.looseObject({
  type: z.literal("session_history"),
  messages: z.array(historyMessageSchema),
  append: z.boolean().optional(),
  ...sessionScoped,
}) satisfies z.ZodType<ServerSessionHistory>;

export const serverAskUserRequestSchema = z.looseObject({
  type: z.literal("ask_user_request"),
  requestId: z.string().max(MAX_ID_CHARS),
  questions: z.array(
    z.looseObject({
      question: z.string(),
      header: z.string(),
      multiSelect: z.boolean(),
      options: z.array(
        z.looseObject({
          label: z.string(),
          description: z.string(),
          preview: z.string().optional(),
        })
      ),
    })
  ),
  ...sessionScoped,
}) satisfies z.ZodType<ServerAskUserRequest>;

export const serverAskUserListRequestSchema = z.looseObject({
  type: z.literal("ask_user_list_request"),
  requestId: z.string().max(MAX_ID_CHARS),
  prompt: z.string(),
  scale: z.array(
    z.looseObject({ label: z.string(), description: z.string().optional() })
  ),
  items: z.array(
    z.looseObject({
      id: z.string(),
      label: z.string(),
      detail: z.string().optional(),
      link: z.string().optional(),
    })
  ),
  allowSkip: z.boolean(),
  notes: z.boolean(),
  ...sessionScoped,
}) satisfies z.ZodType<ServerAskUserListRequest>;

export const serverAskUserFormRequestSchema = z.looseObject({
  type: z.literal("ask_user_form_request"), requestId: id,
  prompt: ASK_USER_FORM_INPUT_SCHEMA.shape.prompt,
  // Validate the known shape while preserving every nested additive field.
  nodes: z.custom<AskUserFormNode[]>((value) => ASK_USER_FORM_INPUT_SCHEMA.shape.nodes.safeParse(value).success),
  ...sessionScoped,
}) satisfies z.ZodType<ServerAskUserFormRequest>;

export const serverAskUserRankRequestSchema = z.looseObject({
  type: z.literal("ask_user_rank_request"),
  requestId: id,
  prompt: z.string().min(1).max(300),
  items: z.array(z.looseObject({ id: z.string().min(1).max(64), label: z.string().min(1).max(200), detail: z.string().max(200).optional(), link: z.string().max(2000).optional() })).min(2).max(15),
  cutoff: z.number().int().min(1).max(15).optional(),
  ...sessionScoped,
}) satisfies z.ZodType<ServerAskUserRankRequest>;


export const serverLocationRequestSchema = z.looseObject({
  type: z.literal("location_request"),
  requestId: z.string().max(MAX_ID_CHARS),
  options: z
    .looseObject({
      enableHighAccuracy: z.boolean().optional(),
      timeoutMs: z.number().optional(),
      maximumAgeMs: z.number().optional(),
    })
    .optional(),
  ...sessionScoped,
}) satisfies z.ZodType<ServerLocationRequest>;

export const serverMaskRequestSchema = z.looseObject({
  type: z.literal("mask_request"),
  requestId: z.string().max(MAX_ID_CHARS),
  imagePath: z.string(),
  instruction: z.string().optional(),
  ...sessionScoped,
}) satisfies z.ZodType<ServerMaskRequest>;

const activitySpanSchema = z.looseObject({
  spanId: id,
  runId: id,
  parentSpanId: id.optional(),
  name: z.string(),
  toolName: z.string().optional(),
  kind: z.enum(["turn", "tool", "subagent", "cron"]),
  origin: z.enum(["session", "cron", "autonomous"]),
  sessionId: id.optional(),
  jobName: z.string().optional(),
  principalId: id.optional(),
  startedAt: z.number(),
  waitUntil: z.number().optional(),
  endedAt: z.number().optional(),
  outcome: z.enum(["success", "error", "timeout", "cancelled", "denied", "interrupted"]).optional(),
  outcomeReason: z.string().optional(),
  usage: modelUsageSchema.extend({ model: z.string().optional() }).optional(),
  subagent: z
    .looseObject({
      type: z.string().optional(),
      description: z.string().optional(),
      summary: z.string().optional(),
      totalTokens: z.number().optional(),
    })
    .optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<ActivitySpan>;

const activitySpanEventSchema = z.looseObject({
  spanId: id,
  eventIndex: z.number(),
  ts: z.number(),
  eventType: z.string(),
  payload: z.unknown().optional(),
  truncated: z.boolean().optional(),
}) satisfies z.ZodType<ActivitySpanEvent>;

export const serverActivitySnapshotSchema = z.looseObject({
  type: z.literal("activity_snapshot"),
  view: activityView,
  sessionId: id.optional(),
  runId: id.optional(),
  spans: z.array(activitySpanSchema),
  events: z.array(activitySpanEventSchema),
  highWaterSeq: z.record(z.string(), z.number()),
  append: z.boolean().optional(),
}) satisfies z.ZodType<ServerActivitySnapshot>;

export const serverActivityDeltaSchema = z.looseObject({
  type: z.literal("activity_delta"),
  runId: id,
  seq: z.number(),
  span: activitySpanSchema.optional(),
  event: activitySpanEventSchema.optional(),
}) satisfies z.ZodType<ServerActivityDelta>;

export const serverMessageBlocksSchema = z.looseObject({
  type: z.literal("message_blocks"),
  sessionId: z.string().max(MAX_ID_CHARS),
  blocks: z.array(messageBlockSchema),
  turnId: z.string().max(MAX_ID_CHARS).optional(),
}) satisfies z.ZodType<ServerMessageBlocks>;

export const serverLocalExchangeResultSchema = z.looseObject({
  type: z.literal("local_exchange_result"),
  sessionId: z.string().max(MAX_ID_CHARS),
  exchangeId: z.string().max(MAX_ID_CHARS),
  saved: z.boolean(),
  reason: z.string().optional(),
  turnId: z.string().max(MAX_ID_CHARS).optional(),
}) satisfies z.ZodType<ServerLocalExchangeResult>;

export const serverRetryReceiptSchema = z.looseObject({ type: z.literal("retry_receipt"), ...sessionScoped, sessionId: id, requestId: id,
  state: z.enum(["accepted", "refused", "unknown"]), message: z.string().optional(), text: z.string().optional(),
  attachmentCount: z.number().int().min(0).optional(), source: optionalMessageSource,
  thinkingLevel: thinkingLevelSchema.optional().catch(undefined),
}) satisfies z.ZodType<ServerRetryReceipt>;

// Durable server projections preserve additive fields; they are display data,
// never fed to effect application without the strict submission validators.
const wireOperationSchema = inboxOperationSchema.loose().extend({ input: z.record(z.string(), z.unknown()) });
const wireWorkPayloadSchema = inboxWorkPayloadSchema.loose().extend({ operation: wireOperationSchema.optional() });
const wireEffectSchema = z.discriminatedUnion("kind", [
  enqueueEffectSchema.loose().extend({ payload: wireWorkPayloadSchema }),
  cancelBlockedEffectSchema.loose(), snoozeEffectSchema.loose(), dismissEffectSchema.loose(),
  writePolicyEffectSchema.loose().extend({ policy: writePolicyEffectSchema.shape.policy.loose() }),
  openSessionEffectSchema.loose().extend({ seed: openSessionEffectSchema.shape.seed.loose() }),
]);
export const inboxThreadSchema = z.looseObject({
  id, trustClass: z.enum(["trusted", "untrusted"]), source: z.enum(["share", "cli"]),
  status: z.enum(["open", "closed"]), stateMd: z.string().refine((text) => utf8ByteLength(text) <= 4096, "Projection exceeds 4096 bytes"),
  stakes: z.number().int().min(0).max(3), deadline: inboxTime.optional(), createdAt: inboxTime, lastSeenAt: inboxTime,
}) satisfies z.ZodType<InboxThread>;
export const inboxItemBaseSchema = z.looseObject({
  id, threadId: id, dedupKey: id, createdAt: inboxTime, updatedAt: inboxTime, expiresAt: inboxTime,
  waitUntil: inboxTime.optional(), version: z.number().int().min(1), runId: id.optional(),
}) satisfies z.ZodType<InboxItemBase>;
const queueItemSchema = inboxItemBaseSchema.extend({
  queue: z.literal("queue"), status: inboxQueueStatusSchema,
  attempts: z.number().int().min(0), maxAttempts: z.number().int().min(1),
  claimedAt: inboxTime.optional(), leaseUntil: inboxTime.optional(), blockedByItemId: id.optional(),
});
export const inboxQueueItemSchema = z.discriminatedUnion("type", [
  queueItemSchema.extend({ type: z.literal("triage"), payload: z.looseObject({ stagingId: id }) }),
  queueItemSchema.extend({ type: z.literal("execute"), payload: wireWorkPayloadSchema }),
  queueItemSchema.extend({ type: z.literal("cleanup_pending"), payload: z.looseObject({ stagingId: id }) }),
]) satisfies z.ZodType<InboxQueueItem>;
const wireOptionSchema = inboxOptionSchema.loose().extend({ effect: wireEffectSchema });
export const inboxActionItemSchema = inboxItemBaseSchema.extend({
  queue: z.literal("actions"), type: z.enum(["approve", "choose", "fyi"]), status: inboxActionStatusSchema,
  payload: z.looseObject({ title: inboxText, detail: z.string().max(MAX_PROMPT_CHARS) }), options: z.array(wireOptionSchema),
}).refine((item) => item.type !== "fyi" || item.options.length === 0, "FYIs cannot offer resolution options") satisfies z.ZodType<InboxActionItem>;
export const inboxItemSchema = z.discriminatedUnion("queue", [inboxQueueItemSchema, inboxActionItemSchema]) satisfies z.ZodType<InboxItem>;
const inboxChangeBaseSchema = z.looseObject({ changeId: inboxSeq, threadId: id, seq: z.number().int().min(1) });
export const inboxChangeSchema = z.discriminatedUnion("kind", [
  inboxChangeBaseSchema.extend({ kind: z.literal("upsert_thread"), thread: inboxThreadSchema }),
  inboxChangeBaseSchema.extend({ kind: z.literal("upsert_item"), itemId: id, item: inboxItemSchema }),
  inboxChangeBaseSchema.extend({ kind: z.literal("remove_item"), itemId: id }),
  inboxChangeBaseSchema.extend({ kind: z.literal("remove_thread") }),
]).refine((change) => change.kind === "upsert_thread" ? change.thread.id === change.threadId :
  change.kind === "upsert_item" ? change.item.id === change.itemId && change.item.threadId === change.threadId : true,
  "Change payload does not match its scope"
) satisfies z.ZodType<InboxChange>;
export const inboxSnapshotSchema = z.looseObject({
  type: z.literal("inbox_snapshot"), view: inboxViewSchema, threadId: id.optional(),
  threads: z.array(inboxThreadSchema), items: z.array(inboxItemSchema),
  highWaterSeq: z.record(z.string(), inboxSeq), cursor: inboxSeq, append: z.boolean().optional(),
}) satisfies z.ZodType<InboxSnapshot>;
export const inboxDeltaSchema = z.looseObject({ type: z.literal("inbox_delta"), view: inboxViewSchema, change: inboxChangeSchema }) satisfies z.ZodType<InboxDelta>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  serverRetryReceiptSchema,
  serverHelloSchema,
  serverTextDeltaSchema,
  serverThinkingDeltaSchema,
  serverToolUseStartSchema,
  serverToolInputDeltaSchema,
  serverToolUseCompleteSchema,
  serverToolResultSchema,
  serverToolApprovalRequestSchema,
  serverResultSchema,
  serverErrorSchema,
  serverStatusSchema,
  serverSessionInfoSchema,
  serverSessionHistorySchema,
  serverAskUserRequestSchema,
  serverAskUserListRequestSchema,
  serverAskUserRankRequestSchema,
  serverAskUserFormRequestSchema,
  serverLocationRequestSchema,
  serverMaskRequestSchema,
  serverActivitySnapshotSchema,
  serverActivityDeltaSchema,
  serverMessageBlocksSchema,
  serverLocalExchangeResultSchema,
  inboxSnapshotSchema, inboxDeltaSchema,
]) satisfies z.ZodType<ServerMessage>;

/**
 * Parse + validate one inbound SERVER frame. Never throws.
 *
 * A caller should treat `ok: false` as "ignore this frame and report it", not
 * as a fatal condition — see the section header.
 */
export function parseServerMessage(
  raw: string | ArrayBufferView | ArrayBuffer
): ParseFrameResult<ServerMessage> {
  if (typeof raw !== "string") {
    if (raw.byteLength > MAX_SERVER_FRAME_BYTES) {
      return { ok: false, error: `Frame exceeds ${MAX_SERVER_FRAME_BYTES} bytes` };
    }
  }
  const text =
    typeof raw === "string" ? raw : new TextDecoder().decode(raw as unknown as ArrayBuffer);
  if (typeof raw === "string" && utf8ByteLength(text) > MAX_SERVER_FRAME_BYTES) {
    return { ok: false, error: `Frame exceeds ${MAX_SERVER_FRAME_BYTES} bytes` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "Frame is not valid JSON" };
  }
  if (exceedsDepth(json, MAX_JSON_DEPTH)) {
    return { ok: false, error: `Frame nesting exceeds ${MAX_JSON_DEPTH} levels` };
  }
  const parsed = serverMessageSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");
    return {
      ok: false,
      error: path ? `${path}: ${issue?.message}` : (issue?.message ?? "Frame failed validation"),
    };
  }
  return { ok: true, message: parsed.data as ServerMessage };
}

/** Strict intake input never accepts authority, profile or target overrides. */
export const queueAddRequestSchema = z.strictObject({
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  title: z.string().optional(), text: z.string().optional(), url: z.string().optional(),
}) satisfies z.ZodType<QueueAddRequest>;
export const queueAddResultSchema = z.looseObject({
  queued: z.literal(true), created: z.boolean(), threadId: id, itemId: id, stagingId: id,
}) satisfies z.ZodType<QueueAddResult>;
