/**
 * LiveConversationProvider — server side of the live-conversation seam
 * (#957). A provider opens one bidirectional voice session per conversation
 * epoch and reports normalized evidence; it never executes tools, decides
 * permissions or chooses what the agent is asked.
 *
 * The host, outside this seam, owns semantic commit, admission, the agent
 * backend and its permission bridge, cancellation, terminal state and the
 * mapping from a provider's advisory work requests to host identities. A
 * native work handle is an opaque correlation token the provider gets back
 * with a result; it is never execution authority.
 *
 * Separate from dictation: `SpeechProvider` / `AsrClient` keep their meaning.
 * Normative description: docs/integration-contract.md "Live conversation".
 */

import { z } from "zod";
import type {
  ConversationAudioFormat,
  ConversationCapabilities,
  ConversationDisclosure,
  ConversationInterval,
  ConversationWorkReceipt,
} from "../protocol.js";
import { CONVERSATION_CAPABILITY_KEYS, CONVERSATION_LIMITS } from "../protocol.js";
import {
  conversationAudioFormatSchema,
  conversationCapabilitiesSchema,
  conversationDisclosureSchema,
} from "../schemas.js";

/** @experimental Part of the `LiveConversationProvider` seam. */
export interface ConversationScope {
  /** Host-minted conversation identity. */
  conversationId: string;
  /** Host epoch; replaced on every reconnect or explicit restart. */
  epoch: number;
}

/**
 * Host identity of one admitted request, handed back with its result.
 * `nativeHandle` is the provider's own handle from `work_requested`, when the
 * host bound one; absent means the provider never asked for this work.
 *
 * @experimental Part of the `LiveConversationProvider` seam.
 */
export interface ConversationWorkRef extends ConversationScope {
  utteranceId: string;
  turnId: string;
  requestId: string;
  nativeHandle?: string;
}

/**
 * A bounded, host-reviewed result. `quiet` adds context without prompting
 * speech; `when-idle` lets the provider respond once it is not speaking.
 * Neither is a permission announcement.
 *
 * @experimental Part of the `LiveConversationProvider` seam.
 */
export interface ConversationWorkResult {
  outcome: "completed" | "error";
  facts: string;
  delivery: "quiet" | "when-idle";
}

/** @experimental Part of the `LiveConversationProvider` seam. */
export interface LiveConversationAudioChunk {
  utteranceId: string;
  sequence: number;
  pcm: Uint8Array;
  rate: number;
}

/**
 * The closed event family a provider session yields. Every event carries
 * its scope; the host ignores one whose scope is not the epoch it opened.
 * Evidence the provider lacks stays absent or `unknown`.
 *
 * @experimental Part of the `LiveConversationProvider` seam.
 */
export type LiveConversationEvent = ConversationScope &
  (
    | { kind: "ready"; model?: string; api?: string; input: ConversationAudioFormat; output: ConversationAudioFormat }
    | {
        kind: "input_fragment";
        utteranceId: string;
        sequence: number;
        text: string;
        interval?: ConversationInterval;
        finalization: "interim" | "final" | "unknown";
        certainty: "known" | "unknown";
        confidence?: number;
        origin: "user" | "assistant" | "unknown";
      }
    | { kind: "output_transcript"; outputId: string; sequence: number; text: string; interval?: ConversationInterval }
    | { kind: "audio"; outputId: string; sequence: number; format: ConversationAudioFormat; pcm: Uint8Array }
    | { kind: "interrupted"; outputId?: string }
    /** Advisory: the model asked for host work. Never runs anything by itself. */
    | { kind: "work_requested"; handle: string; utteranceId?: string }
    /** The model withdrew a request; a later result for it is discarded. */
    | { kind: "work_withdrawn"; handle: string; reason?: string }
    | { kind: "closed"; remote: "acknowledged" | "unknown" }
    | { kind: "error"; message: string }
  );

/**
 * What the host replays when it opens a later epoch: committed requests and
 * their host outcomes. Context only — the provider must not resubmit input,
 * re-run work or treat a receipt as a new request.
 *
 * @experimental Part of the `LiveConversationProvider` seam.
 */
export interface ConversationResync {
  work: readonly ConversationWorkReceipt[];
}

/** @experimental Part of the `LiveConversationProvider` seam. */
export interface LiveConversationOpenOptions {
  /** Aborted when the host ends this epoch. */
  signal: AbortSignal;
  resync: ConversationResync;
}

/**
 * One provider session for one epoch.
 *
 * @experimental Part of the `LiveConversationProvider` seam.
 */
export interface LiveConversationSession {
  events: AsyncIterable<LiveConversationEvent>;
  appendAudio(chunk: LiveConversationAudioChunk): void;
  markEndpoint(utteranceId: string): void;
  returnWork(ref: ConversationWorkRef, result: ConversationWorkResult): Promise<void>;
  /** Close the remote session; `unknown` when the provider cannot confirm it. */
  close(): Promise<{ remote: "acknowledged" | "unknown" }>;
}

/**
 * Opens live voice sessions for the host's conversation orchestration.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface LiveConversationProvider {
  id: string;
  capabilities: ConversationCapabilities;
  disclosure: ConversationDisclosure;
  open(scope: ConversationScope, options: LiveConversationOpenOptions): Promise<LiveConversationSession>;
}

/** Typed authoring helper (identity), matching the core define* convention. */
export function defineLiveConversationProvider(provider: LiveConversationProvider): LiveConversationProvider {
  return provider;
}

/**
 * Validate a by-value provider before the host registers it. Throws naming
 * the first problem; capabilities must cover every key with evidence values.
 */
export function assertLiveConversationProvider(provider: LiveConversationProvider): void {
  if (!provider || typeof provider !== "object" || typeof provider.id !== "string" ||
      !provider.id || provider.id !== provider.id.trim().toLowerCase()) {
    throw new Error("Invalid LiveConversationProvider: id must be a nonempty, trimmed, lowercase string.");
  }
  for (const key of CONVERSATION_CAPABILITY_KEYS) {
    const value = (provider.capabilities as Partial<ConversationCapabilities> | undefined)?.[key];
    if (!conversationCapabilitiesSchema.shape[key].safeParse(value).success) {
      throw new Error(`Invalid LiveConversationProvider "${provider.id}": capabilities.${key} must be "supported", "unsupported" or "unproven".`);
    }
  }
  if (!conversationDisclosureSchema.safeParse(provider.disclosure).success) {
    throw new Error(`Invalid LiveConversationProvider "${provider.id}": disclosure needs a voiceService and one to sixteen destinations.`);
  }
  if (typeof provider.open !== "function") {
    throw new Error(`Invalid LiveConversationProvider "${provider.id}": open must be a function.`);
  }
}

/** Assert a provider session exposes the operations the host calls. */
export function assertLiveConversationSession(session: LiveConversationSession): void {
  const invalid = (what: string): never => { throw new Error(`Invalid LiveConversationSession: ${what}.`); };
  if (!session || typeof session !== "object") invalid("expected an object");
  if (!session.events || typeof (session.events as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
    invalid("events must be an async iterable");
  }
  for (const method of ["appendAudio", "markEndpoint", "returnWork", "close"] as const) {
    if (typeof session[method] !== "function") invalid(`${method} must be a function`);
  }
}

const shortId = z.string().min(1).max(256);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const scope = { conversationId: shortId, epoch: z.number().int().min(1) };
const interval = z
  .object({ startMs: z.number().min(0), endMs: z.number().min(0) })
  .refine((i) => i.endMs >= i.startMs, { message: "endMs must not precede startMs" });
const text = z.string().max(CONVERSATION_LIMITS.maxFragmentChars);

const providerEventSchema = z.discriminatedUnion("kind", [
  z.object({ ...scope, kind: z.literal("ready"), model: z.string().max(256).optional(), api: z.string().max(256).optional(),
    input: conversationAudioFormatSchema, output: conversationAudioFormatSchema }),
  z.object({ ...scope, kind: z.literal("input_fragment"), utteranceId: shortId, sequence, text,
    interval: interval.optional(), finalization: z.enum(["interim", "final", "unknown"]),
    certainty: z.enum(["known", "unknown"]), confidence: z.number().min(0).max(1).optional(),
    origin: z.enum(["user", "assistant", "unknown"]) }),
  z.object({ ...scope, kind: z.literal("output_transcript"), outputId: shortId, sequence, text, interval: interval.optional() }),
  z.object({ ...scope, kind: z.literal("audio"), outputId: shortId, sequence, format: conversationAudioFormatSchema,
    pcm: z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= CONVERSATION_LIMITS.maxAudioChunkBytes && b.byteLength % 2 === 0, {
      message: `pcm must hold 1 to ${CONVERSATION_LIMITS.maxAudioChunkBytes} bytes of whole 16-bit samples`,
    }) }),
  z.object({ ...scope, kind: z.literal("interrupted"), outputId: shortId.optional() }),
  z.object({ ...scope, kind: z.literal("work_requested"), handle: shortId, utteranceId: shortId.optional() }),
  z.object({ ...scope, kind: z.literal("work_withdrawn"), handle: shortId, reason: z.string().max(500).optional() }),
  z.object({ ...scope, kind: z.literal("closed"), remote: z.enum(["acknowledged", "unknown"]) }),
  z.object({ ...scope, kind: z.literal("error"), message: z.string().max(500) }),
]);

/**
 * Runtime-validate one provider event. Unknown kinds, oversized text or audio,
 * and a confidence without `certainty: "known"` (or the reverse) are refused.
 * Never throws.
 */
export function parseLiveConversationEvent(
  value: unknown
): { ok: true; event: LiveConversationEvent } | { ok: false; error: string } {
  const parsed = providerEventSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".");
    return { ok: false, error: `Invalid conversation event${where ? ` at ${where}` : ""}: ${issue?.message ?? "failed validation"}` };
  }
  const event = parsed.data;
  if (event.kind === "input_fragment" && (event.certainty === "known") !== (event.confidence !== undefined)) {
    return { ok: false, error: "Invalid conversation event: confidence is present exactly when certainty is known" };
  }
  return { ok: true, event: event as LiveConversationEvent };
}
