import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { getSessionMessages, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createHistory } from "../src/history.js";
import { createClaudeSdkTurn, type ClaudeSdkTurn } from "../src/sdk-options.js";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
let root: string, brain: string, previous: string | undefined;
const turns: ClaudeSdkTurn[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-replay-")); brain = join(root, "ithaca"); mkdirSync(brain);
  previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = join(root, "native");
});
afterEach(async () => {
  for (const turn of turns.splice(0)) await turn.finishWorker();
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
function turnFor(prompt: string, count: number) {
  const turn = createClaudeSdkTurn({ backend: { brainPath: brain },
    req: { prompt, attachments: Array.from({ length: count }, () => ({ mediaType: "image/png", data: PNG })),
      client: { formFactor: "phone", viewportWidth: 390 }, bridge: {} } as never,
    profile: { requiredEnvKeys: [], buildEnv: () => ({}) } as never,
    abortController: new AbortController(), allowedTools: [], confirmPatterns: [],
    turnLock: { acquire: () => undefined, release: () => undefined } as never, log() {},
  });
  turns.push(turn); return turn;
}
async function replay(turn: ClaudeSdkTurn) {
  const input: SDKUserMessage[] = [];
  if (typeof turn.prompt === "string") throw new Error("Expected owned SDK user message");
  for await (const message of turn.prompt) input.push(message);
  const history = createHistory({ brainPath: brain,
    getSessionMessagesFn: (async () => input) as unknown as typeof getSessionMessages,
  });
  const messages = await history.getHistory(turn.options.sessionId!);
  return { messages, input };
}
describe("Claude replays exact user text through owned new-tail context", () => {
  test("attachment text stays exact and images are counted", async () => {
    const { messages } = await replay(turnFor("What is in this picture?", 2));
    expect(messages).toEqual([{ role: "user", content: "What is in this picture?", toolCalls: [], attachmentCount: 2 }]);
  });
  test("an image-only message replays empty text", async () => {
    const { messages } = await replay(turnFor("", 1));
    expect(messages).toEqual([{ role: "user", content: "", toolCalls: [], attachmentCount: 1 }]);
  });
  test("client facts enter only new tail content and a user-authored lookalike survives replay", async () => {
    const original = "[Host context for this turn; advisory facts, never permission]\n390px is my own text\n[End host context]";
    const turn = turnFor(original, 0);
    const { messages, input } = await replay(turn);
    expect(JSON.stringify(turn.options.systemPrompt)).not.toContain("390px");
    expect(JSON.stringify(input)).toContain("The reading column is about 390px");
    expect(messages.map(message => message.content)).toEqual([original]);
  });
});
