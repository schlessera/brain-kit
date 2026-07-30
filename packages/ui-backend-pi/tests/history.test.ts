import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { normalizeMessages, getPiHistory, listPiSessions } from "../src/history";

describe("normalizeMessages (pure)", () => {
  test("threads tool results onto the assistant tool call and orders parts", () => {
    const messages = [
      { role: "user", content: "find my notes", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me search" },
          { type: "text", text: "Searching now." },
          { type: "toolCall", id: "tc1", name: "brain_search", arguments: { query: "notes" } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "m",
        usage: emptyUsage(),
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "brain_search",
        content: [{ type: "text", text: "2 results" }],
        isError: false,
        timestamp: 3,
      },
    ] as unknown as AgentMessage[];

    const out = normalizeMessages(messages);
    expect(out).toHaveLength(2);

    expect(out[0]).toEqual({ role: "user", content: "find my notes", toolCalls: [] });

    const assistant = out[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Searching now.");
    expect(assistant.thinking).toBe("let me search");
    expect(assistant.toolCalls).toEqual([
      { id: "tc1", name: "brain_search", input: { query: "notes" }, output: "2 results", isError: false },
    ]);
    expect(assistant.parts).toEqual([
      { kind: "thinking", text: "let me search" },
      { kind: "text", text: "Searching now." },
      { kind: "tool", toolIndex: 0 },
    ]);
  });

  test("counts image attachments on a user message", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", data: "abc", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    ] as unknown as AgentMessage[];
    const out = normalizeMessages(messages);
    expect(out[0].content).toBe("look at this");
    expect(out[0].attachmentCount).toBe(1);
  });

  test("skips non-conversation entries (compaction/branch summaries)", () => {
    const messages = [
      { role: "compactionSummary", summary: "...", tokensBefore: 10, timestamp: 1 },
      { role: "user", content: "hi", timestamp: 2 },
    ] as unknown as AgentMessage[];
    const out = normalizeMessages(messages);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });
});

describe("SessionManager-backed history", () => {
  let cwd: string;
  let sessionDir: string;
  let sessionId: string;

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-backend-cwd-"));
    sessionDir = join(cwd, ".endoxa-ui", "sessions");
    const sm = SessionManager.create(cwd, sessionDir);
    sessionId = sm.getSessionId();
    sm.appendMessage({ role: "user", content: "hello brain", timestamp: 1 } as never);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "m",
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: 2,
    } as never);
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("listPiSessions returns the created session", async () => {
    const sessions = await listPiSessions(cwd, sessionDir);
    expect(sessions.some((s) => s.id === sessionId)).toBe(true);
  });

  test("getPiHistory normalizes the active branch", async () => {
    const history = await getPiHistory(cwd, sessionId, sessionDir);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: "user", content: "hello brain" });
    expect(history[1]).toMatchObject({ role: "assistant", content: "hi there" });
  });

  test("getPiHistory returns [] for an unknown session", async () => {
    expect(await getPiHistory(cwd, "no-such-id", sessionDir)).toEqual([]);
  });
});

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
