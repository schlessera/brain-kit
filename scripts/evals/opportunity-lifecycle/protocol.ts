/** Frozen prospective core comparison. No live provider launcher/admission exists in this preparation. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPERIMENT_RULE, type FreshCase, type Checkpoint } from "./fresh-corpus";

export const protocol = Object.freeze({
  measured: false, dispatchAllowed: false, model: "claude-sonnet-5-5", optionalClassifier: "jev-1.13.0",
  actualAdditionalCapUsd: 15, aggregateActualAdditionalCapUsd: 150,
  repetitions: 3, repeatScope: "entire independently reset trajectory per arm; all 24 checkpoints per repetition",
  order: "counterbalanced by repetition; frozen deterministic candidate/current order, no selected repeats or retries",
  corpus: "16 newly authored complete brains; 4 tuning and 12 semantic held-out, 24 checkpoints",
  fictionalScope: "counterfactual organizational plans with the established cast; no revised canonical chronology",
  baseline: "prospective actual core Claude runner with current jobs skills and exact disk module/config; no private prototype ledger or region requirement",
  currentCoreAdmission: "UNIMPLEMENTED/BLOCKED by #1275: core omission inherits native auto; classifier auxiliaries require complete physical accounting. Explicit SDK default permission fixture control is not current-core performance and does not settle core policy.",
  candidate: "private explicit-input inspect/apply; preview and actual sealed-plan apply; no classifier or generated research",
  fixtureClock: "2026-07-12T12:00:00Z only in actual brain CLI child; performance timer and native SDK clock unmodified",
  observations: "all file bytes, modes, members, directories, symlink targets and nanosecond mtimes; only root brain.db/wal/shm disposable",
  pipeline: "actual brain jobs pipeline and index --force, readonly all-deadline SQL and actual brain briefing in both arms",
  taskSemantics: EXPERIMENT_RULE,
  permission: "each explicit event authorizes only its tracked target/status/prep/focus and deterministic pipeline; no research/outreach/calendar edits",
  quality: "complete proposed reference documents + independently authored semantic facts; native format independently adjudicated; no forced private ledger",
  gates: "each checkpoint/repetition must preserve unowned complete prose/metadata, exact known facts, deadline/cardinality/history and permissions; wrong target/destructive/invented write is hard veto",
  clarification: "missing timezone/contact/target/round, ambiguous current-focus/ownership or incomplete receipt requires clarification with zero effects; no defaulting to UTC",
  recovery: "in-memory sealed-plan replay only; durable process-crash transaction/race control remains unimplemented and is an adoption limitation",
  accounting: "every native child/frame/raw stderr retained; final all-model named token counters, failed costs preserved; auxiliary unknown model/usage/overage/auth/closure mismatch stops dispatch",
  bounds: { nativeMaxTurnsPerCheckpoint: 16, responseSeconds: 180, processSeconds: 240, automaticRetries: 0,
    route: "existing included Claude subscription only; root serialized; stop active overage/included-limit, no paid fallback" },
  physicalAccounting: "native stdout alone does not prove physical HTTP count; future live admission requires actual transport-level request receipts, including retries/helpers/failed calls",
  offlineEvidence: "real SDK/native scripted tool/observer control, explicitly permissionMode default and exact fixture allowlist; no comparison with native auto, no real provider or semantic quality evidence",
  pricing: "actual invoice is unknown absent billing proof; API equivalents diagnostic only; preserve #1239 cache-read ambiguity and null unknown prices",
  statistics: "all per-turn outcomes/time/token/cache/pricing receipts; p50/p95, throughput, all three repetitions/spread; no savings claim before complete matched native comparison",
  optionalNL: "not authored/admitted here; only after completed core comparison and remaining actual-charge budget; cannot authorize writes",
  inputReview: "fresh GPT-family author-provisional corpus/expectations/protocol need exact-hash complementary Claude review; current subscription hold prevents it",
  adoption: "unresolved; no shipped CLI/JSON/frontmatter changes in this private preparation",
});

export function currentPrompt(fixture: FreshCase, checkpoint: Checkpoint) {
  const interview = readFileSync(join(import.meta.dir, "../../../packages/module-jobs/skills/interview-scheduled/SKILL.md"), "utf8");
  const research = readFileSync(join(import.meta.dir, "../../../packages/module-jobs/skills/research-opportunity/SKILL.md"), "utf8");
  return `${interview}\n\n${research}\n\n# Confirmed lifecycle task\nReference today: 2026-07-12.\n${EXPERIMENT_RULE}\n` +
    `Work only in this disposable fictional brain. Resolve actual disk config/module paths before edits. Preserve complete research, prior preparation and unrelated prose. No research, outreach, calendar or invented contact details.\n` +
    `Confirmed event (missing values are unknown, never fill them):\n${JSON.stringify(checkpoint.input, null, 2)}\n` +
    `Tracked target: ${fixture.target}; selected current-focus ownership is the unique wiki-link row for its status. If that is absent, ambiguous or previous ownership is incomplete, ask before writing; explicit closure of an already retired known target may leave focus untouched.\n` +
    `Run actual brain jobs pipeline, brain index --force and brain briefing after a successful update. Summarize exact effects or ask for missing facts. Do not create private evaluation ledgers or markers just to match the other arm.\n`;
}
