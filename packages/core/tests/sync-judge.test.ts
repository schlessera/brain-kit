import { describe, expect, test } from "bun:test";

import type { JevAnswers, JevChoiceQuestion, JevRequest, JevResult } from "../src/lib/jev";
import {
  createSyncJudge,
  FILE_HEAD_MAX_BYTES,
  planPairBatches,
  STATE_TOKEN_BUDGET,
  SYNC_JUDGE_THRESHOLDS,
  type JevLike,
} from "../src/lib/sync/judge";
import type { JudgmentPair, UnknownFile } from "../src/lib/sync/types";

type Answer = { choice: string; confidence: number };
/** Decides one question from its id and the state item it names. */
type Oracle = (questionId: string, item: Record<string, string>) => Answer;

/** A fake Jev that answers every asked question through `oracle`, and records each request. */
function fakeJev(oracle: Oracle, outcomes: JevResult["outcome"][] = []): JevLike & { requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  return {
    enabled: true,
    requests,
    async ask(request) {
      requests.push(request);
      const outcome = outcomes[requests.length - 1] ?? "answered";
      if (outcome !== "answered") return { outcome, answers: null, durationMs: 5 };
      const state = request.state as Record<string, Record<string, string>>;
      const answers: JevAnswers = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const key = id.slice(0, id.lastIndexOf("."));
        const { choice, confidence } = oracle(id, state[key]!);
        const options = Object.keys((question as JevChoiceQuestion).criteria);
        const probabilities = Object.fromEntries(
          options.map((o) => [o, o === choice ? confidence : (1 - confidence) / (options.length - 1)])
        );
        answers[id] = { type: "choice", choice, probabilities, confidence };
      }
      return { outcome: "answered", answers, durationMs: 5, model: "jev-test" };
    },
  };
}

const file = (id: string, path: string, head: string): UnknownFile => ({ id, path, head, bytes: head.length });
const pair = (id: string, ours: string, theirs: string): JudgmentPair => ({
  id,
  path: "projects/active/raft/status.md",
  context: "Raft > Next action",
  ours,
  theirs,
});

describe("createSyncJudge: enabled", () => {
  test("no key: disabled and sends nothing, even with a client", async () => {
    const jev = fakeJev(() => ({ choice: "artifact", confidence: 1 }));
    const judge = createSyncJudge({ apiKey: null, client: jev });
    expect(judge.enabled).toBe(false);
    expect((await judge.classifyFiles([file("a", "x.csv", "a,b")])).size).toBe(0);
    expect(jev.requests).toHaveLength(0);
  });

  test('sync.judge "off": disabled with a key', async () => {
    const jev = fakeJev(() => ({ choice: "artifact", confidence: 1 }));
    const judge = createSyncJudge({ apiKey: "k", mode: "off", client: jev });
    expect(judge.enabled).toBe(false);
    expect((await judge.decidePairs([pair("p", "a", "b")])).size).toBe(0);
    expect(jev.requests).toHaveLength(0);
  });
});

describe("J1: classifyFiles", () => {
  test("a decision is returned only when it clears the file line", async () => {
    const confidences: Record<string, number> = { "a.csv": SYNC_JUDGE_THRESHOLDS.file, "b.csv": SYNC_JUDGE_THRESHOLDS.file - 0.01 };
    const jev = fakeJev((_, item) => ({ choice: "artifact", confidence: confidences[item.path!]! }));
    const judge = createSyncJudge({ apiKey: "k", client: jev });
    const decided = await judge.classifyFiles([file("a", "a.csv", "x,y"), file("b", "b.csv", "x,y")]);
    expect([...decided.keys()]).toEqual(["a"]);
    expect(decided.get("a")).toEqual({ decision: "artifact", confidence: SYNC_JUDGE_THRESHOLDS.file });
    expect(judge.report()).toMatchObject({ calls: 1, asked: 2, decided: 1, outcomes: { answered: 1 } });
  });

  test("a binary head is not asked; a long head is cut to the byte bound", async () => {
    const jev = fakeJev(() => ({ choice: "track", confidence: 0.99 }));
    const judge = createSyncJudge({ apiKey: "k", client: jev });
    const long = "é".repeat(FILE_HEAD_MAX_BYTES); // two bytes each
    const decided = await judge.classifyFiles([file("bin", "x.dat", "PK\u0003\u0004\u0000\u0000"), file("long", "draft.txt", long)]);
    expect([...decided.keys()]).toEqual(["long"]);
    // One NUL in otherwise plain text is still binary.
    const nul = await createSyncJudge({ apiKey: "k", client: jev }).classifyFiles([
      file("nul", "notes/log.txt", `${"sailor log line\n".repeat(20)}\u0000`),
    ]);
    expect(nul.size).toBe(0);
    const state = jev.requests[0]!.state as Record<string, { path: string; head: string }>;
    expect(Object.values(state).map((s) => s.path)).toEqual(["draft.txt"]);
    const head = Object.values(state)[0]!.head;
    expect(head.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(head).length).toBeLessThanOrEqual(FILE_HEAD_MAX_BYTES);
  });
});

describe("J2: decidePairs", () => {
  test("both orders are asked in the same request, keyed by item", async () => {
    const jev = fakeJev(() => ({ choice: "distinct", confidence: 0.9 }));
    await createSyncJudge({ apiKey: "k", client: jev }).decidePairs([pair("p", "ours text", "theirs text")]);
    expect(jev.requests).toHaveLength(1);
    const request = jev.requests[0]!;
    expect(Object.keys(request.questions).sort()).toEqual(["p0.relation", "p0r.relation"]);
    const state = request.state as Record<string, { A: string; B: string }>;
    expect(state.p0).toMatchObject({ A: "ours text", B: "theirs text" });
    expect(state.p0r).toMatchObject({ A: "theirs text", B: "ours text" });
  });

  test("order-consistent supersedes is accepted after mapping the directions back", async () => {
    // Forward (A = ours) says A replaces B; reverse (A = theirs) says B replaces A: both mean ours supersedes.
    const jev = fakeJev((id) => ({ choice: id.startsWith("p0r") ? "B-replaces-A" : "A-replaces-B", confidence: 0.9 }));
    const judge = createSyncJudge({ apiKey: "k", client: jev });
    const decided = await judge.decidePairs([pair("p", "Deck lashed.", "Deck lashing planned.")]);
    expect(decided.get("p")).toEqual({ decision: "ours-supersedes", confidence: 0.9 });
    expect(judge.report().agreement).toEqual({ compared: 1, agreed: 1 });
  });

  test("an answer that follows the position, not the text, is rejected", async () => {
    // "A replaces B" in both orders names a different side each time.
    const jev = fakeJev(() => ({ choice: "A-replaces-B", confidence: 0.99 }));
    const judge = createSyncJudge({ apiKey: "k", client: jev });
    const decided = await judge.decidePairs([pair("p", "one", "two")]);
    expect(decided.size).toBe(0);
    expect(judge.report().agreement).toEqual({ compared: 1, agreed: 0 });
  });

  test("each decision has its own line, and both orders must clear it", async () => {
    const cases: [string, number, number, boolean][] = [
      ["same-fact", SYNC_JUDGE_THRESHOLDS.sameFact, SYNC_JUDGE_THRESHOLDS.sameFact, true],
      ["same-fact", SYNC_JUDGE_THRESHOLDS.sameFact, SYNC_JUDGE_THRESHOLDS.sameFact - 0.01, false],
      ["A-replaces-B", SYNC_JUDGE_THRESHOLDS.supersedes, SYNC_JUDGE_THRESHOLDS.supersedes, true],
      ["A-replaces-B", SYNC_JUDGE_THRESHOLDS.supersedes - 0.01, 0.99, false],
      ["distinct", SYNC_JUDGE_THRESHOLDS.distinct, SYNC_JUDGE_THRESHOLDS.distinct, true],
      ["distinct", SYNC_JUDGE_THRESHOLDS.distinct - 0.01, 0.99, false],
    ];
    for (const [choice, forward, reverse, accepted] of cases) {
      const jev = fakeJev((id) => {
        const isReverse = id.startsWith("p0r");
        const mirrored = choice === "A-replaces-B" && isReverse ? "B-replaces-A" : choice;
        return { choice: mirrored, confidence: isReverse ? reverse : forward };
      });
      const decided = await createSyncJudge({ apiKey: "k", client: jev }).decidePairs([pair("p", "a", "b")]);
      expect({ choice, forward, reverse, accepted: decided.has("p") }).toEqual({ choice, forward, reverse, accepted });
    }
  });

  test("batching splits by item count and by the state budget, and asks every pair once", async () => {
    const small = Array.from({ length: 7 }, (_, i) => pair(`s${i}`, `ours ${i}`, `theirs ${i}`));
    const jev = fakeJev(() => ({ choice: "distinct", confidence: 0.9 }));
    const decided = await createSyncJudge({ apiKey: "k", client: jev, maxItemsPerRequest: 3 }).decidePairs(small);
    expect(jev.requests.map((r) => Object.keys(r.questions).length)).toEqual([6, 6, 2]);
    expect(decided.size).toBe(7);

    // 3900 chars per side, four copies per pair (two orders): ~15.6k chars, ~3.9k tokens a pair.
    const big = Array.from({ length: 12 }, (_, i) => pair(`b${i}`, `${i}`.padEnd(3900, "o"), `${i}`.padEnd(3900, "t")));
    const plan = planPairBatches(big);
    expect(plan.batches.length).toBeGreaterThan(1);
    for (const batch of plan.batches) {
      expect(JSON.stringify(batch.request.state).length / 4).toBeLessThanOrEqual(STATE_TOKEN_BUDGET);
    }
    expect(plan.batches.flatMap((b) => b.indexes)).toEqual(big.map((_, i) => i));
  });

  test("a pair with an oversized side is not asked", () => {
    const plan = planPairBatches([pair("huge", "x".repeat(5000), "y"), pair("ok", "a", "b")]);
    expect(plan.skipped.get(0)).toBe("too-large");
    expect(plan.batches.flatMap((b) => b.indexes)).toEqual([1]);
  });

  test("after a failed request the judge stops asking for the rest of the sync", async () => {
    const pairs = Array.from({ length: 4 }, (_, i) => pair(`p${i}`, `a${i}`, `b${i}`));
    const jev = fakeJev(() => ({ choice: "distinct", confidence: 0.9 }), ["timeout"]);
    const judge = createSyncJudge({ apiKey: "k", client: jev, maxItemsPerRequest: 2 });
    expect((await judge.decidePairs(pairs)).size).toBe(0);
    expect(jev.requests).toHaveLength(1);
    expect((await judge.classifyFiles([file("f", "a.csv", "a,b")])).size).toBe(0);
    expect(jev.requests).toHaveLength(1);
    expect(judge.report()).toMatchObject({ calls: 1, outcomes: { timeout: 1 }, decided: 0 });
  });
});
