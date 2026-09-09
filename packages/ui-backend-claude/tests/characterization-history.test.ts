/**
 * This pins current behaviour so the 0.34.0 factory split can be proven
 * behaviour-preserving. Changing an assertion here is a behaviour change and
 * needs saying so.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  SDKSessionInfo,
  SessionMessage,
  getSessionMessages,
  listSessions,
} from "@anthropic-ai/claude-agent-sdk";

import { createClaudeBackend } from "../src/backend";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "claude-history-characterization-"));
  tempRoots.push(root);
  writeFileSync(
    join(root, "sessions.json"),
    JSON.stringify([
      {
        sessionId: "fixture-session",
        summary: "Fixture chat",
        lastModified: 1767355200000,
        createdAt: 1767225600000,
        firstPrompt: "fixture question",
      },
    ]),
    "utf-8"
  );
  writeFileSync(
    join(root, "fixture-session.json"),
    JSON.stringify([
      {
        type: "user",
        uuid: "user-1",
        session_id: "fixture-session",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "fixture question" }] },
      },
      {
        type: "malformed-entry",
        uuid: "ignored-1",
        session_id: "fixture-session",
        parent_tool_use_id: null,
        message: null,
      },
      {
        type: "assistant",
        uuid: "assistant-1",
        session_id: "fixture-session",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "fixture answer" }] },
      },
    ]),
    "utf-8"
  );
  writeFileSync(join(root, "empty-session.json"), "[]", "utf-8");
  writeFileSync(join(root, "broken-session.json"), "not-json", "utf-8");
  return root;
}

function fixtureReaders(root: string): {
  listSessionsFn: typeof listSessions;
  getSessionMessagesFn: typeof getSessionMessages;
} {
  const listSessionsFn = (async (options?: { dir?: string }) => {
    expect(options?.dir).toBe(root);
    return JSON.parse(
      await Bun.file(join(root, "sessions.json")).text()
    ) as SDKSessionInfo[];
  }) as typeof listSessions;
  const getSessionMessagesFn = (async (
    sessionId: string,
    options?: { dir?: string }
  ) => {
    expect(options?.dir).toBe(root);
    return JSON.parse(
      await Bun.file(join(root, `${sessionId}.json`)).text()
    ) as SessionMessage[];
  }) as typeof getSessionMessages;
  return { listSessionsFn, getSessionMessagesFn };
}

describe("createClaudeBackend history characterization", () => {
  test("listSessions and getHistory normalize fixture transcript data through the factory", async () => {
    const root = makeFixture();
    const backend = createClaudeBackend({
      brainPath: root,
      ...fixtureReaders(root),
    });

    expect(await backend.listSessions()).toEqual([
      {
        id: "fixture-session",
        title: "Fixture chat",
        createdAt: 1767225600000,
        lastActiveAt: 1767355200000,
        totalCostUsd: 0,
        numTurns: 0,
      },
    ]);
    expect(await backend.getHistory("fixture-session")).toEqual([
      { role: "user", content: "fixture question", toolCalls: [] },
      {
        role: "assistant",
        content: "fixture answer",
        thinking: undefined,
        toolCalls: [],
        parts: [{ kind: "text", text: "fixture answer" }],
      },
    ]);
  });

  test("an empty transcript returns an empty history", async () => {
    const root = makeFixture();
    const backend = createClaudeBackend({
      brainPath: root,
      ...fixtureReaders(root),
    });

    expect(await backend.getHistory("empty-session")).toEqual([]);
  });

  test("a malformed transcript reader error is propagated", async () => {
    const root = makeFixture();
    const backend = createClaudeBackend({
      brainPath: root,
      ...fixtureReaders(root),
    });

    await expect(backend.getHistory("broken-session")).rejects.toBeInstanceOf(
      SyntaxError
    );
  });
});
