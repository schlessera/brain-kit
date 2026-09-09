/**
 * This pins current behaviour so the 0.34.0 factory split can be proven
 * behaviour-preserving. Changing an assertion here is a behaviour change and
 * needs saying so.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createPiBackend } from "../src/backend";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): { root: string; sessionDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-history-characterization-"));
  tempRoots.push(root);
  const sessionDir = join(root, "sessions");
  mkdirSync(sessionDir, { recursive: true });

  const entries = [
    {
      type: "session",
      version: 3,
      id: "fixture-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: root,
    },
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-01-02T10:00:00.000Z",
      message: {
        role: "user",
        content: "fixture question",
        timestamp: 1767348000000,
      },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-01-02T12:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fixture answer" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "fixture-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1767355200000,
      },
    },
    {
      type: "session_info",
      id: "title-1",
      parentId: "assistant-1",
      timestamp: "2026-01-02T12:00:01.000Z",
      name: "Fixture chat",
    },
  ];
  const goodPath = join(sessionDir, "2026-01-01_fixture-session.jsonl");
  writeFileSync(
    goodPath,
    `${JSON.stringify(entries[0])}\nnot-json\n${entries
      .slice(1)
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf-8"
  );
  writeFileSync(
    join(sessionDir, "malformed.jsonl"),
    "not-json\n{broken\n",
    "utf-8"
  );
  return { root, sessionDir };
}

describe("createPiBackend history characterization", () => {
  test("listSessions and getHistory normalize a fixture directory and ignore malformed lines", async () => {
    const { root, sessionDir } = fixture();
    const backend = createPiBackend({ brainPath: root, sessionDir });

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
        toolCalls: [],
        parts: [{ kind: "text", text: "fixture answer" }],
      },
    ]);
  });

  test("empty and entirely malformed directories read as no sessions or history", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-history-empty-"));
    tempRoots.push(root);
    const sessionDir = join(root, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "broken.jsonl"), "not-json\n", "utf-8");
    const backend = createPiBackend({ brainPath: root, sessionDir });

    expect(await backend.listSessions()).toEqual([]);
    expect(await backend.getHistory("missing-session")).toEqual([]);
  });
});
