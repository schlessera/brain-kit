/**
 * Relayed CLI provider requests in the inference budgets (#1673): each
 * physical attempt is recorded once, priced where a rate is known, counted
 * toward the unpriced-token stops where it is not, and unknown when the
 * provider reported nothing. A blocked scope refuses the next request.
 */
import { expect, test } from "bun:test";
import { expectRejection } from "./helpers/expect-rejection.js";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { ProviderRelayReceipt } from "@schlessera/brain-ui-sdk/internal";
import { createUiDb } from "../src/db/client.js";
import { createTurnBudgets, TURN_BUDGET_COVERAGE } from "../src/brain/turn-budgets.js";
import { GEMINI_EMBEDDING_PRICES, priceProviderAttempt } from "../src/pricing/provider-pricing.js";

const policy = () => resolveGovernancePolicy({ schema_version: 1, budgets: { turn: { warn_usd: 1, block_usd: 2, block_tokens: 1000 },
  session: { warn_usd: 3, block_usd: 4, block_tokens: 2000 }, day: { warn_usd: 3, block_usd: 4, block_tokens: 2000 } } });
const pricing = { resolve: (model: string) => model === "claude-haiku-4-5-20251001" || model === "gemini/gemini-3-flash-preview"
  ? { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.001, estimate: false, source: "litellm" as const } : null };
function fixture() {
  const db = createUiDb(":memory:");
  let now = Date.UTC(2026, 6, 12, 9);
  return { db, budgets: createTurnBudgets(db, pricing, () => now), tick(ms: number) { now += ms; }, close() { db.close(); } };
}
let attempts = 0;
const attempt = (overrides: Partial<ProviderRelayReceipt> = {}): ProviderRelayReceipt => ({ attemptId: `attempt-${++attempts}`,
  family: "gemini", operation: "embeddings", origin: "https://generativelanguage.googleapis.com", key: "GEMINI_API_KEY",
  model: "gemini-embedding-2", outcome: "completed", status: 200, inlineMedia: false,
  usage: { inputTokens: 1_000_000, inputByModality: { TEXT: 1_000_000 } }, ...overrides });

test("the receipt states that relayed CLI providers are metered", async () => {
  const f = fixture();
  try {
    expect((await f.budgets.begin("athena", "ithaca", policy())).coverage, "COVERAGE_NAMES_RELAYED_PROVIDERS").toBe(TURN_BUDGET_COVERAGE);
    expect(TURN_BUDGET_COVERAGE).toBe("Built-in inference and relayed brain CLI providers; other provider and tool spend is not metered");
  } finally { f.close(); }
});

test("a priced embedding attempt counts once toward every scope", async () => {
  const f = fixture();
  try {
    await f.budgets.begin("athena", "ithaca", policy());
    const first = attempt();
    const result = (await f.budgets.observeProvider("athena", first))!;
    const turn = result.receipt.scopes.find(scope => scope.scope === "turn")!;
    expect(turn.costUsd, "PROVIDER_EMBEDDING_PRICED").not.toBeNull();
    expect(turn.costUsd!).toBeCloseTo(0.2, 10);
    expect(turn.tokens).toBe(1_000_000);
    expect(result.receipt.scopes.map(scope => scope.costUsd)).toEqual([turn.costUsd, turn.costUsd, turn.costUsd]);
    // The agent's own inference figures stay separate.
    expect(result.receipt.listPriceCostUsd).toBeNull();
    // A replayed observation of the same attempt adds nothing.
    expect((await f.budgets.observeProvider("athena", first)), "PROVIDER_ATTEMPT_RECORDED_ONCE").toBeUndefined();
    expect(f.budgets.receipt("athena").scopes[0]!.costUsd).toBeCloseTo(0.2, 10);
  } finally { f.close(); }
});

test("a blocked scope refuses the next relayed request, with nothing reserved before", async () => {
  const f = fixture();
  try {
    await f.budgets.begin("athena", "ithaca", policy());
    expect((await f.budgets.providerAdmission("athena", policy())), "PROVIDER_ADMITTED_UNDER_LIMIT").toBeUndefined();
    // $0.20 per million: 10 million text tokens is $2, the turn's block.
    const result = (await f.budgets.observeProvider("athena", attempt({ usage: { inputTokens: 10_000_000, inputByModality: { TEXT: 10_000_000 } } })))!;
    expect(result.blocked?.scope, "PROVIDER_USAGE_CROSSES_BLOCK").toBe("turn");
    expect((await f.budgets.providerAdmission("athena", policy()))?.scope, "PROVIDER_REFUSED_ONCE_BLOCKED").toBe("turn");
  } finally { f.close(); }
});

test("unpriced reported tokens count toward the token stop; missing usage never blocks", async () => {
  const f = fixture();
  try {
    await f.budgets.begin("athena", "ithaca", policy());
    const before = f.budgets.receipt("athena").scopes[0]!.unknownRuns;
    for (let index = 0; index < 5; index++) {
      const unknown = (await f.budgets.observeProvider("athena", attempt({ usage: null, outcome: "failed", status: 500 })))!;
      expect(unknown.blocked, "UNKNOWN_SPEND_NEVER_BLOCKS").toBeUndefined();
    }
    const turn = f.budgets.receipt("athena").scopes[0]!;
    expect(turn.costUsd, "UNKNOWN_SPEND_IS_NOT_ZERO").toBeNull();
    expect(turn.unknownRuns, "UNKNOWN_ATTEMPTS_DISCLOSED").toBe(before + 5);
    const image = (await f.budgets.observeProvider("athena", attempt({ family: "openai", operation: "image", model: "gpt-image-2.5-flare",
      key: "OPENAI_API_KEY", usage: { inputTokens: 100, outputTokens: 900 } })))!;
    expect(image.receipt.scopes[0]!.tokens).toBe(1000);
    expect(image.blocked?.scope, "UNPRICED_PROVIDER_TOKENS_REACH_TOKEN_STOP").toBe("turn");
  } finally { f.close(); }
});

test("a maintenance run outside any turn counts toward its day only", async () => {
  const f = fixture();
  try {
    expect((await f.budgets.observeProvider(null, attempt({ usage: { inputTokens: 20_000_000, inputByModality: { TEXT: 20_000_000 } } }))),
      "MAINTENANCE_ATTEMPT_HAS_NO_TURN_RECEIPT").toBeUndefined();
    expect((await f.budgets.providerAdmission(null, policy()))?.scope, "MAINTENANCE_DAY_BLOCKS").toBe("day");
    // The day it shares refuses the next turn's admission too.
    await expectRejection(f.budgets.begin("penelope", "loom", policy()), "UTC day inference budget reached", "MAINTENANCE_SPEND_IN_DAY_ADMISSION");
    f.tick(24 * 60 * 60 * 1000);
    // A new day: the turn's own scopes never held the maintenance run.
    const fresh = (await f.budgets.begin("penelope", "loom", policy())).scopes;
    expect(fresh.map(scope => scope.blocked), "MAINTENANCE_DAY_RESETS_FOR_TURNS").toEqual([false, false, false]);
    expect(fresh.find(scope => scope.scope === "day")!.costUsd ?? 0).toBe(0);
    expect((await f.budgets.providerAdmission(null, policy())), "MAINTENANCE_DAY_RESETS").toBeUndefined();
  } finally { f.close(); }
});

test("pricing: embedding modalities, inline media without a split, and completions", async () => {
  expect(GEMINI_EMBEDDING_PRICES["gemini-embedding-2"]).toEqual({ TEXT: 0.2 / 1_000_000, IMAGE: 0.45 / 1_000_000 });
  expect(priceProviderAttempt(attempt({ usage: { inputTokens: 2_000_000, inputByModality: { TEXT: 1_000_000, IMAGE: 1_000_000 } } }), pricing).costUsd)
    .toBeCloseTo(0.65, 10);
  expect(priceProviderAttempt(attempt({ usage: { inputTokens: 1000, inputByModality: { DOCUMENT: 1000 } } }), pricing),
    "UNRATED_MODALITY_UNPRICED").toEqual({ costUsd: null, estimate: null, tokens: 1000 });
  expect(priceProviderAttempt(attempt({ inlineMedia: true, usage: { inputTokens: 1000 } }), pricing).costUsd,
    "MEDIA_WITHOUT_SPLIT_UNPRICED").toBeNull();
  expect(priceProviderAttempt(attempt({ family: "anthropic", operation: "completions", model: "claude-haiku-4-5-20251001",
    usage: { inputTokens: 10, outputTokens: 5 } }), pricing)).toEqual({ costUsd: 0.02, estimate: false, tokens: 15 });
  expect(priceProviderAttempt(attempt({ operation: "completions", model: "gemini-3-flash-preview", usage: { inputTokens: 10 } }), pricing).costUsd)
    .toBeCloseTo(0.01, 10);
  expect(priceProviderAttempt(attempt({ usage: null }), pricing)).toEqual({ costUsd: null, estimate: null, tokens: null });
});

test("a dispatched attempt is unknown spend until it settles, then counts once", async () => {
  const f = fixture();
  try {
    await f.budgets.begin("athena", "ithaca", policy());
    const settled = attempt();
    const before = f.budgets.receipt("athena").scopes[0]!.unknownRuns;
    const pending = (await f.budgets.observeProvider("athena", { ...settled, outcome: "dispatched", status: 0, usage: null }))!;
    expect(pending.receipt.scopes[0]!.unknownRuns, "DISPATCHED_ATTEMPT_DISCLOSED").toBe(before + 1);
    const done = (await f.budgets.observeProvider("athena", settled))!;
    expect(done.receipt.scopes[0]!.unknownRuns, "SETTLED_ATTEMPT_REPLACES_DISPATCH").toBe(before);
    expect(done.receipt.scopes[0]!.costUsd).toBeCloseTo(0.2, 10);
    expect((await f.budgets.observeProvider("athena", { ...settled, outcome: "dispatched", status: 0, usage: null })), "SETTLED_ATTEMPT_FINAL").toBeUndefined();
  } finally { f.close(); }
});

test("an attempt that settles after midnight counts toward the day it settled in", async () => {
  const f = fixture();
  try {
    f.tick(14 * 60 * 60 * 1000 + 59 * 60 * 1000); // 23:59 UTC
    await f.budgets.begin("athena", "ithaca", policy());
    const settled = attempt({ usage: { inputTokens: 20_000_000, inputByModality: { TEXT: 20_000_000 } } });
    await f.budgets.observeProvider("athena", { ...settled, outcome: "dispatched", status: 0, usage: null });
    f.tick(2 * 60 * 1000);
    await f.budgets.observeProvider("athena", settled);
    expect((await f.budgets.providerAdmission(null, policy()))?.scope, "SETTLED_ATTEMPT_ON_ITS_SETTLEMENT_DAY").toBe("day");
  } finally { f.close(); }
});
