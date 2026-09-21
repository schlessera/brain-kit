/**
 * The classification pass (D42): the timed client, the collector that
 * mirrors the client's parts, the store that keys blocks by part text, and
 * the pass itself. Every failure path resolves to "markdown stays" — the
 * progressive-enhancement rule is asserted, not assumed — including a
 * classifier that never answers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { ServerMessage, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client";
import {
  TurnTextCollector,
  attachMessageBlocks,
  createJevClient,
  createTurnClassifier,
  loadMessageBlocks,
  partHash,
  saveMessageBlocks,
  type JevClient,
} from "../src/classification/index";
import { createSilentObservability } from "../src/observability/index";

const COMPARISON = `| | Ithaca | Pylos |
|---|---|---|
| Days at sea | 0 | 4 |
| Host | Penelope | Nestor |`;

const GOOD_ANSWERS = {
  "p0c0.shape": { type: "choice", choice: "comparison", probabilities: { comparison: 0.9 }, confidence: 0.9 },
  "p0c0.recommended": { type: "choice", choice: "none", probabilities: { none: 0.9 }, confidence: 0.9 },
  "p0c0.criteria_first": { type: "noul", noul: 0.95 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const silentLog = createSilentObservability().logger("test");

describe("the timed client", () => {
  test("no key: enabled is false and classify answers no_key without a request", async () => {
    let calls = 0;
    const client = createJevClient({ apiKey: null, fetch: async () => { calls++; return jsonResponse({}); } });
    expect(client.enabled).toBe(false);
    const result = await client.classify({ model: "jev-latest", state: {}, questions: {} });
    expect(result.outcome).toBe("no_key");
    expect(calls).toBe(0);
  });

  test("a good answer parses; the request carries the bearer key and the body", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const client = createJevClient({
      apiKey: "k",
      fetch: async (url, init) => {
        seen = { url, init };
        return jsonResponse({ model: "jev-1.13.0", answers: GOOD_ANSWERS });
      },
    });
    const result = await client.classify({ model: "jev-latest", state: { p0c0: {} }, questions: {} });
    expect(result.outcome).toBe("answered");
    expect(result.answers).toEqual(GOOD_ANSWERS as never);
    expect(seen!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(seen!.init.body as string)).toEqual({ model: "jev-latest", state: { p0c0: {} }, questions: {} });
  });

  test("a classifier that never answers resolves as a timeout inside the budget", async () => {
    const client = createJevClient({
      apiKey: "k",
      timeoutMs: 40,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    const startedAt = Date.now();
    const result = await client.classify({ model: "jev-latest", state: {}, questions: {} });
    expect(result.outcome).toBe("timeout");
    expect(result.answers).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  test("429 retries once inside the budget, then gives up as rate_limited", async () => {
    let calls = 0;
    const client = createJevClient({
      apiKey: "k",
      fetch: async () => { calls++; return jsonResponse({ error: "slow down" }, 429); },
    });
    const result = await client.classify({ model: "jev-latest", state: {}, questions: {} });
    expect(result.outcome).toBe("rate_limited");
    expect(result.status).toBe(429);
    expect(calls).toBe(2);
  });

  test("a 429 followed by an answer is an answer", async () => {
    let calls = 0;
    const client = createJevClient({
      apiKey: "k",
      fetch: async () => (++calls === 1 ? jsonResponse({}, 529) : jsonResponse({ answers: GOOD_ANSWERS })),
    });
    expect((await client.classify({ model: "jev-latest", state: {}, questions: {} })).outcome).toBe("answered");
    expect(calls).toBe(2);
  });

  test("401, a malformed body, and a network error each resolve, never throw", async () => {
    const unauthorized = createJevClient({ apiKey: "k", fetch: async () => jsonResponse({}, 401) });
    expect((await unauthorized.classify({ model: "jev-latest", state: {}, questions: {} })).outcome).toBe("http_error");

    const malformed = createJevClient({ apiKey: "k", fetch: async () => new Response("not json", { status: 200 }) });
    expect((await malformed.classify({ model: "jev-latest", state: {}, questions: {} })).outcome).toBe("bad_response");

    const wrongShape = createJevClient({ apiKey: "k", fetch: async () => jsonResponse({ answers: { x: { type: "text" } } }) });
    expect((await wrongShape.classify({ model: "jev-latest", state: {}, questions: {} })).outcome).toBe("bad_response");

    const network = createJevClient({ apiKey: "k", fetch: async () => { throw new TypeError("fetch failed"); } });
    expect((await network.classify({ model: "jev-latest", state: {}, questions: {} })).outcome).toBe("network_error");
  });
});

describe("the text collector mirrors the client's parts", () => {
  const frame = (msg: Record<string, unknown>): ServerMessage =>
    ({ sessionId: "s", ...msg }) as unknown as ServerMessage;

  test("consecutive text deltas merge; thinking and tool calls split parts", () => {
    const collector = new TurnTextCollector();
    collector.observe(frame({ type: "text_delta", text: "Hel" }));
    collector.observe(frame({ type: "text_delta", text: "lo." }));
    collector.observe(frame({ type: "thinking_delta", text: "hmm" }));
    collector.observe(frame({ type: "text_delta", text: "Second." }));
    collector.observe(frame({ type: "tool_use_start", toolUseId: "t1", toolName: "Bash" }));
    collector.observe(frame({ type: "tool_result", toolUseId: "t1", output: "", isError: false }));
    collector.observe(frame({ type: "text_delta", text: "Third." }));
    collector.observe(frame({ type: "status", status: "idle" }));
    collector.observe(frame({ type: "text_delta", text: " Still third." }));
    expect(collector.textParts()).toEqual(["Hello.", "Second.", "Third. Still third."]);
  });

  test("a subagent's tool call does not split the parent's text, as the client ignores it", () => {
    const collector = new TurnTextCollector();
    collector.observe(frame({ type: "text_delta", text: "A" }));
    collector.observe(frame({ type: "tool_use_start", toolUseId: "t2", toolName: "Read", parentToolUseId: "agent-1" }));
    collector.observe(frame({ type: "text_delta", text: "B" }));
    expect(collector.textParts()).toEqual(["AB"]);
  });
});

describe("the blocks store and the history join", () => {
  let db: Database;
  let path: string;
  beforeEach(() => {
    path = join(tmpdir(), `blocks-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = createUiDb(path);
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  const block = { partIndex: 0, start: 0, end: 5, block: { kind: "quote" as const, quote: "Words." }, confidence: 0.9 };

  test("the key is the exact text: a differently laid-out part must not inherit spans", () => {
    expect(partHash("a b c")).toBe(partHash("a b c"));
    expect(partHash("**A:** 1\n**B:** 2")).not.toBe(partHash("**A:** 1 **B:** 2"));
    expect(partHash("a b c")).not.toBe(partHash("a b d"));
  });

  test("blocks round-trip, are re-validated on the way out, and an unknown row is empty", () => {
    saveMessageBlocks(db, "s1", "Words. And more.", [block]);
    expect(loadMessageBlocks(db, "s1", "Words. And more.")).toEqual([block]);
    expect(loadMessageBlocks(db, "s1", "Words.  And more.")).toEqual([]);
    expect(loadMessageBlocks(db, "s1", "Other text")).toEqual([]);
    expect(loadMessageBlocks(db, "s2", "Words. And more.")).toEqual([]);
    // A newer server's block kind this one cannot draw is dropped, not rendered blank.
    db.prepare("UPDATE message_blocks SET blocks = ? WHERE session_id = ?").run(
      JSON.stringify([block, { ...block, block: { kind: "hologram" } }]),
      "s1"
    );
    expect(loadMessageBlocks(db, "s1", "Words. And more.")).toEqual([block]);
  });

  test("history replay joins blocks per text part and renumbers by the replayed ordinal", () => {
    saveMessageBlocks(db, "s1", "Second part text.", [{ ...block, partIndex: 7 }]);
    const history: SessionHistoryMessage[] = [
      { role: "user", content: "hi", toolCalls: [] },
      {
        role: "assistant",
        content: "First. Second part text.",
        toolCalls: [{ id: "t", name: "Bash", input: {} }],
        parts: [
          { kind: "text", text: "First." },
          { kind: "tool", toolIndex: 0 },
          { kind: "text", text: "Second part text." },
        ],
      },
      { role: "assistant", content: "Plain.", toolCalls: [] },
    ];
    const joined = attachMessageBlocks(db, "s1", history);
    expect(joined[0]).toBe(history[0]);
    expect(joined[1]!.blocks).toEqual([{ ...block, partIndex: 1 }]);
    expect(joined[2]).toBe(history[2]);
    expect(joined[2]!.blocks).toBeUndefined();
  });

  test("a legacy message without parts is one text part", () => {
    saveMessageBlocks(db, "s1", "Plain.", [block]);
    const joined = attachMessageBlocks(db, "s1", [{ role: "assistant", content: "Plain.", toolCalls: [] }]);
    expect(joined[0]!.blocks).toEqual([block]);
  });
});

describe("the pass", () => {
  let db: Database;
  let path: string;
  beforeEach(() => {
    path = join(tmpdir(), `pass-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = createUiDb(path);
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  function classifier(jev: JevClient) {
    return createTurnClassifier({ jev, db: () => db, log: silentLog });
  }

  test("prose makes no call at all", async () => {
    let calls = 0;
    const jev: JevClient = { enabled: true, classify: async () => { calls++; return { outcome: "answered", answers: {}, durationMs: 1 }; } };
    expect(await classifier(jev).run("s", ["Only prose.", "More prose."])).toEqual([]);
    expect(calls).toBe(0);
  });

  test("a good answer yields anchored blocks and persists them for replay", async () => {
    const jev: JevClient = {
      enabled: true,
      classify: async (request) => {
        expect(Object.keys(request.state)).toEqual(["p0c0"]);
        return { outcome: "answered", answers: GOOD_ANSWERS as never, durationMs: 120 };
      },
    };
    const text = `Two ways home.\n\n${COMPARISON}\n\nPick one.`;
    const blocks = await classifier(jev).run("s", [text]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ partIndex: 0, confidence: 0.9, block: { kind: "comparison" } });
    expect(text.slice(blocks[0]!.start, blocks[0]!.end)).toBe(COMPARISON);
    expect(loadMessageBlocks(db, "s", text)).toEqual(blocks);
  });

  test("a timeout, an error, a low-confidence answer and a throwing client all leave the markdown", async () => {
    const text = `Intro.\n\n${COMPARISON}`;
    const timedOut: JevClient = { enabled: true, classify: async () => ({ outcome: "timeout", answers: null, durationMs: 1000 }) };
    expect(await classifier(timedOut).run("s", [text])).toEqual([]);
    const lowConfidence: JevClient = {
      enabled: true,
      classify: async () => ({
        outcome: "answered",
        answers: { "p0c0.shape": { type: "choice", choice: "comparison", probabilities: {}, confidence: 0.3 } },
        durationMs: 90,
      }),
    };
    expect(await classifier(lowConfidence).run("s", [text])).toEqual([]);
    const throwing: JevClient = { enabled: true, classify: async () => { throw new Error("boom"); } };
    expect(await classifier(throwing).run("s", [text])).toEqual([]);
    expect(loadMessageBlocks(db, "s", text)).toEqual([]);
  });

  test("without a key the pass does nothing, but persisted blocks still replay", async () => {
    const disabled: JevClient = { enabled: false, classify: async () => ({ outcome: "no_key", answers: null, durationMs: 0 }) };
    const c = classifier(disabled);
    expect(c.enabled).toBe(false);
    expect(await c.run("s", [COMPARISON])).toEqual([]);
    const block = { partIndex: 0, start: 0, end: 3, block: { kind: "quote" as const, quote: "W." }, confidence: 0.9 };
    saveMessageBlocks(db, "s", "old", [block]);
    expect(c.attach("s", [{ role: "assistant", content: "old", toolCalls: [] }])[0]!.blocks).toEqual([block]);
  });
});
