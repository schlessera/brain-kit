import { describe, expect, test } from "bun:test";
import type {
  getSessionMessages as sdkGetSessionMessages,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClientEnvironment } from "@schlessera/brain-ui-sdk/server";

import { createHistory } from "../src/history.js";
import { createClaudeSdkTurn } from "../src/sdk-options.js";

/**
 * What the Claude backend replays as a user message's text, for a message
 * sent with attachments and with a client environment.
 *
 * ui-server joins what it keeps about a user message (how it was produced:
 * typed, dictated, spoken) onto the replayed message by the message's EXACT
 * text as the client sent it. These pin that the Claude backend replays that
 * text: the prompt the turn hands the SDK is folded back through the same
 * history reader the backend replays sessions with.
 */

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const CLIENT: ClientEnvironment = {
  formFactor: "phone",
  viewportWidth: 390,
  locale: "en-GB",
  timeZone: "Europe/Berlin",
};

function turnFor(prompt: string, attachments: unknown[]) {
  return createClaudeSdkTurn({
    backend: { brainPath: "/brain" } as never,
    req: {
      prompt,
      attachments,
      client: CLIENT,
      turnBudgetMs: 180_000,
      bridge: {},
    } as never,
    profile: { requiredEnvKeys: [], buildEnv: () => ({}) } as never,
    abortController: new AbortController(),
    allowedTools: [],
    confirmPatterns: [],
    turnLock: { acquire: () => undefined, release: () => undefined } as never,
    log: () => undefined,
  });
}

/** The user-message content the SDK would write to the transcript for this prompt. */
async function transcriptContent(prompt: string | AsyncIterable<SDKUserMessage>): Promise<unknown[]> {
  if (typeof prompt === "string") return [prompt];
  const contents: unknown[] = [];
  for await (const message of prompt) contents.push(message.message.content);
  return contents;
}

async function replayUserMessages(contents: unknown[]) {
  const transcript = contents.flatMap((content) => [
    { type: "user", uuid: crypto.randomUUID(), session_id: "sess", message: { content }, parent_tool_use_id: null },
    {
      type: "assistant",
      uuid: crypto.randomUUID(),
      session_id: "sess",
      message: { content: [{ type: "text", text: "Noted." }] },
      parent_tool_use_id: null,
    },
  ]) as unknown as SessionMessage[];
  const history = createHistory({
    brainPath: "/brain",
    getSessionMessagesFn: (async () => transcript) as unknown as typeof sdkGetSessionMessages,
  });
  const out = await history.getHistory("sess");
  return out.filter((message) => message.role === "user");
}

async function replayUserText(contents: unknown[]): Promise<string[]> {
  return (await replayUserMessages(contents)).map((message) => message.content);
}

describe("Claude replays a user message as the text the client sent", () => {
  test("with attachments: the text block replays verbatim and the images are counted, not merged in", async () => {
    const turn = turnFor("What is in this picture?", [
      { mediaType: "image/png", data: PNG_1PX },
      { mediaType: "image/png", data: PNG_1PX },
    ]);
    const contents = await transcriptContent(turn.prompt);
    expect(contents).toHaveLength(1);
    const messages = await replayUserMessages(contents);
    expect(messages.map((message) => message.content)).toEqual(["What is in this picture?"]);
    expect(messages[0]!.attachmentCount).toBe(2);
  });

  test("an image-only message replays as empty text", async () => {
    const turn = turnFor("", [{ mediaType: "image/png", data: PNG_1PX }]);
    const messages = await replayUserMessages(await transcriptContent(turn.prompt));
    expect(messages.map((message) => message.content)).toEqual([""]);
    expect(messages[0]!.attachmentCount).toBe(1);
  });

  test("the client environment goes to the system prompt, never into the message text", async () => {
    const turn = turnFor("Plan my week", []);
    expect(turn.prompt).toBe("Plan my week");
    const systemPrompt = turn.options.systemPrompt as { append?: string };
    // The environment reached the turn at all; otherwise the assertion above
    // proves nothing about where it went.
    expect(systemPrompt.append).toContain("390px");
    expect(await replayUserText(await transcriptContent(turn.prompt))).toEqual(["Plan my week"]);
  });
});
