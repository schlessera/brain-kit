import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditWithModules } from "../src/lib/auditor";
import { brainConfigSchema, type BrainConfig } from "../src/lib/config";
import type { BrainContext } from "../src/lib/context";
import { openDatabase } from "../src/lib/db";
import { indexAll } from "../src/lib/indexer";
import type { JevChoiceAnswer, JevChoiceQuestion, JevRequest } from "../src/lib/jev";
import { acceptsPropagation, PROPAGATION_MODEL, propagationQuestions, propagationSettings } from "../src/lib/propagation-policy";
import { reviewPropagations } from "../src/lib/propagation-review";
import { PROPAGATION_REVIEWS_PATH, readPropagationStore } from "../src/lib/propagation-state";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { git } from "./git-fixture";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";
import corpus from "./fixtures/propagation-cases.json";
import { hygieneCliClock, writeHygieneClock } from "./hygiene-clock";

// Copied unchanged from the independently reviewed #3445 authored cases, for shipped product proof.
type AuthoredCase = (typeof corpus.cases)[number];
const NOW = new Date("2026-07-12T12:00:00Z");
const roots: string[] = [];
let savedFetch: PropertyDescriptor;
let savedKey: string | undefined;
let calls: JevRequest[];
let reply: (request: JevRequest) => Promise<Response>;
let clockScratch: string | undefined;

function answer(question: JevChoiceQuestion, choice: string, confidence = 0.98): JevChoiceAnswer {
  const keys = Object.keys(question.criteria);
  return { type: "choice", choice, confidence, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])) };
}
function response(request: JevRequest, choices: Record<string, string> = {}, confidence = 0.98): Response {
  return Response.json({ model: PROPAGATION_MODEL, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) =>
    [id, answer(q as JevChoiceQuestion, choices[id] ?? (id === "currency" ? "still_current" : "yes"), confidence)])), usage: { input_tokens: 100 } });
}
beforeEach(() => {
  savedFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
  savedKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "synthetic-propagation-key";
  calls = [];
  clockScratch = undefined;
  reply = async request => response(request);
  Object.defineProperty(globalThis, "fetch", { ...savedFetch, value: async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as JevRequest;
    calls.push(request);
    return reply(request);
  } });
});
afterEach(() => {
  Object.defineProperty(globalThis, "fetch", savedFetch);
  if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = savedKey;
  for (const root of roots.splice(0)) cleanup(root);
});

function fixture(c: AuthoredCase = corpus.cases[0]!, policy: NonNullable<NonNullable<BrainConfig["hygiene"]>["propagation"]> = {}): BrainContext {
  const root = makeTempBrain({ empty: true }); roots.push(root);
  mkdirSync(join(root, "notes"), { recursive: true });
  const config = brainConfigSchema.parse({ hygiene: { propagation: { enabled: true, ...policy } },
    taxonomy: { types: { note: { dir: "notes" } }, propagation: c.sources.map(s => ({ source: s.path, derivatives: c.derivative.path, ...(c.scope ? { scope: c.scope } : {}) })) } });
  writeFileSync(join(root, "brain.config.json"), JSON.stringify(config));
  writeFileSync(join(root, c.derivative.path), c.derivative.text);
  for (const source of c.sources) if (source.before !== null) writeFileSync(join(root, source.path), source.before);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "brain.config.json", "notes");
  git(root, "commit", "-q", "-m", "Record voyage content");
  for (const source of c.sources) writeFileSync(join(root, source.path), source.current);
  return { root, dbPath: join(root, ".brain-index/brain.db"), config, configPath: join(root, "brain.config.json"), modules: [], taxonomy: buildTaxonomy({ user: config }) };
}
function updatePolicy(brain: BrainContext, updates: NonNullable<NonNullable<BrainConfig["hygiene"]>["propagation"]>): void {
  brain.config = brainConfigSchema.parse({ ...brain.config, hygiene: { propagation: { ...brain.config?.hygiene?.propagation, ...updates } } });
  writeFileSync(brain.configPath!, JSON.stringify(brain.config));
}
async function lag(brain: BrainContext, now = NOW): Promise<number> {
  const db = openDatabase(":memory:");
  try {
    await indexAll(db, { root: brain.root, taxonomy: brain.taxonomy, embeddings: false, quiet: true });
    return (await auditWithModules(db, brain, { now })).filter(i => i.category === "propagation").length;
  } finally { db.close(); }
}
async function scriptedCli(brain: BrainContext, args: string[], mode = "positive") {
  clockScratch ??= makeTempBrain({ empty: true }); if (!roots.includes(clockScratch)) roots.push(clockScratch);
  const clock = join(clockScratch, "clock.ts"); writeHygieneClock(clock, NOW.toISOString());
  const child = Bun.spawn([process.execPath, "--preload", clock, "--preload", join(import.meta.dir, "fixtures/propagation-provider.ts"), BRAIN_BIN, "hygiene", ...args, "--json"],
    { env: { ...keylessEnv(brain.root), TYPESAFE_API_KEY: "synthetic-propagation-key", PROPAGATION_TEST_MODE: mode }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout);
}

test("propagation inspection is keyless and explicitly disabled until the owner opts in", async () => {
  const root = makeTempBrain({ empty: true });
  try {
    writeFileSync(join(root, "brain.config.json"), "{}\n");
    const result = await runCli(root, ["hygiene", "propagation", "--dry-run", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ enabled: false, acknowledged: 0, changedFiles: [],
      settings: { profile: "balanced", minConfidence: 0.7, crossChecks: true } });
  } finally { cleanup(root); }
});

test("real Git diffs and three questions clear a finding without changing any document bytes or dates", async () => {
  const brain = fixture();
  const sourceBefore = readFileSync(join(brain.root, "notes/source.md"), "utf8");
  const derivativeBefore = readFileSync(join(brain.root, "notes/derivative.md"), "utf8");
  expect(await lag(brain)).toBeGreaterThan(0);
  const report = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(report.acknowledged).toBe(1);
  expect(report.changedFiles).toEqual([PROPAGATION_REVIEWS_PATH]);
  expect(calls).toHaveLength(1);
  expect(Object.keys(calls[0]!.questions)).toEqual(["currency", "assertions", "coverage"]);
  const state = calls[0]!.state as { generationScope: string; sources: { before: string; current: string }[]; changesSinceReference: { unifiedDiff: string }[] };
  expect(state.generationScope).toContain("omit provisions");
  expect(state.sources[0]!.current).toBe(sourceBefore);
  expect(state.sources[0]!.before).toContain("barley");
  expect(state.changesSinceReference[0]!.unifiedDiff).toContain("+Odysseus commands the ship. The hold contains olives.");
  expect(state.changesSinceReference[0]!.unifiedDiff).not.toContain("/tmp/");
  expect(readFileSync(join(brain.root, "notes/source.md"), "utf8")).toBe(sourceBefore);
  expect(readFileSync(join(brain.root, "notes/derivative.md"), "utf8")).toBe(derivativeBefore);
  expect(await lag(brain)).toBe(0);
  expect(calls).toHaveLength(1); // Read-only audit made no extra provider request.
  const repeated = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(repeated.findings[0]).toMatchObject({ cached: true, status: "acknowledged" });
  expect(repeated.changedFiles).toEqual([]);
  expect(calls).toHaveLength(1);
  const scratch = makeTempBrain({ empty: true }); roots.push(scratch);
  const cli = await hygieneCliClock(scratch)(brain.root, ["hygiene", "reconcile", "--json"], NOW.toISOString());
  expect(cli.code, cli.stderr).toBe(0);
  expect(JSON.parse(cli.stdout).detected.filter((i: { category: string }) => i.category === "propagation")).toEqual([]);
});

test("dry-run exposes threshold sensitivity and writes no receipt", async () => {
  const brain = fixture();
  const result = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW, dryRun: true });
  expect(result.findings[0]!.status).toBe("would_acknowledge");
  expect(result.changedFiles).toEqual([]);
  expect(existsSync(join(brain.root, PROPAGATION_REVIEWS_PATH))).toBe(false);
  expect(result.findings[0]!.sensitivity).toContainEqual({ minConfidence: 0.99, currencyOnly: false, crossChecked: false });
  expect(await lag(brain)).toBeGreaterThan(0);
});

test("real CLI reconciliation automates benign findings and cached judgment persists across fresh processes", async () => {
  const brain = fixture();
  const first = await scriptedCli(brain, ["reconcile"]);
  expect(first.propagation.acknowledged).toBe(1);
  expect(first.detected.filter((i: { category: string }) => i.category === "propagation")).toEqual([]);
  const requests = join(brain.root, "propagation-requests.jsonl");
  expect(readFileSync(requests, "utf8").trim().split("\n")).toHaveLength(1);
  await scriptedCli(brain, ["next"], "forbid");
  expect(readFileSync(requests, "utf8").trim().split("\n")).toHaveLength(1);
  const source = join(brain.root, "notes/source.md");
  writeFileSync(source, readFileSync(source, "utf8") + "\nAn escort is now required.\n");
  const changed = await scriptedCli(brain, ["reconcile"], "needs_update");
  expect(changed.propagation.reviewRequired).toBe(1);
  expect(changed.detected.some((i: { category: string }) => i.category === "propagation")).toBe(true);
  expect(readFileSync(requests, "utf8").trim().split("\n")).toHaveLength(2);
});

test("inspection-only next does not ask a provider or write a receipt even with credentials and open findings", async () => {
  const brain = fixture();
  const baseline = await runCli(brain.root, ["hygiene", "reconcile", "--json"]); // Explicitly keyless child.
  expect(baseline.code, baseline.stderr).toBe(0);
  expect(JSON.parse(baseline.stdout).detected.some((i: { category: string }) => i.category === "propagation")).toBe(true);
  await scriptedCli(brain, ["next", "--dry-run"], "forbid");
  expect(existsSync(join(brain.root, "propagation-requests.jsonl"))).toBe(false);
  expect(existsSync(join(brain.root, PROPAGATION_REVIEWS_PATH))).toBe(false);
});

test("balanced defaults accept at the floor with cross-checks and honor an explicit conservative profile", async () => {
  const brain = fixture();
  reply = async request => response(request, {}, 0.7);
  const balanced = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(balanced.settings).toMatchObject({ profile: "balanced", minConfidence: 0.7, crossChecks: true });
  expect(balanced.acknowledged).toBe(1);
  expect(await lag(brain)).toBe(0);
  expect(Object.keys(calls[0]!.questions)).toEqual(["currency", "assertions", "coverage"]);

  updatePolicy(brain, { profile: "conservative" });
  const conservative = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(conservative.settings).toMatchObject({ profile: "conservative", minConfidence: 0.9, crossChecks: true });
  expect(conservative.reviewRequired).toBe(1);
  expect(await lag(brain)).toBeGreaterThan(0);
  expect(calls).toHaveLength(1);
});

test("threshold changes reuse judgments but immediately change acknowledgement eligibility", async () => {
  const brain = fixture();
  reply = async request => response(request, {}, 0.6);
  expect((await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW })).reviewRequired).toBe(1);
  expect(await lag(brain)).toBeGreaterThan(0);
  updatePolicy(brain, { minConfidence: 0.4 });
  const looser = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(looser.findings[0]).toMatchObject({ cached: true, status: "acknowledged" });
  expect(await lag(brain)).toBe(0);
  expect(calls).toHaveLength(1);
  updatePolicy(brain, { minConfidence: 0.9 });
  expect(await lag(brain)).toBeGreaterThan(0);
  expect(calls).toHaveLength(1);
});

test("extra questions only veto: a coverage objection survives a confident currency answer", async () => {
  const brain = fixture();
  reply = async request => response(request, { coverage: "uncertain" });
  expect((await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW })).reviewRequired).toBe(1);
  expect(await lag(brain)).toBeGreaterThan(0);
  updatePolicy(brain, { crossChecks: false });
  expect((await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW })).acknowledged).toBe(1);
  expect(calls).toHaveLength(1);
  expect(await lag(brain)).toBe(0);
});

test("credentials cannot enable automation, and cached acknowledgements remain disabled when opted out", async () => {
  const brain = fixture();
  updatePolicy(brain, { enabled: false });
  expect((await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW })).enabled).toBe(false);
  expect(calls).toHaveLength(0);
  updatePolicy(brain, { enabled: true });
  expect((await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW })).acknowledged).toBe(1);
  updatePolicy(brain, { enabled: false });
  expect(await lag(brain)).toBeGreaterThan(0);
  expect(calls).toHaveLength(1);
});

test("extra checks are fetched only when missing; cached judgments work without a current provider credential", async () => {
  const brain = fixture(undefined, { crossChecks: false });
  await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(Object.keys(calls[0]!.questions)).toEqual(["currency"]);
  updatePolicy(brain, { crossChecks: true });
  await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(calls).toHaveLength(2);
  expect(Object.keys(calls[1]!.questions)).toHaveLength(3);
  delete process.env.TYPESAFE_API_KEY;
  const cached = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(cached.findings[0]).toMatchObject({ cached: true, status: "acknowledged" });
  expect(await lag(brain)).toBe(0);
  expect(calls).toHaveLength(2);
});

test("per-run limits advance past cached negative judgments rather than starving the rest of the backlog", async () => {
  const brain = fixture(undefined, { maxFiles: 1 });
  brain.taxonomy.propagation[0]!.derivatives = "notes/derivative*.md";
  brain.config!.taxonomy!.propagation![0]!.derivatives = "notes/derivative*.md";
  writeFileSync(brain.configPath!, JSON.stringify(brain.config));
  writeFileSync(join(brain.root, "notes/derivative-two.md"), readFileSync(join(brain.root, "notes/derivative.md"), "utf8"));
  git(brain.root, "add", "notes/derivative-two.md");
  git(brain.root, "commit", "-q", "-m", "Record second voyage summary");
  reply = async request => response(request, { currency: "needs_update" });
  const paths = ["notes/derivative.md", "notes/derivative-two.md"];
  const first = await reviewPropagations(brain, paths, { now: NOW });
  expect(first.reviewRequired).toBe(1);
  expect(first.deferred).toBe(1);
  expect(calls).toHaveLength(1);
  const next = await reviewPropagations(brain, paths, { now: NOW });
  expect(next.reviewRequired).toBe(2);
  expect(next.deferred).toBe(0);
  expect(calls).toHaveLength(2);
});

test.each(["source", "derivative", "config"] as const)("a concurrent %s change refuses receipt publication", async target => {
  const brain = fixture();
  reply = async request => {
    const path = target === "source" ? join(brain.root, "notes/source.md") : target === "derivative" ? join(brain.root, "notes/derivative.md") : brain.configPath!;
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
    return response(request);
  };
  const result = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(result.acknowledged).toBe(0);
  expect(result.findings[0]!.reason).toBe(target === "config" ? "config-changed" : "context-changed");
  expect(existsSync(join(brain.root, PROPAGATION_REVIEWS_PATH))).toBe(false);
});

test("source, derivative and scope changes invalidate saved acknowledgements without provider calls", async () => {
  const brain = fixture();
  await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(await lag(brain)).toBe(0);
  const path = join(brain.root, "notes/source.md"), original = readFileSync(path, "utf8");
  writeFileSync(path, original + "\nA new escort is required.\n");
  expect(await lag(brain)).toBeGreaterThan(0);
  writeFileSync(path, original);
  expect(await lag(brain)).toBe(0);
  const derivative = join(brain.root, "notes/derivative.md"), old = readFileSync(derivative, "utf8");
  writeFileSync(derivative, old + "\nA second claim.\n");
  expect(await lag(brain)).toBeGreaterThan(0);
  writeFileSync(derivative, old);
  brain.taxonomy.propagation[0]!.scope = "Current command and provisions overview.";
  expect(await lag(brain)).toBeGreaterThan(0);
  expect(calls).toHaveLength(1);
});

test("a new observation day invalidates acknowledgements for time-dependent statements", async () => {
  const brain = fixture();
  await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(await lag(brain, NOW)).toBe(0);
  expect(await lag(brain, new Date("2026-07-13T12:00:00Z"))).toBeGreaterThan(0);
  expect(calls).toHaveLength(1);
});

test.each(["timeout", "invalid", "wrong-model"] as const)("%s keeps review and stores no false acknowledgement", async failure => {
  const brain = fixture(undefined, { timeoutMs: 100 });
  reply = failure === "timeout" ? () => new Promise(() => {}) : async request => failure === "invalid" ? Response.json({ model: PROPAGATION_MODEL, answers: {} }) :
    Response.json({ ...(await response(request).json()), model: "jev-latest" });
  const result = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(result.unavailable).toBe(1);
  expect(await lag(brain)).toBeGreaterThan(0);
  expect(existsSync(join(brain.root, PROPAGATION_REVIEWS_PATH))).toBe(false);
});

test("missing history, uncommitted derivative, exclusions and size limits do not send documents", async () => {
  for (const mode of ["history", "derivative", "excluded", "size"] as const) {
    const brain = fixture(undefined, mode === "excluded" ? { exclude: ["notes/source.md"] } : mode === "size" ? { maxInputChars: 1000 } : {});
    if (mode === "history") rmSync(join(brain.root, ".git"), { recursive: true, force: true });
    if (mode === "derivative") writeFileSync(join(brain.root, "notes/derivative.md"), "---\ntype: note\nupdated: 2026-07-05\n---\nA changed summary.\n");
    const report = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
    expect(report.unavailable).toBe(1);
  }
  expect(calls).toHaveLength(0);
});

test("a receipt file changed during judgment is not overwritten", async () => {
  const brain = fixture();
  reply = async request => {
    mkdirSync(join(brain.root, "context/hygiene"), { recursive: true });
    writeFileSync(join(brain.root, PROPAGATION_REVIEWS_PATH), "Owner notes; do not replace.\n");
    return response(request);
  };
  const report = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(report.acknowledged).toBe(0);
  expect(readFileSync(join(brain.root, PROPAGATION_REVIEWS_PATH), "utf8")).toBe("Owner notes; do not replace.\n");
});

test.each([
  ["notes", true],
  ["notes/", true],
  ["notes/source.md", true],
  ["notes/*.md", true],
  ["notes/source", false],
] as const)("provider exclusion %s respects directory boundaries", async (pattern, excluded) => {
  const brain = fixture(undefined, { exclude: [pattern] });
  const report = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(report.unavailable).toBe(excluded ? 1 : 0);
  expect(report.acknowledged).toBe(excluded ? 0 : 1);
  expect(calls).toHaveLength(excluded ? 0 : 1);
});

test("symlinked review output cannot write outside the brain", async () => {
  const brain = fixture(), outside = makeTempBrain({ empty: true }); roots.push(outside);
  mkdirSync(join(brain.root, "context"), { recursive: true });
  symlinkSync(outside, join(brain.root, "context/hygiene"));
  const report = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(report.unavailable).toBe(1);
  expect(calls).toHaveLength(0);
  expect(existsSync(join(outside, "propagation-reviews.md"))).toBe(false);
});

test("the document's explicit reference and scope work without a committed derivative", async () => {
  const brain = fixture();
  const commit = git(brain.root, "rev-parse", "HEAD");
  const path = join(brain.root, "notes/derivative.md");
  const text = readFileSync(path, "utf8").replace("tags: [voyage]", `tags: [voyage]\npropagation_reference: ${commit}\npropagation_scope: Current commander only.`);
  writeFileSync(path, text);
  const report = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(report.acknowledged).toBe(1);
  expect(report.findings[0]).toMatchObject({ reference: commit, referenceKind: "explicit" });
  expect(readPropagationStore(brain.root).receipts).toHaveLength(1);
});

test("historical symlinks are not mistaken for complete old source documents", async () => {
  const brain = fixture();
  const source = join(brain.root, "notes/source.md"), current = readFileSync(source, "utf8");
  rmSync(source); symlinkSync("missing.md", source);
  git(brain.root, "add", "notes/source.md"); git(brain.root, "commit", "-q", "-m", "Record historical link");
  const commit = git(brain.root, "rev-parse", "HEAD");
  rmSync(source); writeFileSync(source, current);
  const derivative = join(brain.root, "notes/derivative.md");
  writeFileSync(derivative, readFileSync(derivative, "utf8").replace("tags: [voyage]", `tags: [voyage]\npropagation_reference: ${commit}`));
  const result = await reviewPropagations(brain, ["notes/derivative.md"], { now: NOW });
  expect(result.unavailable).toBe(1);
  expect(result.findings[0]!.reason).toBe("historical-source-not-regular");
  expect(calls).toHaveLength(0);
});

describe("reviewed Odysseus corpus through real history, provider transport, receipt and audit", () => {
  for (const c of corpus.cases) test(c.id, async () => {
    const brain = fixture(c);
    reply = async request => response(request, { currency: c.gold });
    const original = readFileSync(join(brain.root, c.derivative.path), "utf8");
    const report = await reviewPropagations(brain, [c.derivative.path], { now: NOW });
    const canAcknowledge = c.gold === "still_current" && c.scope !== null && c.sources.every(s => s.before !== null);
    expect(report.acknowledged).toBe(canAcknowledge ? 1 : 0);
    expect(await lag(brain)).toBe(canAcknowledge ? 0 : c.sources.length);
    expect(readFileSync(join(brain.root, c.derivative.path), "utf8")).toBe(original);
    if (calls.length) expect((calls[0]!.state as { sources: unknown[] }).sources).toHaveLength(c.sources.length);
  });
});

test("configuration validates confidence controls and presets cannot make cross-checks override currency", () => {
  for (const minConfidence of [-0.01, 1.01, Number.NaN]) expect(brainConfigSchema.safeParse({ hygiene: { propagation: { minConfidence } } }).success).toBe(false);
  for (const profile of ["conservative", "balanced", "permissive"] as const) {
    const settings = propagationSettings({ enabled: true, profile });
    const questions = propagationQuestions(true);
    const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, answer(q, id === "currency" ? "needs_update" : "yes")]));
    expect(acceptsPropagation(answers, settings)).toBe(false);
  }
});
