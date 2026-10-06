/**
 * What the pill labeller spends (#1083): every call that reaches the label
 * model is an Activity run named `pill label` on the session whose pill it
 * labels. It is priced only from usage and a model the provider reported
 * through `completeWithUsage`, under a billing mode the host declared; every
 * other call is an unpriced run, never $0.
 */
import { describe, expect, test } from "bun:test";

import { createActivityStore, rowToRunRollup, summarizeRollups, type RunRollupRow } from "../src/activity/store";
import { createUiDb } from "../src/db/client";
import {
  LABEL_RUN_NAME,
  createLabeller,
  type LabelCompletionProvider,
  type LabellerOptions,
} from "../src/labels/index";

const SESSION = "sess-ithaca";
const TEXTS = ["Ask Aeolus about the winds", "Keep the bag of winds shut", "Chart the strait past Scylla"];
const MODEL = "fixture-label-small";
/** $1 per million input tokens, $2 per million output: 100 in + 5 out = $0.00011. */
const PER_CALL_USD = 100 * 1e-6 + 5 * 2e-6;

function rig(provider: LabelCompletionProvider, billing?: LabellerOptions["billing"]) {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, {
    writer: "test",
    pricing: {
      resolve: (model) =>
        model === MODEL
          ? { input: 1e-6, output: 2e-6, cacheRead: null, cacheWrite: null, estimate: false, source: "litellm" as const }
          : null,
    },
  });
  let writes = 0;
  const labeller = createLabeller({
    options: { provider, ...(billing ? { billing } : {}) },
    activity: { store, onWrite: () => { writes++; } },
  });
  const runs = (): RunRollupRow[] =>
    db.query("SELECT * FROM activity_run_rollups ORDER BY started_at, run_id").all().map(rowToRunRollup);
  return { db, store, labeller, runs, writes: () => writes };
}

/** Answers every prompt with a label and the usage the call cost. */
function reporting(answer: { usage?: unknown; model?: unknown } = { usage: { inputTokens: 100, outputTokens: 5 }, model: MODEL }) {
  const plain: string[] = [];
  const provider: LabelCompletionProvider = {
    id: "fixture-small",
    async complete({ prompt }) {
      plain.push(prompt);
      return "Plain answer";
    },
    async completeWithUsage({ prompt }) {
      return { text: `About ${prompt.split(" ").slice(-1)[0]}`, ...answer } as never;
    },
  };
  return { provider, plain };
}

/** A provider with only `complete()`, as a core `CompletionProvider` is. */
const plainOnly: LabelCompletionProvider = {
  id: "fixture-small",
  async complete() {
    return "Bag of winds";
  },
};

async function labelThree(labeller: ReturnType<typeof createLabeller>) {
  for (const text of TEXTS) expect(await labeller.label(`follow-up:${text}`, text, SESSION)).toBeTruthy();
}

describe("pill label runs (#1083)", () => {
  test("a provider that reports usage, billed by API, prices each call from its usage and model", async () => {
    const { provider, plain } = reporting();
    const r = rig(provider, "api");
    await labelThree(r.labeller);

    const runs = r.runs();
    expect(runs).toHaveLength(3);
    expect(plain).toEqual([]);
    for (const run of runs) {
      expect(run).toMatchObject({
        name: LABEL_RUN_NAME,
        sessionId: SESSION,
        origin: "session",
        outcome: "success",
        billingMode: "api",
        inputTokens: 100,
        outputTokens: 5,
        pricingEstimate: false,
      });
      expect(run.effectiveCostUsd).toBeCloseTo(PER_CALL_USD, 12);
    }
    const summary = summarizeRollups(runs);
    expect(summary.unpricedRuns).toBe(0);
    expect(summary.effectiveCostUsd).toBeCloseTo(3 * PER_CALL_USD, 12);
    expect(r.writes()).toBeGreaterThanOrEqual(6);
  });

  test("a provider with only complete() is three unpriced runs, never $0", async () => {
    const r = rig(plainOnly, "api");
    await labelThree(r.labeller);

    const runs = r.runs();
    expect(runs.map((run) => [run.name, run.sessionId, run.outcome])).toEqual(
      TEXTS.map(() => [LABEL_RUN_NAME, SESSION, "success"])
    );
    for (const run of runs) {
      expect(run.effectiveCostUsd).toBeNull();
      expect(run.costUsd).toBeNull();
      expect(run.billingMode).toBeNull();
    }
    expect(summarizeRollups(runs)).toMatchObject({ runs: 3, unpricedRuns: 3, unpricedListCostRuns: 3 });
  });

  test("with billing unset, reported usage is kept but the runs stay unpriced", async () => {
    const r = rig(reporting().provider);
    await labelThree(r.labeller);

    const runs = r.runs();
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      expect(run).toMatchObject({ name: LABEL_RUN_NAME, inputTokens: 100, outputTokens: 5, billingMode: null });
      expect(run.effectiveCostUsd).toBeNull();
    }
    expect(summarizeRollups(runs).unpricedRuns).toBe(3);
  });

  test("subscription billing is $0 only for a call that reported its usage and model", async () => {
    const unreported = rig(plainOnly, "subscription");
    expect(await unreported.labeller.label("follow-up:a", TEXTS[0]!, SESSION)).toBe("Bag of winds");
    expect(unreported.runs()[0]).toMatchObject({ billingMode: null, effectiveCostUsd: null });

    const reported = rig(reporting().provider, "subscription");
    await reported.labeller.label("follow-up:a", TEXTS[0]!, SESSION);
    expect(reported.runs()[0]).toMatchObject({ billingMode: "subscription", effectiveCostUsd: 0 });
  });

  test.each([
    ["usage without a model", { usage: { inputTokens: 100, outputTokens: 5 } }],
    ["a model without usage", { model: MODEL }],
    ["a token count that is not a count", { usage: { inputTokens: -1, outputTokens: 5 }, model: MODEL }],
    ["a cache count that is not a count", { usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: Number.NaN }, model: MODEL }],
    ["a model the pricing catalog has no rate for", { usage: { inputTokens: 100, outputTokens: 5 }, model: "unlisted-model" }],
  ])("%s leaves an api-billed run unpriced", async (_name, answer) => {
    const r = rig(reporting(answer).provider, "api");
    await r.labeller.label("follow-up:a", TEXTS[0]!, SESSION);
    const [run] = r.runs();
    expect(run).toMatchObject({ name: LABEL_RUN_NAME, sessionId: SESSION });
    expect(run!.effectiveCostUsd).toBeNull();
  });

  test("a failed call is an error run with no cost; a cached answer and a shared call add none", async () => {
    let fail = true;
    const provider: LabelCompletionProvider = {
      id: "fixture-small",
      async complete() {
        if (fail) throw new Error("vendor unavailable");
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "Bag of winds";
      },
    };
    const r = rig(provider, "api");
    expect(await r.labeller.label("follow-up:a", TEXTS[0]!, SESSION)).toBeNull();
    expect(r.runs()).toEqual([expect.objectContaining({ name: LABEL_RUN_NAME, sessionId: SESSION, outcome: "error", effectiveCostUsd: null })]);

    fail = false;
    // Two sessions ask for the same text at once: one call, on the first asker's session.
    expect(await Promise.all([
      r.labeller.label("follow-up:a", TEXTS[0]!, SESSION),
      r.labeller.label("session:sess-scheria", TEXTS[0]!, "sess-scheria"),
    ])).toEqual(["Bag of winds", "Bag of winds"]);
    expect(await r.labeller.label("session:sess-scheria", TEXTS[0]!, "sess-scheria")).toBe("Bag of winds");
    expect(r.runs().map((run) => [run.sessionId, run.outcome])).toEqual([[SESSION, "error"], [SESSION, "success"]]);
  });

  test("an activity store that fails to write never costs the pill its label", async () => {
    const throwing = {
      startSpan: () => { throw new Error("database is locked"); },
      endSpan: () => { throw new Error("database is locked"); },
      rollupRun: () => { throw new Error("database is locked"); },
    } as never;
    const labeller = createLabeller({ options: { provider: plainOnly, billing: "api" }, activity: { store: throwing } });
    expect(await labeller.label("follow-up:a", TEXTS[0]!, SESSION)).toBe("Bag of winds");
  });
});
