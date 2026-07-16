import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createGeminiSessionStore } from "../src/session-store";

describe("Gemini session store", () => {
  let root: string;
  let sessionDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gemini-session-store-"));
    sessionDir = join(root, ".brainform-ui", "gemini-sessions");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("atomically saves raw contents and normalized history", async () => {
    const store = createGeminiSessionStore(sessionDir);
    const session = store.create({
      id: "session-1",
      model: "gemini-3.5-flash",
      providerId: "gemini",
      now: 100,
    });
    session.lastActiveAt = 200;
    session.title = "First prompt";
    session.contents.push(
      { role: "user", parts: [{ text: "First prompt" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: { id: "provider-call-1", name: "brain_search", args: { query: "x" } },
            thoughtSignature: "opaque-signature",
          },
        ],
      }
    );
    session.messages.push(
      { role: "user", content: "First prompt", toolCalls: [] },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "provider-call-1",
            name: "brain_search",
            input: { query: "x" },
            output: "Found it.",
            isError: false,
          },
        ],
        parts: [{ kind: "tool", toolIndex: 0 }],
      }
    );

    await store.save(session);

    expect(readdirSync(sessionDir)).toEqual(["session-1.json"]);
    expect(await store.load("session-1")).toEqual(session);
    expect(await store.getHistory("session-1")).toEqual(session.messages);
    expect(await store.listSessions()).toEqual([
      {
        id: "session-1",
        title: "First prompt",
        createdAt: 100,
        lastActiveAt: 200,
        totalCostUsd: 0,
        numTurns: 1,
      },
    ]);
  });

  test("returns empty results for unknown or unsafe ids", async () => {
    const store = createGeminiSessionStore(sessionDir);
    expect(await store.load("unknown")).toBeNull();
    expect(await store.load("../outside")).toBeNull();
    expect(await store.getHistory("../outside")).toEqual([]);
    expect(await store.listSessions()).toEqual([]);
  });

  test("sorts sessions by activity and counts user turns", async () => {
    const store = createGeminiSessionStore(sessionDir);
    const older = store.create({ id: "older", model: "m", now: 100 });
    older.lastActiveAt = 200;
    older.messages.push({ role: "user", content: "one", toolCalls: [] });
    await store.save(older);

    const newer = store.create({ id: "newer", model: "m", now: 300 });
    newer.lastActiveAt = 400;
    newer.messages.push(
      { role: "user", content: "one", toolCalls: [] },
      { role: "assistant", content: "reply", toolCalls: [] },
      { role: "user", content: "two", toolCalls: [] }
    );
    await store.save(newer);

    const listed = await store.listSessions();
    expect(listed.map((session) => session.id)).toEqual(["newer", "older"]);
    expect(listed.map((session) => session.numTurns)).toEqual([2, 1]);
  });
});
