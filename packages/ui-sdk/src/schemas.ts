// ============================================================
// Runtime wire-protocol schemas
//
// Both endpoints previously CAST parsed JSON to the protocol interfaces; these
// zod schemas make the boundary real: servers validate every inbound client
// frame. Each schema is bound to its protocol.ts interface via
// `satisfies z.ZodType<...>`, so the two can never drift without a compile
// error. (Server→client frames have no runtime schemas yet — the server is
// the trusted peer; clients ignore unknown frame types.)
//
// Validation policy (matches the additive-only protocol contract):
// - Unknown OBJECT KEYS are PRESERVED (z.looseObject) — a newer peer may add
//   optional fields and they must survive the boundary.
// - Unknown FRAME TYPES fail the union — receivers should treat that as
//   "ignore frame" (client) or "protocol error" (server), never as a crash.
// - Size limits are enforced here, at the boundary, not deep in handlers.
// ============================================================

import { z } from "zod";

import type {
  AskUserAnnotation,
  ClientAskUserCancel,
  ClientAskUserResponse,
  ClientCancelRequest,
  ClientChatMessage,
  ClientLocationError,
  ClientLocationResponse,
  ClientMessage,
  ClientSessionResume,
  ClientToolApproval,
  ClientToolDenial,
} from "./protocol";
import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
} from "./protocol";

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

export const clientChatMessageSchema = z
  .looseObject({
    type: z.literal("chat_message"),
    text: z.string().max(MAX_PROMPT_CHARS),
    sessionId: id.optional(),
    providerId: id.optional(),
    attachments: z.array(chatImageAttachmentSchema).max(MAX_IMAGES_PER_MESSAGE).optional(),
  })
  .refine(
    (m) =>
      (m.attachments ?? []).reduce((sum, a) => sum + decodedBase64Bytes(a.data), 0) <=
      MAX_TOTAL_IMAGE_BYTES,
    { message: `attachments exceed ${MAX_TOTAL_IMAGE_BYTES} total decoded bytes` }
  ) satisfies z.ZodType<ClientChatMessage>;

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
  turnId: id.optional(),
}) satisfies z.ZodType<ClientToolApproval>;

export const clientToolDenialSchema = z.looseObject({
  type: z.literal("tool_denial"),
  toolUseId: id,
  message: z.string().max(MAX_ANSWER_CHARS),
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

export const clientMessageSchema = z.discriminatedUnion("type", [
  clientChatMessageSchema,
  clientToolApprovalSchema,
  clientToolDenialSchema,
  clientCancelSchema,
  clientSessionResumeSchema,
  clientAskUserResponseSchema,
  clientAskUserCancelSchema,
  clientLocationResponseSchema,
  clientLocationErrorSchema,
]) satisfies z.ZodType<ClientMessage>;

// --- Boundary helper ---

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
export function parseClientMessage(raw: string | Buffer | ArrayBuffer): ParseFrameResult<ClientMessage> {
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
  if (typeof raw === "string" && Buffer.byteLength(text, "utf-8") > MAX_CLIENT_FRAME_BYTES) {
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
