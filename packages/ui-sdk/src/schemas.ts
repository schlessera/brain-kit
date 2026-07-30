// ============================================================
// Runtime wire-protocol schemas
//
// Both endpoints previously CAST parsed JSON to the protocol interfaces; these
// zod schemas make the boundary real: servers validate every inbound client
// frame, clients may validate inbound server frames. Each schema is bound to
// its protocol.ts interface via `satisfies z.ZodType<...>`, so the two can
// never drift without a compile error.
//
// Validation policy (matches the additive-only protocol contract):
// - Unknown OBJECT KEYS pass through (z.object is non-strict) — a newer peer
//   may add optional fields.
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
import { ALLOWED_IMAGE_MEDIA_TYPES, MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES } from "./protocol";

// --- Boundary limits ---

/** Cap on one client→server WS frame (must fit a max-attachment chat message). */
export const MAX_CLIENT_FRAME_BYTES = 12_000_000;
/** Cap on a chat message's text (characters). */
export const MAX_PROMPT_CHARS = 200_000;
/** Cap on any short id (sessionId, toolUseId, requestId, turnId, providerId). */
const MAX_ID_CHARS = 256;
/** Cap on one ask-user answer / annotation value. */
const MAX_ANSWER_CHARS = 20_000;
/** base64 inflates ~4/3 over MAX_IMAGE_BYTES decoded bytes. */
const MAX_IMAGE_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8;

const id = z.string().min(1).max(MAX_ID_CHARS);

// --- Client → Server frames ---

const chatImageAttachmentSchema = z.object({
  data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS),
  mediaType: z.enum(ALLOWED_IMAGE_MEDIA_TYPES),
});

export const clientChatMessageSchema = z.object({
  type: z.literal("chat_message"),
  text: z.string().max(MAX_PROMPT_CHARS),
  sessionId: id.optional(),
  providerId: id.optional(),
  attachments: z.array(chatImageAttachmentSchema).max(MAX_IMAGES_PER_MESSAGE).optional(),
}) satisfies z.ZodType<ClientChatMessage>;

export const clientToolApprovalSchema = z.object({
  type: z.literal("tool_approval"),
  toolUseId: id,
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientToolApproval>;

export const clientToolDenialSchema = z.object({
  type: z.literal("tool_denial"),
  toolUseId: id,
  message: z.string().max(MAX_ANSWER_CHARS),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientToolDenial>;

export const clientCancelSchema = z.object({
  type: z.literal("cancel"),
  sessionId: id.optional(),
}) satisfies z.ZodType<ClientCancelRequest>;

export const clientSessionResumeSchema = z.object({
  type: z.literal("session_resume"),
  sessionId: id,
}) satisfies z.ZodType<ClientSessionResume>;

const askUserAnnotationSchema = z.object({
  preview: z.string().max(MAX_ANSWER_CHARS).optional(),
  notes: z.string().max(MAX_ANSWER_CHARS).optional(),
}) satisfies z.ZodType<AskUserAnnotation>;

export const clientAskUserResponseSchema = z.object({
  type: z.literal("ask_user_response"),
  requestId: id,
  answers: z.record(z.string().max(MAX_ANSWER_CHARS), z.string().max(MAX_ANSWER_CHARS)),
  annotations: z.record(z.string().max(MAX_ANSWER_CHARS), askUserAnnotationSchema).optional(),
  turnId: id.optional(),
}) satisfies z.ZodType<ClientAskUserResponse>;

export const clientAskUserCancelSchema = z.object({
  type: z.literal("ask_user_cancel"),
  requestId: id,
  reason: z.string().max(MAX_ANSWER_CHARS).optional(),
}) satisfies z.ZodType<ClientAskUserCancel>;

const geoCoordsSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  accuracy: z.number(),
  altitude: z.number().nullable().optional(),
  altitudeAccuracy: z.number().nullable().optional(),
  heading: z.number().nullable().optional(),
  speed: z.number().nullable().optional(),
});

export const clientLocationResponseSchema = z.object({
  type: z.literal("location_response"),
  requestId: id,
  coords: geoCoordsSchema,
  timestamp: z.number(),
}) satisfies z.ZodType<ClientLocationResponse>;

export const clientLocationErrorSchema = z.object({
  type: z.literal("location_error"),
  requestId: id,
  code: z.number().int().min(0).max(3),
  message: z.string().max(MAX_ANSWER_CHARS),
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
 * should feed raw WS data through: enforces the byte cap, JSON-decodes, and
 * schema-validates. Never throws.
 */
export function parseClientMessage(raw: string | Buffer | ArrayBuffer): ParseFrameResult<ClientMessage> {
  const text =
    typeof raw === "string"
      ? raw
      : raw instanceof ArrayBuffer
        ? new TextDecoder().decode(raw)
        : raw.toString("utf-8");
  if (Buffer.byteLength(text, "utf-8") > MAX_CLIENT_FRAME_BYTES) {
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
  return { ok: true, message: parsed.data };
}
