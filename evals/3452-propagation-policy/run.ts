/** Explicit Jev-only product-path policy diagnostic, never ordinary CI. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import corpus from "../../packages/core/tests/fixtures/propagation-cases.json";
import { brainConfigSchema } from "../../packages/core/src/lib/config";
import type { BrainContext } from "../../packages/core/src/lib/context";
import { PROPAGATION_MODEL, PROPAGATION_QUESTION_VERSION, acceptsPropagation, propagationSettings } from "../../packages/core/src/lib/propagation-policy";
import { reviewPropagations, type PropagationReviewItem } from "../../packages/core/src/lib/propagation-review";
import { buildTaxonomy } from "../../packages/core/src/lib/taxonomy";

const replay = process.argv.includes("--summary");
if (!process.argv.includes("--run") && !replay) throw new Error("Use --run for paid diagnostics, or --summary for saved observations");
if (!replay && !process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const capAt = process.argv.indexOf("--max-usd"), cap = capAt < 0 ? 1 : Number(process.argv[capAt + 1]);
if (!Number.isFinite(cap) || cap <= 0 || cap > 15) throw new Error("--max-usd must be >0 and <=15");
const path = join(import.meta.dir, "results-2026-11-03.json");
if (!replay && await Bun.file(path).exists()) throw new Error("Results already exist; do not overwrite or silently replay observations");
type Case = (typeof corpus.cases)[number];
interface Row { id: string; split: string; rep: number; gold: string; item: PropagationReviewItem }
const stored = replay ? await Bun.file(path).json() : null;
const rows: Row[] = stored?.rows ?? [], attempts: { id: string; rep: number; request: unknown; response?: unknown }[] = stored?.attempts ?? [];
let active = { id: "", rep: 0 }, conservativeUsd = stored?.conservativeUsd ?? 0, stopped = stored?.stopped ?? false;
const original = globalThis.fetch;
// Count and bound actual HTTP attempts, including the shipped client's rate-limit retry.
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url) !== "https://api.typesafe.ai/v1/systemone") throw new Error("Unexpected diagnostic endpoint");
  const raw = String(init?.body), reserve = Buffer.byteLength(raw) * 0.042 / 1_000_000;
  if (conservativeUsd + reserve > cap) { stopped = true; throw new Error("Diagnostic spend cap"); }
  conservativeUsd += reserve;
  const attempt: (typeof attempts)[number] = { ...active, request: JSON.parse(raw) }; attempts.push(attempt);
  const response = await original(url, init);
  try { attempt.response = await response.clone().json(); } catch { /* Invalid output remains visible in product report. */ }
  return response;
}) as typeof fetch;
function git(root: string, args: string[]) {
  const p = Bun.spawnSync(["git", "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "-c", "commit.gpgSign=false", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
}
function prepare(c: Case): BrainContext {
  const root = mkdtempSync(join(tmpdir(), "brain-propagation-policy-"));
  mkdirSync(join(root, "notes"));
  const config = brainConfigSchema.parse({ hygiene: { propagation: { enabled: true, minConfidence: 0, crossChecks: true, timeoutMs: 10000, budgetMs: 20000 } },
    taxonomy: { types: { note: { dir: "notes" } }, propagation: c.sources.map(s => ({ source: s.path, derivatives: c.derivative.path, ...(c.scope ? { scope: c.scope } : {}) })) } });
  writeFileSync(join(root, "brain.config.json"), JSON.stringify(config));
  writeFileSync(join(root, c.derivative.path), c.derivative.text);
  for (const s of c.sources) if (s.before !== null) writeFileSync(join(root, s.path), s.before);
  git(root, ["init", "-q", "-b", "main"]); git(root, ["add", "brain.config.json", "notes"]); git(root, ["commit", "-q", "-m", "Record voyage content"]);
  for (const s of c.sources) writeFileSync(join(root, s.path), s.current);
  return { root, config, configPath: join(root, "brain.config.json"), dbPath: join(root, "brain.db"), modules: [], taxonomy: buildTaxonomy({ user: config }) };
}
function summary(split: string) {
  const selected = rows.filter(r => r.split === split);
  return ["conservative", "balanced", "permissive"].map(profile => {
    const settings = propagationSettings({ profile: profile as "conservative" | "balanced" | "permissive" });
    const accepted = selected.filter(r => r.item.answers && acceptsPropagation(r.item.answers, settings));
    return { profile, minConfidence: settings.minConfidence, crossChecks: settings.crossChecks, n: selected.length,
      accepted: accepted.length, safeAccepted: accepted.filter(r => r.gold === "still_current").length,
      falseAcknowledgements: accepted.filter(r => r.gold !== "still_current").map(r => ({ id: r.id, rep: r.rep })),
      unavailable: selected.filter(r => !r.item.answers).length };
  });
}
const save = () => {
  const result = { date: "2026-11-03", model: PROPAGATION_MODEL, questionVersion: PROPAGATION_QUESTION_VERSION,
  protocol: "Product-path dry runs; same reviewed authored cases and three repetitions. All three questions asked in one request; primary-only results replay the currency gate from that same request, not a separate live one-question arm. Presets predeclared policy choices, not tuned on held-out.",
    conservativeUsd, cap: stored?.cap ?? cap, stopped, rows, attempts, summaries: { tuning: summary("tuning"), heldOut: summary("held-out") } };
  const fields = Object.entries(result).map(([key, value]) => `  ${JSON.stringify(key)}: ${Array.isArray(value)
    ? `[\n${value.map(row => "    " + JSON.stringify(row)).join(",\n")}\n  ]` : JSON.stringify(value)}`);
  writeFileSync(path, "{\n" + fields.join(",\n") + "\n}\n");
};
try {
  outer: for (const split of replay ? [] : ["tuning", "held-out"]) for (const c of corpus.cases.filter(c => c.split === split)) {
    const brain = prepare(c);
    try {
      for (let rep = 0; rep < 3; rep++) {
        active = { id: c.id, rep };
        const result = await reviewPropagations(brain, [c.derivative.path], { now: new Date("2026-07-12T12:00:00Z"), dryRun: true });
        rows.push({ id: c.id, split, rep, gold: c.gold, item: result.findings[0]! }); save();
        console.log(`${split} ${c.id} ${rep + 1}/3 ${result.findings[0]!.status}`);
        if (stopped) break outer;
      }
    } finally { rmSync(brain.root, { recursive: true, force: true }); }
  }
} finally { globalThis.fetch = original; save(); }
console.log(JSON.stringify({ attempts: attempts.length, conservativeUsd, summaries: { tuning: summary("tuning"), heldOut: summary("held-out") } }, null, 2));
