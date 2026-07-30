import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createTranscriptStore } from "../src/server/transcript-store";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "endoxa-transcripts-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("createTranscriptStore", () => {
  test("create → append → history round-trip", () => {
    const store = createTranscriptStore(tempDir());
    const id = store.create({ title: "Bookshelf planning" });

    store.append(id, { role: "user", content: "hello", toolCalls: [] });
    store.append(
      id,
      {
        role: "assistant",
        content: "hi!",
        toolCalls: [{ id: "t1", name: "brain_search", input: { q: "x" }, output: "[]" }],
        parts: [
          { kind: "text", text: "hi!" },
          { kind: "tool", toolIndex: 0 },
        ],
      },
      { costUsd: 0.012 }
    );

    const history = store.history(id);
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe("user");
    expect(history[1].toolCalls[0].name).toBe("brain_search");
    expect(history[1].parts?.[1]).toEqual({ kind: "tool", toolIndex: 0 });
  });

  test("list aggregates turns, cost, and recency ordering", () => {
    const store = createTranscriptStore(tempDir());
    const a = store.create({ title: "A" });
    const b = store.create({ title: "B" });

    store.append(a, { role: "user", content: "1", toolCalls: [] }, { costUsd: 0.01 });
    store.append(a, { role: "assistant", content: "r", toolCalls: [] }, { costUsd: 0.02 });
    store.append(b, { role: "user", content: "2", toolCalls: [] });

    const sessions = store.list();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe(b); // most recently active first
    const sessionA = sessions.find((s) => s.id === a)!;
    expect(sessionA.title).toBe("A");
    expect(sessionA.numTurns).toBe(1); // user messages count as turns
    expect(sessionA.totalCostUsd).toBeCloseTo(0.03);
  });

  test("append to unknown session throws", () => {
    const store = createTranscriptStore(tempDir());
    expect(() =>
      store.append("nope", { role: "user", content: "x", toolCalls: [] })
    ).toThrow(/Unknown transcript session/);
  });

  test("empty store lists nothing; unknown history is empty", () => {
    const store = createTranscriptStore(tempDir());
    expect(store.list()).toEqual([]);
    expect(store.history("missing")).toEqual([]);
  });
});
