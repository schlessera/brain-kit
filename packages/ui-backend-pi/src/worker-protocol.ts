import { BackendRequestError, textParts } from "@schlessera/brain-ui-sdk/server";
import { WORKER_SCRATCH } from "@schlessera/brain-ui-sdk/internal";
import { FIRST_PARTY_FAILURE_CLASSES, type StateRoomObservation } from "@schlessera/brain-ui-sdk/protocol";
import { z } from "zod";
import type { Readable, Writable } from "node:stream";
import { MAX_OUTPUT_BYTES } from "./tool-kit.js";

// Internal protocol. A worker can propose inputs, never a decision or authority.
export const PI_PIPE_MAX_BYTES = 16 * 1024 * 1024;
export const sessionReserveBytes = (payloadSize: number): number => Math.max(1024 * 1024, Math.ceil(payloadSize / 4));
/** The pi runtime state inside turn temp (settings, models and login): never promoted (#1655). */
export const PI_WORKER_STATE = `${WORKER_SCRATCH}/pi-state`;
/** Internal loss signal, distinct from cancellation, busy and caller refusal. */
export class PiInputSafetyUnavailableError extends Error {
  constructor(cause?:unknown) {
    super("Pi input collection is not qualified for this runtime configuration",{cause});
    this.name="PiInputSafetyUnavailableError";
  }
}
export class SessionTooLargeError extends BackendRequestError {
  readonly errorClass = FIRST_PARTY_FAILURE_CLASSES.session_too_large;
  constructor() {
    super("This conversation exceeds the pi worker session size limit. Continue in a new conversation.");
    this.name = "SessionTooLargeError";
  }
}

/** Use the exact UTF-8 wire size, including framing, before launching a worker. */
export function checkSessionSize(init: unknown): StateRoomObservation {
  const size = Buffer.byteLength(JSON.stringify(init) + "\n");
  const usedBytes = size + sessionReserveBytes(size);
  if (usedBytes > PI_PIPE_MAX_BYTES) throw new SessionTooLargeError();
  return { usedBytes, allowanceBytes: PI_PIPE_MAX_BYTES, observedAt: Date.now() };
}
const input = z.record(z.string(), z.unknown());
const id = z.number().int().positive();
const text = z.string();
const usageNumber = z.number().finite().nonnegative();
const content = z.array(z.object({ type: text }).passthrough().superRefine((part, ctx) => {
  if (part.type === "toolCall" && (typeof part.id !== "string" || typeof part.name !== "string"
    || !input.safeParse(part.arguments).success)) ctx.addIssue({ code: "custom", message: "Malformed transcript tool call" });
}));
const usage = z.object({ input: usageNumber, output: usageNumber, cacheRead: usageNumber,
  cacheWrite: usageNumber, totalTokens: usageNumber,
  cost: z.object({ input: usageNumber, output: usageNumber, cacheRead: usageNumber,
    cacheWrite: usageNumber, total: usageNumber }) });
const message = z.object({ role: text }).passthrough().superRefine((m, ctx) => {
  if (["assistant", "toolResult"].includes(m.role) && !content.safeParse(m.content).success
    || m.role === "user" && typeof m.content !== "string" && !content.safeParse(m.content).success) {
    ctx.addIssue({ code: "custom", message: "Malformed transcript content" });
  }
  if (m.role !== "assistant") return;
  if (typeof m.model !== "string" || !Array.isArray(m.content) || typeof m.stopReason !== "string") {
    ctx.addIssue({ code: "custom", message: "Malformed assistant message" });
  }
  if (!usage.safeParse(m.usage).success) ctx.addIssue({ code: "custom", message: "Malformed usage" });
});
const transcriptEntry = input.superRefine((entry, ctx) => {
  if (entry.type === "message" && !message.safeParse(entry.message).success) {
    ctx.addIssue({ code: "custom", message: "Malformed pi transcript message" });
  }
});
export const piWorkerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message_end"), message }),
  // A delta frame carries its text only: never the accumulated answer (#4853).
  z.object({ type: z.literal("message_update"), assistantMessageEvent:
    z.object({ type: z.enum(["text_delta", "thinking_delta"]), delta: text }).strict() }).strict(),
  z.object({ type: z.literal("tool_execution_start"), toolCallId: text, toolName: text, args: input }),
  z.object({ type: z.literal("tool_execution_end"), toolCallId: text, toolName: text,
    result: z.object({ content: z.array(z.object({ type: text, text: text.optional() }).passthrough()), details: z.unknown().optional() }), isError: z.boolean() }),
  z.object({ type: z.literal("auto_retry_start"), attempt: id, maxAttempts: id, delayMs: usageNumber, errorMessage: text }),
]);
export const piWorkerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt_prefix"), prefix: z.object({
    tools: z.string().regex(/^[a-f0-9]{64}$/).nullable(), system: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    model: z.string().regex(/^[a-f0-9]{64}$/).nullable(), thinking: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    gitStatusIncluded: z.boolean().nullable(), coverage: z.literal("assembled_inputs"),
  }).strict() }).strict(),
  z.object({ type: z.literal("startup_timing"), phase: z.enum(["worker_started", "resources", "session", "initialize"]), durationMs: usageNumber }).strict(),
  // `loadedExtensions`: what the worker's own loader loaded, extensions and
  // load errors, counted before the prompt (#2874). Absent is no evidence.
  z.object({ type: z.literal("ready"), sessionId: z.string().uuid(), append: z.string().optional(), model: input.optional(),
    thinkingLevel: text.optional(), levels: z.array(text), cost: usageNumber, loadedExtensions: z.number().int().nonnegative().optional() }).strict(),
  z.object({ type: z.literal("event"), event: piWorkerEvent }).strict(),
  z.object({ type: z.literal("rpc"), id, method: z.enum(["permission", "admission", "bridge", "apply", "readBase", "syncAuth", "lock", "unlock", "fileObservation", "safetyResult", "safetyUnavailable"]),
    toolCallId: text, toolName: text, input }).strict(),
  z.object({ type: z.literal("snapshot"), entries: z.array(transcriptEntry) }).strict(),
  // The entries appended since the transcript the host holds, which has `base` entries (#4856).
  z.object({ type: z.literal("transcript_append"), base: id, entries: z.array(transcriptEntry).min(1) }).strict(),
  z.object({ type: z.literal("done"), cost: usageNumber, error: text.optional() }).strict(),
  z.object({ type: z.literal("error"), message: text, errorClass: z.enum(["session_too_large","input_safety_unavailable"]).optional() }).strict(),
]);
export type PiWorkerMessage = z.infer<typeof piWorkerMessage>;

export const piOutputStatus=z.object({complete:z.boolean(),exitCode:z.number().int().optional(),stderr:z.boolean().optional(),truncated:z.boolean().optional()}).strict();
const searchStatus=z.object({decodingLoss:z.boolean().optional(),stdoutEmpty:z.boolean().optional(),exitCode:z.number().int(),stderr:z.boolean(),truncated:z.boolean(),framedOutput:z.string().optional(),visibleText:z.string().optional()}).strict();
/** Host-only observation. Never alter provider result content to encode status. */
export function safetyResultInput(tool:string,content:readonly {type:string;text?:unknown}[],complete=true,failed=false,details?:unknown): {output:string;segments?:string[];outputStatus:z.infer<typeof piOutputStatus>;failed?:true} {
 const segments=textParts(content),output=segments.join('\n');
 if(tool==='grep'){
  const status=searchStatus.safeParse(details&&typeof details==='object'?(details as Record<string,unknown>).search:undefined);
  const original=complete&&content.length===1&&content[0]?.type==='text'&&typeof content[0]?.text==='string';
  const framed=status.success?status.data.framedOutput:undefined;
  const rendered=framed?.replaceAll('\0','').trim();
  const bound=framed===undefined?output==='No matches.':status.success&&status.data.truncated?status.data.visibleText===output&&(output.length>MAX_OUTPUT_BYTES?framed.replaceAll('\0','').trimStart()===output.slice(0,MAX_OUTPUT_BYTES):rendered===output):rendered===output;
  const successful=bound&&status.success&&!status.data.decodingLoss&&!status.data.stderr&&!status.data.truncated&&
   (status.data.exitCode===0&&output.length>0&&output!=='No matches.'||status.data.exitCode===1&&status.data.stdoutEmpty===true&&output==='No matches.');
  const processStatus=status.success?{exitCode:status.data.exitCode,stderr:status.data.stderr,truncated:status.data.truncated}:{};
  return {...(failed?{failed:true as const}:{}),output:bound?(framed??output):output,segments,outputStatus:{...processStatus,complete:original&&successful}};
 }
 // Reference reads require every original segment; omission never proves a read.
 if(tool==='reference_read'&&(!complete||content.some(part=>part.type!=='text'||typeof part.text!=='string')))return {...(failed?{failed:true as const}:{}),output,outputStatus:{complete:false}};
 return {...(failed?{failed:true as const}:{}),output,segments,outputStatus:{complete}};

}

/** Writes one frame and returns its size on the pipe. */
export function sendPipe(pipe: Pick<Writable, "write">, value: unknown): number {
  const line = JSON.stringify(value) + "\n", bytes = Buffer.byteLength(line);
  if (bytes > PI_PIPE_MAX_BYTES) {
    const type = (value as { type?: string } | null)?.type;
    if (type === "snapshot" || type === "transcript_append") throw new SessionTooLargeError();
    throw new Error("Pi worker protocol payload exceeds its bound.");
  }
  pipe.write(line);
  return bytes;
}

/**
 * The transcript bound is the size a whole `snapshot` frame of it would have,
 * whichever frames carried it (#4856): these give that size for a whole list,
 * and what appending entries to a non-empty list adds to it.
 */
export const snapshotFrameBytes = (entries: readonly unknown[]): number => Buffer.byteLength(JSON.stringify({ type: "snapshot", entries }) + "\n");
export const appendedFrameBytes = (entries: readonly unknown[]): number =>
  entries.reduce<number>((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)) + 1, 0);

/** Bound bytes before JSON parsing, including a sender that never sends LF. */
export async function* pipeMessages(pipe: Readable): AsyncGenerator<unknown> {
  // The chunks of the line not yet completed: each chunk is searched once and
  // each line is joined once, so a large frame costs linear time (#4854).
  let parts: Buffer[] = [], pending = 0;
  for await (const received of pipe) {
    const chunk = Buffer.isBuffer(received) ? received : Buffer.from(received);
    let start = 0, newline: number;
    while ((newline = chunk.indexOf(10, start)) >= 0) {
      if (pending + newline - start > PI_PIPE_MAX_BYTES) throw new Error("Pi worker protocol payload exceeds its bound.");
      const tail = chunk.subarray(start, newline);
      const line = parts.length ? Buffer.concat([...parts, tail], pending + tail.length) : tail;
      parts = []; pending = 0; start = newline + 1;
      yield JSON.parse(line.toString("utf8"));
    }
    if (start < chunk.length) { parts.push(chunk.subarray(start)); pending += chunk.length - start; }
    if (pending > PI_PIPE_MAX_BYTES) throw new Error("Pi worker protocol payload exceeds its bound.");
  }
  if (pending) throw new Error("Pi worker protocol ended with a partial message.");
}
