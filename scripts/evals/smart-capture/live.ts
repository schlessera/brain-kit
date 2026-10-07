/** Explicit, frozen #839 live dispatch only. Importing this file sends nothing. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addCommand } from "../../../packages/core/src/cli/commands/add";
import { initContext } from "../../../packages/core/src/lib/context";
import { createJevClient, type FetchLike, type JevResult } from "../../../packages/core/src/lib/jev";
import { bundledClaudeBinary } from "../../../packages/core/src/providers/agents/claude-binary";
import { claudeRunner } from "../../../packages/core/src/providers/agents/cli-runners";
import { installBrainSurface } from "./brain-fixture";
import { chooseThreshold, observe, summarize } from "./metrics";
import { atReferenceDate, capture, deterministic, fixtures, hybrid, needsInference, prepare, request, type Fixture } from "./pipeline";
import { fixtureSha, protocol, protocolSha, sourceHashes } from "./protocol";
import { startRelay } from "./relay";

export interface Call {
  provider: "typesafe" | "claude-subscription"; purpose: string; requestedModel: string; servedModel: string | null;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null;
  apiEquivalentLowerUsd: number | null; apiEquivalentUpperUsd: number | null; observedAdditionalBilledUsd: number | null;
  requestSha: string; stateBytes: number; status: number | null; outcome: string; durationMs: number; rawUsage: unknown;
}
export class Spend {
  usd = 0; uncertain = false;
  constructor(readonly ceiling: number) { if (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling > 15) throw Error("Invalid actual billed ceiling"); }
  reserve(upper: number) { if (this.uncertain || !Number.isFinite(upper) || upper < 0 || this.usd + upper > this.ceiling) throw Error("Actual billed charge reservation refused"); }
  charge(value: number | null) { if (value === null || !Number.isFinite(value) || value < 0) { this.uncertain = true; return; } this.usd += value; if (this.usd > this.ceiling) throw Error("Actual billed issue ceiling exceeded"); }
}
function tokens(value: unknown) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null; }
export async function classify(f: Fixture, root: string, spend: Spend, fetch: FetchLike, key: string, save: (calls: Call[]) => void) {
  const calls: Call[] = [];
  const client = createJevClient({ apiKey: key, timeoutMs: 10_000, now: () => performance.now(), async fetch(url, init) {
    const body = String(init.body), bytes = Buffer.byteLength(body);
    spend.reserve((bytes + 2048) * 0.042 / 1_000_000);
    const started = performance.now();
    const call: Call = { provider: "typesafe", purpose: "classification", requestedModel: "jev-1.13.0", servedModel: null,
      inputTokens: null, outputTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0,
      apiEquivalentLowerUsd: null, apiEquivalentUpperUsd: null, observedAdditionalBilledUsd: null,
      requestSha: (await import("./pipeline")).hash(body), stateBytes: bytes, status: null, outcome: "network_error", durationMs: 0, rawUsage: null };
    try {
      const response = await fetch(url, init); call.status = response.status;
      const raw = await response.clone().json() as any;
      call.servedModel = typeof raw.model === "string" ? raw.model : null; call.rawUsage = raw.usage ?? null;
      call.inputTokens = tokens(raw.usage?.input_tokens); call.outputTokens = tokens(raw.usage?.output_tokens);
      if (response.ok && call.servedModel === "jev-1.13.0" && call.inputTokens !== null && call.outputTokens !== null) {
        call.apiEquivalentLowerUsd = call.apiEquivalentUpperUsd = call.inputTokens * 0.042 / 1_000_000;
        call.observedAdditionalBilledUsd = call.apiEquivalentUpperUsd;
        call.outcome = "completed";
      } else call.outcome = response.ok ? "model_or_usage_mismatch" : "http_error";
      return response;
    } finally {
      call.durationMs = performance.now() - started; calls.push(call); spend.charge(call.observedAdditionalBilledUsd); save(calls);
    }
  } });
  const result = await client.ask(request(f, root));
  return { result, calls };
}
export async function native(f: Fixture, root: string, out: string, purpose: string, token: string, generationPath?: string, reviewPrompt?: string) {
  const source = new URL("../../../", import.meta.url).pathname, binary = bundledClaudeBinary();
  if (!binary) throw Error("Actual installed core runner CLI missing");
  const home = join(root, ".native-home"); mkdirSync(home, { recursive: true });
  const receiptPath = join(out, `${purpose}-native.json`), callPath = join(out, `${purpose}-physical-calls.json`);
  const relay = startRelay({ oauthToken: token, fetch: globalThis.fetch, save: calls => writeFileSync(callPath, JSON.stringify(calls, null, 2), { mode: 0o600 }) });
  const savedEnv = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    PATH: `${root}/bin:/usr/bin:/bin:${join(process.execPath, "..")}`, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
    BRAIN_ROOT: root, BRAIN_LIVE_EVAL: "839", BRAIN_SMART_SOURCE: source, BRAIN_SMART_RECEIPT: receiptPath,
    BRAIN_SMART_NATIVE_COMMAND: JSON.stringify([binary]), CLAUDE_CODE_PATH: join(source, "scripts/evals/smart-capture/native-observer.ts"),
    CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_BASE_URL: relay.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    NO_PROXY: "127.0.0.1,localhost", TERM: "dumb",
    ...(reviewPrompt ? { BRAIN_SMART_READONLY_REVIEW: "1" } : {}),
  });
  let failure: string | null = null;
  try {
    const brain = await initContext({ root });
    if (reviewPrompt) await claudeRunner().run(reviewPrompt, { cwd: root, timeoutMs: 300_000 });
    else if (generationPath) await claudeRunner().run(
      `Rewrite the captured note at ${generationPath} clearly, retaining every stated fact. The request was: ${f.content}\nKeep that original file and all existing documents unchanged. Save a separate draft to notes/rewrite-draft.md using normal Markdown frontmatter.`, { cwd: root, timeoutMs: 180_000 });
    else await addCommand.run([f.content, "--smart"], { brain, json: true, agentRunner: claudeRunner() });
  } catch (error) { failure = String(error); }
  finally {
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, savedEnv);
    relay.stop();
  }
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const calls: Call[] = relay.calls.map(call => ({ provider: "claude-subscription", purpose, requestedModel: call.requestedModel, servedModel: call.servedModel,
    inputTokens: tokens(call.usage?.input_tokens), outputTokens: tokens(call.usage?.output_tokens),
    cacheReadTokens: tokens(call.usage?.cache_read_input_tokens ?? 0), cacheWriteTokens: tokens(call.usage?.cache_creation_input_tokens ?? 0),
    apiEquivalentLowerUsd: call.apiEquivalent?.lowerUsd ?? null, apiEquivalentUpperUsd: call.apiEquivalent?.upperUsd ?? null,
    observedAdditionalBilledUsd: receipt.additionalBilledUsd === 0 ? 0 : null,
    requestSha: call.requestSha, stateBytes: call.stateBytes, status: call.status, outcome: call.outcome, durationMs: call.durationMs, rawUsage: call.usage,
  }));
  if (failure || receipt.failure || !receipt.finished || !receipt.result || !relay.complete() || receipt.overage !== "inactive observed") throw Error(`Stop native dispatch after retained receipts: ${failure ?? receipt.failure ?? "incomplete physical usage"}`);
  return { calls, receipt };
}
async function main() {
  if (process.env.BRAIN_LIVE_EVAL !== "839") throw Error("Explicit #839 live dispatch required");
  const out = process.argv[2], approvalPath = process.argv[3], ledgerPath = process.env.BRAIN_SMART_CAP_LEDGER;
  if (!out || !approvalPath || !ledgerPath) throw Error("Require destination, exact freeze review and actual billing ledger");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  if (ledger.capUsd !== 150 || ledger.basis !== "actual additional billed charges" || ledger.reservations["839"] !== 15 ||
      Object.values(ledger.reservations).reduce((a: number, b) => a + Number(b), 0) > 150) throw Error("Aggregate actual-billing reservation missing");
  const approval = JSON.parse(readFileSync(approvalPath, "utf8"));
  if (approval.approved !== true || approval.model !== "claude-sonnet-5-5" || approval.fixtureSha !== fixtureSha || approval.protocolSha !== protocolSha || JSON.stringify(approval.sourceHashes) !== JSON.stringify(sourceHashes)) throw Error("Independent exact-freeze approval absent");
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN, key = process.env.TYPESAFE_API_KEY;
  if (!token || !key) throw Error("Protected subscription and Jev credentials required");
  mkdirSync(out, { recursive: true });
  const spend = new Spend(15), rows: any[] = [], tuned: Array<{ fixture: Fixture; result: JevResult; calls: Call[]; durationMs: number }> = [];
  const save = () => writeFileSync(join(out, "observations.json"), JSON.stringify(rows, null, 2), { mode: 0o600 });
  for (const f of fixtures.filter(f => f.split === "tuning")) {
    const p = await prepare(f);
    try {
      if (!needsInference(f, p.root)) continue;
      const started = performance.now();
      const result = await classify(f, p.root, spend, globalThis.fetch, key, calls => writeFileSync(join(out, `tuning-${f.id}-physical.json`), JSON.stringify(calls, null, 2), { mode: 0o600 }));
      tuned.push({ fixture: f, ...result, durationMs: performance.now() - started });
      if (spend.uncertain) throw Error("Unknown actual Jev charge; stopped after preserved tuning receipts");
    } finally { p.close(); }
  }
  const calibrations = [];
  for (const row of tuned) {
    const p = await prepare(row.fixture);
    calibrations.push({ fixture: row.fixture, plan: (t: number) => hybrid(row.fixture, p.root, row.result, t), close: p.close });
  }
  const threshold = chooseThreshold(calibrations); calibrations.forEach(c => c.close());
  writeFileSync(join(out, "frozen-threshold.json"), JSON.stringify({ threshold, fixtureSha, protocolSha, tuningOnly: true }));
  for (const f of fixtures) for (let repetition = 0; repetition < protocol.repetitions; repetition++) for (const arm of protocol.arms) {
    const p = await prepare(f), cell = join(out, `${f.id}-${repetition}-${arm}`); mkdirSync(cell);
    let calls: Call[] = [], plan = deterministic(f, p.root), failure: string | null = null;
    try {
      installBrainSurface(p.root, new URL("../../../", import.meta.url).pathname);
      const started = performance.now(), classificationEligible = needsInference(f, p.root);
      if (arm === "current") {
        if (Object.keys(f.explicit).length) {
          const brain = await initContext({ root: p.root });
          const args = [f.content, ...Object.entries(f.explicit).flatMap(([flag, value]) => [`--${flag}`, Array.isArray(value) ? value.join(",") : String(value)])];
          await atReferenceDate(() => addCommand.run(args, { brain, json: true }));
        } else calls = (await native(f, p.root, cell, "current", token)).calls;
      } else {
        if (arm === "hybrid" && needsInference(f, p.root)) {
          const prior = f.split === "tuning" && repetition === 0 ? tuned.find(t => t.fixture.id === f.id) : undefined;
          const result = prior ?? await classify(f, p.root, spend, globalThis.fetch, key, calls => writeFileSync(join(cell, "classification-physical.json"), JSON.stringify(calls, null, 2), { mode: 0o600 }));
          plan = hybrid(f, p.root, result.result, threshold); calls = result.calls;
        }
        const captured = await atReferenceDate(() => capture(f, p.root, plan));
        if (f.generation) calls.push(...(await native(f, p.root, cell, "generation", token, captured.path)).calls);
      }
      const result = observe(f, p.root, arm === "current" ? undefined : plan);
      rows.push({ fixture: f.id, split: f.split, category: f.category, arm, repetition, threshold, classificationEligible, durationMs: performance.now() - started +
        (arm === "hybrid" && repetition === 0 ? tuned.find(t => t.fixture.id === f.id)?.durationMs ?? 0 : 0), ...result, calls, failure }); save();
      if (spend.uncertain) throw Error("Unknown actual billed usage; no further dispatch");
    } catch (error) { failure = String(error); rows.push({ fixture: f.id, split: f.split, category: f.category, arm, repetition, failure, calls, files: observe(f, p.root, plan).files }); save(); throw error; }
    finally { p.close(); }
  }
  const summary = { fixtureSha, protocolSha, threshold, actualJevPriceDerivedUsd: spend.usd, apiEquivalentIsNotSubscriptionBilling: true, summary: summarize(rows) };
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 }); console.log(JSON.stringify(summary));
}
if (import.meta.main) await main();
