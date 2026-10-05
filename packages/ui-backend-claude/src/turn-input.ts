import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatImageAttachment } from "@schlessera/brain-ui-sdk/server";

/**
 * The user input of one turn, as the stream the SDK pulls from (#1003).
 *
 * It yields the turn's own prompt first and then stays open, so a follow-up
 * pushed while the turn runs reaches the running CLI. Claude Code (measured on
 * 2.1.283 through the locked Agent SDK, `tests/follow-up-delivery.test.ts`)
 * queues such a message and hands it to the model at the next opportunity,
 * beside the next tool result, inside the same turn — the step that was
 * running is not interrupted. A message that arrives after the model's last
 * step instead runs as a continuation turn of the same process, which the
 * runner folds into this one.
 *
 * Every follow-up carries a uuid, and the CLI reports it back in
 * `command_lifecycle` frames: `queued` when it read the message, `started`
 * when a turn took it in, `completed` when that turn ended (before its
 * `result`). So at a `result`, a follow-up that has `started` belonged to the
 * turn that just ended, and one that has not will run as the continuation:
 * that result is not the turn's last. The stream ends on `close()`; after
 * that, `push()` refuses.
 */
export interface TurnInput {
  /** The stream handed to `query()`. Single use. */
  readonly messages: AsyncIterable<SDKUserMessage>;
  /** Queue a follow-up; false once the input has closed. */
  push(prompt: string, attachments?: ChatImageAttachment[]): boolean;
  /** Record a `command_lifecycle` frame for one of this turn's follow-ups. */
  observe(message: unknown): void;
  /**
   * Account for a `result`: follow-ups a turn has taken in are done with, and
   * the rest will run after it. `continues` is whether any remain;
   * `unacknowledged` is whether one of those has not been reported read yet.
   */
  settle(): { continues: boolean; unacknowledged: boolean };
  readonly closed: boolean;
  close(): void;
}

type FollowUpState = "pushed" | "queued" | "started";

export function createTurnInput(prompt: string | AsyncIterable<SDKUserMessage>): TurnInput {
  const queue: SDKUserMessage[] = [];
  const pending = new Map<string, FollowUpState>();
  let closed = false;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  async function* messages(): AsyncIterable<SDKUserMessage> {
    if (typeof prompt === "string") yield userMessage(prompt);
    else yield* prompt;
    while (true) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    messages: messages(),
    push(text, attachments) {
      if (closed) return false;
      const uuid = crypto.randomUUID();
      pending.set(uuid, "pushed");
      // `next`: handed over at the next opportunity, never interrupting the
      // step that is running (`now` would).
      queue.push({ ...userMessage(text, attachments), uuid, priority: "next" });
      notify();
      return true;
    },
    observe(message) {
      const frame = message as { type?: unknown; command_uuid?: unknown; state?: unknown };
      if (frame.type !== "command_lifecycle" || typeof frame.command_uuid !== "string") return;
      if (!pending.has(frame.command_uuid)) return;
      if (frame.state === "queued" || frame.state === "started") {
        // Never step back: `queued` cannot follow `started`.
        if (pending.get(frame.command_uuid) !== "started") pending.set(frame.command_uuid, frame.state);
      } else {
        // completed, cancelled or anything newer: the CLI is done with it.
        pending.delete(frame.command_uuid);
      }
    },
    settle() {
      for (const [uuid, state] of pending) if (state === "started") pending.delete(uuid);
      return {
        continues: pending.size > 0,
        unacknowledged: [...pending.values()].some((state) => state === "pushed"),
      };
    },
    get closed() {
      return closed;
    },
    close() {
      closed = true;
      notify();
    },
  };
}

/**
 * One user message: a text prompt, with any image attachments as content
 * blocks after it — the shape the SDK accepts for a multimodal turn.
 */
export function userMessage(text: string, attachments?: ChatImageAttachment[]): SDKUserMessage {
  if (!attachments?.length) {
    return { type: "user", parent_tool_use_id: null, message: { role: "user", content: text }, session_id: "" };
  }
  const content = [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...attachments.map((attachment) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: attachment.mediaType, data: attachment.data },
    })),
  ];
  return {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: content as SDKUserMessage["message"]["content"] },
    session_id: "",
  };
}
