import { z } from "zod";
import type { Readable, Writable } from "node:stream";

// Internal protocol. A worker can propose inputs, never a decision or authority.
export const PI_PIPE_MAX_BYTES = 16 * 1024 * 1024;
const input = z.record(z.string(), z.unknown());
const id = z.number().int().positive();
const text = z.string();
const usageNumber = z.number().finite().nonnegative();
const content = z.array(z.object({ type: text }).passthrough().superRefine((part, ctx) => {
  if (part.type === "toolCall" && (typeof part.id !== "string" || typeof part.name !== "string"
    || !input.safeParse(part.arguments).success)) ctx.addIssue({ code: "custom", message: "Malformed transcript tool call" });
}));
const message = z.object({ role: text }).passthrough().superRefine((m, ctx) => {
  if (["assistant", "toolResult"].includes(m.role) && !content.safeParse(m.content).success
    || m.role === "user" && typeof m.content !== "string" && !content.safeParse(m.content).success) {
    ctx.addIssue({ code: "custom", message: "Malformed transcript content" });
  }
  if (m.role !== "assistant") return;
  if (typeof m.model !== "string" || !Array.isArray(m.content) || typeof m.stopReason !== "string") {
    ctx.addIssue({ code: "custom", message: "Malformed assistant message" });
  }
  const usage = z.object({ input: usageNumber, output: usageNumber, cacheRead: usageNumber,
    cacheWrite: usageNumber, totalTokens: usageNumber,
    cost: z.object({ input: usageNumber, output: usageNumber, cacheRead: usageNumber,
      cacheWrite: usageNumber, total: usageNumber }) }).safeParse(m.usage);
  if (!usage.success) ctx.addIssue({ code: "custom", message: "Malformed usage" });
});
const transcriptEntry = input.superRefine((entry, ctx) => {
  if (entry.type === "message" && !message.safeParse(entry.message).success) {
    ctx.addIssue({ code: "custom", message: "Malformed pi transcript message" });
  }
});
export const piWorkerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message_end"), message }),
  z.object({ type: z.literal("message_update"), assistantMessageEvent:
    z.object({ type: z.enum(["text_delta", "thinking_delta"]), delta: text }).passthrough() }),
  z.object({ type: z.literal("tool_execution_start"), toolCallId: text, toolName: text, args: input }),
  z.object({ type: z.literal("tool_execution_end"), toolCallId: text, toolName: text,
    result: z.object({ content: z.array(z.object({ type: text, text: text.optional() }).passthrough()), details: z.unknown().optional() }), isError: z.boolean() }),
  z.object({ type: z.literal("auto_retry_start"), attempt: id, maxAttempts: id, delayMs: usageNumber, errorMessage: text }),
]);
export const piWorkerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), sessionId: z.string().uuid(), model: input.optional(),
    thinkingLevel: text.optional(), levels: z.array(text), cost: usageNumber }).strict(),
  z.object({ type: z.literal("event"), event: piWorkerEvent }).strict(),
  z.object({ type: z.literal("rpc"), id, method: z.enum(["permission", "bridge", "apply", "readBase", "syncAuth"]),
    toolCallId: text, toolName: text, input }).strict(),
  z.object({ type: z.literal("snapshot"), entries: z.array(transcriptEntry) }).strict(),
  z.object({ type: z.literal("done"), cost: usageNumber, error: text.optional() }).strict(),
  z.object({ type: z.literal("error"), message: text }).strict(),
]);
export type PiWorkerMessage = z.infer<typeof piWorkerMessage>;

export function sendPipe(pipe: Pick<Writable, "write">, value: unknown): void {
  const line = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(line) > PI_PIPE_MAX_BYTES) throw new Error("Pi worker protocol payload exceeds its bound.");
  pipe.write(line);
}

/** Bound bytes before JSON parsing, including a sender that never sends LF. */
export async function* pipeMessages(pipe: Readable): AsyncGenerator<unknown> {
  let pending = Buffer.alloc(0);
  for await (const chunk of pipe) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let newline: number;
    while ((newline = pending.indexOf(10)) >= 0) {
      if (newline > PI_PIPE_MAX_BYTES) throw new Error("Pi worker protocol payload exceeds its bound.");
      const line = pending.subarray(0, newline).toString("utf8");
      pending = pending.subarray(newline + 1);
      yield JSON.parse(line);
    }
    if (pending.length > PI_PIPE_MAX_BYTES) throw new Error("Pi worker protocol payload exceeds its bound.");
  }
  if (pending.length) throw new Error("Pi worker protocol ended with a partial message.");
}
