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
import { CONFIDENCE, planClassification, questionsFor } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client";
import {
  CONFIDENCE_RETENTION_MS,
  JEV_ENDPOINT,
  JEV_TIMEOUT_MS,
  TurnTextCollector,
  attachMessageBlocks,
  confidenceDistribution,
  createJevClient,
  createTurnClassifier,
  loadMessageBlocks,
  partHash,
  recordQuestionConfidence,
  saveMessageBlocks,
  type JevClient,
} from "../src/classification/index";
import { createSilentObservability } from "../src/observability/index";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { WsHost } from "../src/ws/host";
import { runSession } from "../src/ws/run-session";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";

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
    // A request the pass really builds, so the body carries real questions:
    // a hand-built one with `questions: {}` asserted nothing about them (#192).
    const plan = planClassification([COMPARISON]);
    // Asked of the catalogue afresh, so nothing the strip or the client does
    // to the plan's objects in place can move the expectation with it.
    const asked = questionsFor(plan!.candidates[0]!.candidate);
    const result = await client.classify(plan!.request);
    expect(result.outcome).toBe("answered");
    expect(result.answers).toEqual(GOOD_ANSWERS as never);
    expect(seen!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer k");

    const body = JSON.parse(seen!.init.body as string);
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body.model).toBe("jev-latest");
    expect(body.state).toEqual({
      p0c0: {
        kind: "table",
        headers: ["", "Ithaca", "Pylos"],
        rows: [
          ["Days at sea", "0", "4"],
          ["Host", "Penelope", "Nestor"],
        ],
      },
    });
    // Non-empty, and exactly the table's questions, so the map cannot become
    // empty again without this failing.
    expect(Object.keys(body.questions)).toEqual(["p0c0.shape", "p0c0.recommended", "p0c0.criteria_first"]);
    // Each question goes out as the catalogue wrote it, minus the line its
    // answer has to clear: where the surface acts on a probability is not the
    // classifier's business (D42 §1). Built here from the catalogue's own
    // questions, so the strip is checked against an expectation that shares
    // neither its code nor its objects.
    for (const [id, question] of Object.entries(asked)) {
      const { type, instructions } = question;
      const criteria = "criteria" in question ? question.criteria : undefined;
      expect(body.questions[id]).toEqual({ type, instructions, ...(criteria ? { criteria } : {}) });
    }
    // Nowhere in the body, as a key: the word itself may appear in text.
    const keys: string[] = [];
    JSON.parse(seen!.init.body as string, (key, value) => (keys.push(key), value));
    expect(keys).not.toContain("threshold");
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

describe("the breaker", () => {
  const req = { model: "jev-latest", state: {}, questions: {} };

  function failingClient(clock: { t: number }, log?: { emit: (e: unknown) => void }) {
    let calls = 0;
    const client = createJevClient({
      apiKey: "k",
      now: () => clock.t,
      fetch: async () => { calls++; throw new TypeError("fetch failed"); },
      log: log as never,
    });
    return { client, calls: () => calls };
  }

  test("three consecutive failures open it; the next calls are skipped without a request", async () => {
    const clock = { t: 1_000_000 };
    const { client, calls } = failingClient(clock);
    for (let i = 0; i < 3; i++) expect((await client.classify(req)).outcome).toBe("network_error");
    expect(client.breaker()).toEqual({ open: true, consecutiveFailures: 3, retryAt: clock.t + 30_000 });
    expect((await client.classify(req)).outcome).toBe("circuit_open");
    expect((await client.classify(req)).outcome).toBe("circuit_open");
    expect(calls()).toBe(3);
  });

  test("after the backoff one probe goes through; a failed probe doubles the wait, up to the cap", async () => {
    const clock = { t: 1_000_000 };
    const { client, calls } = failingClient(clock);
    for (let i = 0; i < 3; i++) await client.classify(req);
    clock.t += 30_000;
    expect((await client.classify(req)).outcome).toBe("network_error");
    expect(calls()).toBe(4);
    expect(client.breaker().retryAt).toBe(clock.t + 60_000);
    expect((await client.classify(req)).outcome).toBe("circuit_open");
    clock.t += 60_000;
    await client.classify(req);
    expect(client.breaker().retryAt).toBe(clock.t + 120_000);
    // Doubling stops at the cap.
    for (let i = 0; i < 12; i++) {
      clock.t = client.breaker().retryAt!;
      await client.classify(req);
    }
    expect(client.breaker().retryAt! - clock.t).toBe(30 * 60_000);
  });

  test("a successful probe closes it and resets the backoff", async () => {
    const clock = { t: 1_000_000 };
    let fail = true;
    const client = createJevClient({
      apiKey: "k",
      now: () => clock.t,
      fetch: async () => { if (fail) throw new TypeError("down"); return jsonResponse({ answers: GOOD_ANSWERS }); },
    });
    for (let i = 0; i < 3; i++) await client.classify(req);
    expect(client.breaker().open).toBe(true);
    clock.t += 30_000;
    fail = false;
    expect((await client.classify(req)).outcome).toBe("answered");
    expect(client.breaker()).toEqual({ open: false, consecutiveFailures: 0, retryAt: null });
    // Back at the base: three fresh failures wait 30 s again, not the doubled figure.
    fail = true;
    for (let i = 0; i < 3; i++) await client.classify(req);
    expect(client.breaker().retryAt).toBe(clock.t + 30_000);
  });

  test("timeouts, rate limits and bad responses count; a missing key does not", async () => {
    const clock = { t: 0 };
    const rateLimited = createJevClient({ apiKey: "k", now: () => clock.t, fetch: async () => jsonResponse({}, 429) });
    for (let i = 0; i < 3; i++) expect((await rateLimited.classify(req)).outcome).toBe("rate_limited");
    expect(rateLimited.breaker().open).toBe(true);

    const noKey = createJevClient({ apiKey: null, now: () => clock.t, fetch: async () => jsonResponse({}) });
    for (let i = 0; i < 5; i++) await noKey.classify(req);
    expect(noKey.breaker().open).toBe(false);
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

  function classifier(jev: Omit<JevClient, "breaker">) {
    return createTurnClassifier({
      jev: { breaker: () => ({ open: false, consecutiveFailures: 0, retryAt: null }), ...jev },
      db: () => db,
      log: silentLog,
    });
  }

  test("prose makes no call at all", async () => {
    let calls = 0;
    const jev = { enabled: true, classify: async () => { calls++; return { outcome: "answered" as const, answers: {}, durationMs: 1 }; } };
    expect(await classifier(jev).run("s", ["Only prose.", "More prose."])).toEqual([]);
    expect(calls).toBe(0);
  });

  test("a good answer yields anchored blocks and persists them for replay", async () => {
    const jev: Omit<JevClient, "breaker"> = {
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
    const timedOut: Omit<JevClient, "breaker"> = { enabled: true, classify: async () => ({ outcome: "timeout", answers: null, durationMs: 1000 }) };
    expect(await classifier(timedOut).run("s", [text])).toEqual([]);
    const lowConfidence: Omit<JevClient, "breaker"> = {
      enabled: true,
      classify: async () => ({
        outcome: "answered",
        answers: { "p0c0.shape": { type: "choice", choice: "comparison", probabilities: {}, confidence: 0.3 } },
        durationMs: 90,
      }),
    };
    expect(await classifier(lowConfidence).run("s", [text])).toEqual([]);
    const throwing: Omit<JevClient, "breaker"> = { enabled: true, classify: async () => { throw new Error("boom"); } };
    expect(await classifier(throwing).run("s", [text])).toEqual([]);
    expect(loadMessageBlocks(db, "s", text)).toEqual([]);
  });

  test("without a key the pass does nothing, but persisted blocks still replay", async () => {
    const disabled: Omit<JevClient, "breaker"> = { enabled: false, classify: async () => ({ outcome: "no_key", answers: null, durationMs: 0 }) };
    const c = classifier(disabled);
    expect(c.enabled).toBe(false);
    expect(await c.run("s", [COMPARISON])).toEqual([]);
    const block = { partIndex: 0, start: 0, end: 3, block: { kind: "quote" as const, quote: "W." }, confidence: 0.9 };
    saveMessageBlocks(db, "s", "old", [block]);
    expect(c.attach("s", [{ role: "assistant", content: "old", toolCalls: [] }])[0]!.blocks).toEqual([block]);
  });
});

describe("the confidence record", () => {
  let db: Database;
  let path: string;
  beforeEach(() => {
    path = join(tmpdir(), `confidence-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = createUiDb(path);
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  const TEXT = `Two ways home.\n\n${COMPARISON}\n\nPick one.`;

  /** Every recorded row, oldest first, as the tuning query reads them. */
  function rows(sessionId?: string) {
    const sql = `SELECT session_id AS sessionId, candidate_id AS candidateId,
                        candidate_kind AS candidateKind, question,
                        answer_type AS answerType, choice, confidence, threshold, cleared, outcome
                   FROM classification_confidence
                  ${sessionId ? "WHERE session_id = ?" : ""}
                  ORDER BY id`;
    return (sessionId ? db.query(sql).all(sessionId) : db.query(sql).all()) as Array<
      Record<string, unknown>
    >;
  }

  function classifier(jev: Omit<JevClient, "breaker">) {
    return createTurnClassifier({
      jev: { breaker: () => ({ open: false, consecutiveFailures: 0, retryAt: null }), ...jev },
      db: () => db,
      log: silentLog,
    });
  }

  function answering(answers: unknown, durationMs = 120): Omit<JevClient, "breaker"> {
    return { enabled: true, classify: async () => ({ outcome: "answered", answers: answers as never, durationMs }) };
  }

  test("a swap records each question's confidence with its candidate kind and outcome", async () => {
    const blocks = await classifier(answering(GOOD_ANSWERS)).run("s-swap", [TEXT]);
    expect(blocks).toHaveLength(1);
    expect(rows("s-swap")).toEqual([
      { sessionId: "s-swap", candidateId: "p0c0", candidateKind: "table", question: "shape", answerType: "choice", choice: "comparison", confidence: 0.9, threshold: CONFIDENCE.swap, cleared: 1, outcome: "swapped" },
      { sessionId: "s-swap", candidateId: "p0c0", candidateKind: "table", question: "recommended", answerType: "choice", choice: "none", confidence: 0.9, threshold: CONFIDENCE.tone, cleared: 1, outcome: "swapped" },
      { sessionId: "s-swap", candidateId: "p0c0", candidateKind: "table", question: "criteria_first", answerType: "noul", choice: null, confidence: 0.95, threshold: CONFIDENCE.noul, cleared: 1, outcome: "swapped" },
    ]);
  });

  test("a candidate kept because its answer was under the line records the number", async () => {
    // This is what `kept` used to be: a count with nothing behind it.
    const low = { "p0c0.shape": { type: "choice", choice: "comparison", probabilities: {}, confidence: 0.58 } };
    expect(await classifier(answering(low)).run("s-kept", [TEXT])).toEqual([]);
    expect(rows("s-kept")).toEqual([
      { sessionId: "s-kept", candidateId: "p0c0", candidateKind: "table", question: "shape", answerType: "choice", choice: "comparison", confidence: 0.58, threshold: CONFIDENCE.swap, cleared: 0, outcome: "kept" },
    ]);
  });

  test("two candidates in one pass stay pairable, so a question can be read conditioned", async () => {
    // The catalogue asks `criteria_first` of EVERY table, including one the
    // shape answer calls `data`, where the question means nothing. Read
    // unconditioned those are two populations stacked on each other, so a row
    // has to say which candidate it was about.
    const DATA = `| Port | Nights |\n|---|---|\n| Aeaea | 365 |\n| Ogygia | 2555 |`;
    const answers = {
      "p0c0.shape": { type: "choice", choice: "comparison", probabilities: {}, confidence: 0.9 },
      "p0c0.criteria_first": { type: "noul", noul: 0.95 },
      "p0c1.shape": { type: "choice", choice: "data", probabilities: {}, confidence: 0.9 },
      // Meaningless for a data table, and the classifier says so.
      "p0c1.criteria_first": { type: "noul", noul: 0.05 },
    };
    await classifier(answering(answers)).run("s-pair", [`${COMPARISON}\n\nAnd the log:\n\n${DATA}`]);
    const recorded = rows("s-pair");
    expect(recorded.map((row) => [row.candidateId, row.question, row.confidence])).toEqual([
      ["p0c0", "shape", 0.9],
      ["p0c0", "criteria_first", 0.95],
      ["p0c1", "shape", 0.9],
      ["p0c1", "criteria_first", 0.05],
    ]);
    // One pass, one pass id, and it is what pairs a candidate's answers.
    const passes = db
      .query("SELECT DISTINCT pass_id AS id FROM classification_confidence WHERE session_id = ?")
      .all("s-pair");
    expect(passes).toHaveLength(1);
    // Which is what makes the conditional read possible: only the comparison's
    // noul belongs in a distribution the 0.7 line is tuned on.
    const conditioned = () =>
      (db
        .query(
          `SELECT noul.confidence AS confidence
             FROM classification_confidence AS noul
             JOIN classification_confidence AS shape
               ON shape.pass_id = noul.pass_id
              AND shape.candidate_id = noul.candidate_id
            WHERE noul.question = 'criteria_first'
              AND shape.question = 'shape'
              AND shape.choice = 'comparison'
            ORDER BY noul.id`
        )
        .all() as Array<{ confidence: number }>).map((row) => row.confidence);
    expect(conditioned()).toEqual([0.95]);

    // A second pass in the same session, on the same millisecond, must not
    // pair its `p0c0` with the first pass's. The pass is fire and forget, so
    // two of them really can overlap, and a clock-derived key would not
    // separate these two rows.
    const at = Date.now();
    for (const noul of [0.11, 0.22]) {
      recordQuestionConfidence(
        db,
        "s-pair",
        [
          { candidateId: "p0c0", candidateKind: "table", question: "shape", answerType: "choice", choice: "comparison", confidence: 0.9, threshold: CONFIDENCE.swap, cleared: true, outcome: "swapped" },
          { candidateId: "p0c0", candidateKind: "table", question: "criteria_first", answerType: "noul", confidence: noul, threshold: CONFIDENCE.noul, cleared: false, outcome: "swapped" },
        ],
        at
      );
    }
    // Four rows on one millisecond, two passes, and each noul still belongs to
    // exactly one shape answer — not to both.
    expect(conditioned()).toEqual([0.95, 0.11, 0.22]);
  });

  test("a pass with no answers — timeout, error, open breaker — records nothing", async () => {
    for (const outcome of ["timeout", "http_error", "network_error", "bad_response", "circuit_open"] as const) {
      const jev: Omit<JevClient, "breaker"> = {
        enabled: true,
        classify: async () => ({ outcome, answers: null, durationMs: 5 }),
      };
      expect(await classifier(jev).run(`s-${outcome}`, [TEXT])).toEqual([]);
    }
    expect(rows()).toEqual([]);
  });

  test("with no key the pass is disabled and the recording path is never reached", async () => {
    let calls = 0;
    const disabled: Omit<JevClient, "breaker"> = {
      enabled: false,
      classify: async () => { calls++; return { outcome: "no_key", answers: null, durationMs: 0 }; },
    };
    const c = classifier(disabled);
    expect(c.enabled).toBe(false);
    expect(await c.run("s-nokey", [TEXT])).toEqual([]);
    expect(calls).toBe(0);
    expect(rows()).toEqual([]);
  });

  test("a recording that fails costs the reader nothing: the blocks still land", async () => {
    db.exec("DROP TABLE classification_confidence");
    const blocks = await classifier(answering(GOOD_ANSWERS)).run("s-broken", [TEXT]);
    expect(blocks).toHaveLength(1);
    // And the pass persisted them for replay, as if nothing had gone wrong.
    expect(loadMessageBlocks(db, "s-broken", TEXT)).toEqual(blocks);
  });

  test("the recording happens after the classifier call and inside the pass, not after it", async () => {
    // The budget is the classifier call's, and it is unchanged.
    expect(JEV_TIMEOUT_MS).toBe(2000);
    let rowsDuringCall = -1;
    const jev: Omit<JevClient, "breaker"> = {
      enabled: true,
      classify: async () => {
        // Nothing is written while the deadline is armed, so the recording
        // takes none of the 2 s the call gets.
        rowsDuringCall = rows().length;
        return { outcome: "answered", answers: GOOD_ANSWERS as never, durationMs: 120 };
      },
    };
    await classifier(jev).run("s-budget", [TEXT]);
    expect(rowsDuringCall).toBe(0);
    // And it is done by the time the pass resolves — not deferred past it.
    expect(rows("s-budget")).toHaveLength(3);
  });

  test("nothing leaves the machine: the classifier call is the only outbound request", async () => {
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return jsonResponse({ model: "jev-1.13.0", answers: GOOD_ANSWERS });
    }) as typeof fetch;
    try {
      // The real client, with no fetch injected: whatever it reaches for is
      // whatever this pass reaches for.
      const jev = createJevClient({ apiKey: "k" });
      const blocks = await createTurnClassifier({ jev, db: () => db, log: silentLog }).run("s-net", [TEXT]);
      expect(blocks).toHaveLength(1);
      expect(rows("s-net")).toHaveLength(3);
      // Reading the distribution back is a query against the local file too.
      expect(confidenceDistribution(db).length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toEqual([JEV_ENDPOINT]);
  });

  test("the distribution reads back per candidate kind, question and bucket", async () => {
    // Ten passes over the same table, the shape answer walking up through the
    // swap line, so the read-back has a distribution rather than one point.
    for (let i = 0; i < 10; i++) {
      const confidence = Number((0.05 + i * 0.1).toFixed(2));
      const answers = {
        "p0c0.shape": { type: "choice", choice: "comparison", probabilities: {}, confidence },
        "p0c0.criteria_first": { type: "noul", noul: 0.95 },
      };
      await classifier(answering(answers)).run(`s-dist-${i}`, [TEXT]);
    }
    const shape = confidenceDistribution(db).filter((row) => row.question === "shape");
    expect(shape).toHaveLength(10);
    expect(shape.every((row) => row.candidateKind === "table" && row.threshold === CONFIDENCE.swap)).toBe(true);
    expect(shape.map((row) => [row.bucket, row.count, row.cleared, row.swapped])).toEqual([
      [0, 1, 0, 0],
      [0.1, 1, 0, 0],
      [0.2, 1, 0, 0],
      [0.3, 1, 0, 0],
      [0.4, 1, 0, 0],
      [0.5, 1, 0, 0],
      // 0.65 clears the 0.6 line, so the candidate was drawn as a block.
      [0.6, 1, 1, 1],
      [0.7, 1, 1, 1],
      [0.8, 1, 1, 1],
      [0.9, 1, 1, 1],
    ]);
  });

  test("a confidence sitting exactly on a line buckets with the line, not under it", () => {
    // 0.7 * 10 is 6.999… in binary floating point, and a truncating bucket
    // would file every threshold-hitting answer one bucket too low — exactly
    // the rows a threshold is tuned on.
    for (const confidence of [CONFIDENCE.swap, CONFIDENCE.noul, CONFIDENCE.tone, 1]) {
      recordQuestionConfidence(db, "s-edge", [
        {
          candidateId: "p0c0",
          candidateKind: "table",
          question: "shape",
          answerType: "choice",
          choice: "comparison",
          confidence,
          threshold: CONFIDENCE.swap,
          cleared: true,
          outcome: "swapped",
        },
      ]);
    }
    expect(confidenceDistribution(db).map((row) => row.bucket)).toEqual([0.6, 0.7, 0.8, 0.9]);
  });

  test("the read window and the retention prune bound what is kept", () => {
    const observation = {
      candidateId: "p0c0",
      candidateKind: "table" as const,
      question: "shape",
      answerType: "choice" as const,
      choice: "comparison",
      confidence: 0.9,
      threshold: CONFIDENCE.swap,
      cleared: true,
      outcome: "swapped" as const,
    };
    const now = Date.now();
    recordQuestionConfidence(db, "s-old", [observation], now - CONFIDENCE_RETENTION_MS - 1);
    recordQuestionConfidence(db, "s-recent", [observation], now - 1000);
    expect(rows()).toHaveLength(2);
    // The next write prunes what has aged out.
    recordQuestionConfidence(db, "s-new", [observation], now);
    expect(rows().map((row) => row.sessionId)).toEqual(["s-recent", "s-new"]);
    expect(confidenceDistribution(db, { since: now }).map((row) => row.count)).toEqual([1]);
    expect(confidenceDistribution(db, { since: now + 1 })).toEqual([]);
  });
});

describe("a turn that did not succeed never reaches the pass", () => {
  let db: Database;
  let path: string;
  beforeEach(() => {
    path = join(tmpdir(), `turn-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = createUiDb(path);
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  test("a cancelled turn and an error turn record nothing; a successful one records", async () => {
    const classified: string[] = [];
    // The real pass over a real db, so "records nothing" is a claim about the
    // table and not about a spy.
    const classifier = createTurnClassifier({
      jev: {
        enabled: true,
        breaker: () => ({ open: false, consecutiveFailures: 0, retryAt: null }),
        classify: async () => ({ outcome: "answered", answers: GOOD_ANSWERS as never, durationMs: 10 }),
      },
      db: () => db,
      log: silentLog,
    });
    const backend = makeFakeBackend({
      id: "fake",
      startTurn: async (request) => {
        classified.push(request.prompt);
        request.bridge.emit({ type: "text_delta", sessionId: request.prompt, text: COMPARISON });
        request.bridge.emit({
          type: "result",
          sessionId: request.prompt,
          outcome: request.prompt === "ok" ? "success" : (request.prompt as "cancelled" | "error"),
          durationMs: 1,
          numTurns: 1,
          isError: request.prompt === "error",
        });
      },
    });
    const host = new WsHost({
      registry: createStaticBackendRegistry([backend], "fake"),
      catalog: {
        getStoredProviderId: () => null,
        getStoredBackendId: () => null,
        persistSessionStub() {},
        persistSession() {},
      },
      classifier,
      turnTimeoutMs: 5_000,
    });
    host.clients.add({ send() {} }, testAuthorization().principalId);

    for (const sessionId of ["cancelled", "error", "ok"]) {
      await runSession(host, {
        authorization: testAuthorization(),
        text: sessionId,
        sessionId,
        attachments: [],
      });
    }
    expect(classified).toEqual(["cancelled", "error", "ok"]);

    // The pass is fire-and-forget, so wait for the one turn that should run it.
    const recorded = () =>
      (db.query("SELECT session_id AS sessionId FROM classification_confidence").all() as Array<{
        sessionId: string;
      }>).map((row) => row.sessionId);
    for (let attempt = 0; attempt < 200 && recorded().length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Only the successful turn's session is there — the other two ran first
    // and had strictly longer to write a row.
    expect(new Set(recorded())).toEqual(new Set(["ok"]));
  });
});
