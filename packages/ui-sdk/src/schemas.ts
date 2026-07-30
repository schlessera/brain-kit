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
/** base64 inflates ~4/3 over MAX_IMAGE_BYTES decoded bytes. */
const MAX_IMAGE_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8;

const id = z.string().min(1).max(MAX_ID_CHARS);

/** Decoded byte count of a base64 string (without decoding it). */
function decodedBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

function recordSizeCheck(max: number) {
  return (val: Record<string, unknown>) => Object.keys(val).length <= max;
}

// --- Client → Server frames ---

const chatImageAttachmentSchema = z
  .looseObject({
    data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS),
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
  updatedInput: z.record(z.string(), z.unknown()).optional(),
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
  answers: z
    .record(z.string().max(MAX_ANSWER_CHARS), z.string().max(MAX_ANSWER_CHARS))
    .refine(recordSizeCheck(MAX_ANSWER_KEYS), {
      message: `answers must have at most ${MAX_ANSWER_KEYS} entries`,
    }),
  annotations: z
    .record(z.string().max(MAX_ANSWER_CHARS), askUserAnnotationSchema)
    .refine(recordSizeCheck(MAX_ANSWER_KEYS), {
      message: `annotations must have at most ${MAX_ANSWER_KEYS} entries`,
    })
    .optional(),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientAskUserResponse>;

export const clientAskUserCancelSchema = z.looseObject({
  type: z.literal("ask_user_cancel"),
  requestId: id,
  reason: z.string().max(MAX_ANSWER_CHARS).optional(),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientAskUserCancel>;

const geoCoordsSchema = z.looseObject({
  latitude: z.number(),
  longitude: z.number(),
  accuracy: z.number(),
  altitude: z.number().nullable().optional(),
  altitudeAccuracy: z.number().nullable().optional(),
  heading: z.number().nullable().optional(),
  speed: z.number().nullable().optional(),
});

export const clientLocationResponseSchema = z.looseObject({
  type: z.literal("location_response"),
  requestId: id,
  coords: geoCoordsSchema,
  timestamp: z.number(),
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
    const byteLength = raw instanceof ArrayBuffer ? raw.byteLength : raw.byteLength;
    if (byteLength > MAX_CLIENT_FRAME_BYTES) {
      return { ok: false, error: `Frame exceeds ${MAX_CLIENT_FRAME_BYTES} bytes` };
    }
  }
  const text =
    typeof raw === "string"
      ? raw
      : raw instanceof ArrayBuffer
        ? new TextDecoder().decode(raw)
        : raw.toString("utf-8");
  if (typeof raw === "string" && Buffer.byteLength(text, "utf-8") > MAX_CLIENT_FRAME_BYTES) {
    return { ok: false, error: `Frame exceeds ${MAX_CLIENT_FRAME_BYTES} bytes` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "Frame is not valid JSON" };
  }
  const parsed = clientMessageSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: `Invalid frame${first ? `: ${first.path.join(".") || "(root)"} ${first.message}` : ""}`,
    };
  }
  return { ok: true, message: parsed.data as ClientMessage };
}
