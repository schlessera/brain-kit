import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classify, Spend } from "../scripts/evals/smart-capture/live";
import { atReferenceDate, capture, fixtures, hybrid, prepare, scripted } from "../scripts/evals/smart-capture/pipeline";
import { summarize } from "../scripts/evals/smart-capture/metrics";
import { parseFrontmatter } from "../packages/core/src/lib/frontmatter-parse";

test("actual core Jev transport keeps physical usage, output count and complete bounded questions", async () => {
  const f = fixtures.find(f => f.id === "t-custom")!, p = await prepare(f);
  let dispatches = 0, saves = 0;
  try {
    const spend = new Spend(15), expected = scripted(f, p.root);
    const result = await classify(f, p.root, spend, async (_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("jev-1.13.0"); expect(Object.keys(body.questions)).toHaveLength(8); expect(body.questions.target).toBeUndefined();
      expect(body.state.capture).toBe(f.content); dispatches++;
      return Response.json({ model: "jev-1.13.0", answers: expected.answers, usage: { input_tokens: 300, output_tokens: 24 } });
    }, "offline-key", () => saves++);
    expect(result.result.outcome).toBe("answered"); expect(dispatches).toBe(1); expect(saves).toBe(1);
    expect(result.calls[0]!.inputTokens).toBe(300); expect(result.calls[0]!.outputTokens).toBe(24);
    expect(result.calls[0]!.observedAdditionalBilledUsd).toBeCloseTo(0.0000126, 10);
    expect(spend.usd).toBeCloseTo(0.0000126, 10);
  } finally { p.close(); }
});
test("missing usage preserves raw attempt and refuses paid retry or subsequent fetch", async () => {
  const f = fixtures.find(f => f.id === "t-custom")!, p = await prepare(f); let dispatches = 0;
  try {
    const spend = new Spend(15);
    const fetch = async () => { dispatches++; return Response.json({ error: "Rate limit" }, { status: 429, headers: { "retry-after": "0" } }); };
    const result = await classify(f, p.root, spend, fetch, "offline-key", () => {});
    expect(dispatches).toBe(1); expect(result.calls).toHaveLength(1);
    expect(result.calls[0]!.status).toBe(429); expect(result.calls[0]!.observedAdditionalBilledUsd).toBeNull();
    expect(spend.uncertain).toBe(true);
    await classify(f, p.root, spend, fetch, "offline-key", () => {});
    expect(dispatches).toBe(1);
  } finally { p.close(); }
});
test("a model mismatch does not invent a priced charge from an unrelated usage receipt", async () => {
  const f = fixtures.find(f => f.id === "t-custom")!, p = await prepare(f);
  try {
    const spend = new Spend(15), result = await classify(f, p.root, spend, async () => Response.json({ model: "jev-other", answers: scripted(f, p.root).answers, usage: { input_tokens: 300, output_tokens: 20 } }), "offline-key", () => {});
    expect(result.calls[0]!.outcome).toBe("model_or_usage_mismatch"); expect(spend.uncertain).toBe(true);
    expect(result.calls[0]!.apiEquivalentUpperUsd).toBeNull();
  } finally { p.close(); }
});
test("budget prevents physical dispatch and held-out report retains unknown costs", async () => {
  const spend = new Spend(0.000001); expect(() => spend.reserve(0.000002)).toThrow("reservation");
  const row = { arm: "hybrid", split: "held-out", fixture: "fixture", repetition: 0, correctType: true, wrongTargetAppend: false, contentLoss: false, unintendedCreates: 0,
    correctAppendTarget: true, correctReviewTarget: true, appendTarget: null, reviewTarget: null, abstained: true, truePositiveTags: 0, predictedTags: 0, expectedTags: 0,
    inventedTags: [], durationMs: 10, generationRequested: false, calls: [{ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, apiEquivalentLowerUsd: null, apiEquivalentUpperUsd: null, observedAdditionalBilledUsd: null }] };
  const summary = summarize([row]).find(r => r.arm === "hybrid" && r.split === "held-out")!;
  expect(summary.observations).toBe(1); expect(summary.calls).toBe(1);
  expect(summary.callsWithUnknownUsage).toBe(1); expect(summary.apiEquivalentUpperUsd).toBeNull(); expect(summary.observedAdditionalBilledUsd).toBeNull();
});
test("over-budget classification cannot reach the physical request transport", async () => {
  const f = fixtures.find(f => f.id === "t-custom")!, p = await prepare(f); let dispatches = 0;
  try {
    const spend = new Spend(0.000000001);
    const result = await classify(f, p.root, spend, async () => { dispatches++; return Response.json({ model: "jev-1.13.0", answers: scripted(f, p.root).answers, usage: { input_tokens: 0, output_tokens: 0 } }); }, "offline-key", () => {});
    expect(dispatches).toBe(0); expect(result.calls).toHaveLength(0); expect(result.result.outcome).toBe("network_error");
  } finally { p.close(); }
});
test("document reference clock leaves provider deadline clock intact and restores construction", async () => {
  const original = Date, now = Date.now;
  Date.now = () => 123456789;
  try {
    await atReferenceDate(async () => {
      expect(new Date().toISOString()).toBe("2026-07-12T04:40:00.000Z");
      expect(Date.now()).toBe(123456789);
    });
    expect(Date).toBe(original); expect(Date.now()).toBe(123456789);
  } finally { Date.now = now; }
});


test("inferred-tag reporting excludes metadata, explicit flags and reserved generation", () => {
  const common = { arm: "hybrid", split: "held-out", fixture: "fixture", repetition: 0, correctType: true, wrongTargetAppend: false, contentLoss: false, unintendedCreates: 0,
    correctAppendTarget: true, correctReviewTarget: true, appendTarget: null, reviewTarget: null, abstained: true, inventedTags: [], durationMs: 10, generationRequested: false, calls: [] };
  const summary = summarize([
    { ...common, classificationEligible: false, truePositiveTags: 10, predictedTags: 10, expectedTags: 10 },
    { ...common, classificationEligible: true, truePositiveTags: 1, predictedTags: 2, expectedTags: 4 },
  ]).find(r => r.arm === "hybrid" && r.split === "held-out")!;
  expect(summary.classificationEligibleTagMetrics).toEqual({ observations: 1, correct: 1, predicted: 2, expected: 4, precision: .5, recall: .25 });
  expect(summary.tagPrecision).toBeCloseTo(11 / 12);
});

for (const ignoreTermination of [false, true]) test(`observer refusal records actual native closure and stderr flush: ${ignoreTermination ? "forced" : "graceful"}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-smart-native-close-"));
  const receiptPath = join(root, "receipt.json"), sentinel = join(root, "sentinel.ts");
  writeFileSync(sentinel, `process.on("SIGTERM", () => { ${ignoreTermination ? "" : 'setTimeout(() => { process.stderr.write("Odysseus sentinel closed\\n"); process.exit(7); }, 300);'} });
setTimeout(() => process.exit(9), 10000);
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", model: "unexpected-fixture-model", apiKeySource: "none", claude_code_version: "2.1.283" }) + "\\n");
`);
  const source = resolve(".");
  const child = Bun.spawn([process.execPath, join(source, "scripts/evals/smart-capture/native-observer.ts"), "--settings", "{}"], {
    cwd: source, env: { PATH: process.env.PATH, BRAIN_LIVE_EVAL: "839", BRAIN_SMART_SOURCE: source,
      BRAIN_ROOT: root, BRAIN_SMART_RECEIPT: receiptPath, CLAUDE_CODE_OAUTH_TOKEN: "offline-fixture",
      BRAIN_SMART_NATIVE_COMMAND: JSON.stringify([process.execPath, sentinel]) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(5000),
  });
  child.stdin.end();
  try {
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    expect(exitCode).toBe(1);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt.failure).toBe("Error: Actual native model/auth mismatch");
    expect(receipt.drained).toBe(true);
    expect(receipt.finished).toBe(true);
    expect(receipt.stderrDrained).toBe(true);
    expect(receipt.stdoutComplete).toBe(false);
    expect(receipt.termination).toEqual({ requested: "SIGTERM", forced: ignoreTermination, timedOut: false });
    expect(receipt.exitCode).toBe(ignoreTermination ? 137 : 7);
    expect(receipt.signalCode).toBe(ignoreTermination ? "SIGKILL" : null);
    expect(receipt.nativePid).toBeGreaterThan(0);
    expect(() => process.kill(receipt.nativePid, 0)).toThrow();
    expect(readFileSync(`${receiptPath}.stdout.jsonl`, "utf8")).toContain("unexpected-fixture-model");
    if (!ignoreTermination) expect(stderr).toContain("Odysseus sentinel closed");
  } finally {
    child.kill(); await child.exited;
    // A reverted close guard can orphan the controlled sentinel. It is ours.
    const nativePid = JSON.parse(readFileSync(receiptPath, "utf8")).nativePid;
    if (Number.isSafeInteger(nativePid) && nativePid > 0) {
      try { process.kill(nativePid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error("Owned sentinel cleanup failed", error); }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

for (const field of ["type", "target"] as const) for (const low of ["selected probability", "confidence"] as const)
  test(`paired Choice admission rejects low ${low} with the other score high: ${field}`, async () => {
    const f = field === "type" ? fixtures.find(row => row.id === "t-custom")!
      : fixtures.find(row => row.expected.reviewTarget && !row.expected.appendTarget)!;
    const p = await prepare(f);
    try {
      const answer = scripted(f, p.root);
      const choice = answer.answers![field]!;
      if (choice.type !== "choice") throw Error("The independent control must contain an actual Choice answer");
      const names = Object.keys(choice.probabilities);
      expect(names.length).toBeGreaterThan(1);
      choice.confidence = low === "confidence" ? 0.6 : 0.99;
      const selected = low === "selected probability" ? 0.6 : 0.99;
      choice.probabilities = Object.fromEntries(names.map(name => [name, name === choice.choice ? selected : (1 - selected) / (names.length - 1)]));
      const result = await classify(f, p.root, new Spend(15), async () => Response.json({
        model: "jev-1.13.0", answers: answer.answers, usage: { input_tokens: 300, output_tokens: 24 },
      }), "offline-key", () => {});
      expect(result.result.outcome).toBe("answered");
      const plan = hybrid(f, p.root, result.result, 0.9);
      const captured = await capture(f, p.root, plan);
      const actual = parseFrontmatter(readFileSync(join(p.root, captured.path), "utf8"));
      expect(actual.content).toContain(f.content);
      if (field === "type") expect(actual.data.type).toBe("note");
      else expect(captured.reviewTarget).toBeNull();
      for (const [path, before] of Object.entries(f.files)) expect(readFileSync(join(p.root, path), "utf8")).toBe(before);
    } finally { p.close(); }
  });
