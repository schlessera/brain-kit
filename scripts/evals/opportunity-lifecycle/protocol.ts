/** Frozen prospective core comparison. The scored live comparison remains unimplemented; private review admission is source-bound. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPERIMENT_RULE, type FreshCase, type Checkpoint } from "./fresh-corpus";

export const protocol = Object.freeze({
  measured: false, dispatchAllowed: false, paidReview: "separate no-tools review transport; exact Root grant only; no scored core workflow or synthetic approval", model: "claude-sonnet-5-5", optionalClassifier: "jev-1.13.0",
  actualAdditionalCapUsd: 15, aggregateActualAdditionalCapUsd: 150,
  repetitions: 3, repeatScope: "entire independently reset trajectory per arm; all 24 checkpoints per repetition",
  order: "counterbalanced by repetition; frozen deterministic candidate/current order, no selected repeats or retries",
  corpus: "16 newly authored complete brains; 4 tuning and 12 semantic held-out, 24 checkpoints",
  fictionalScope: "counterfactual organizational plans with the established cast; no revised canonical chronology",
  baseline: "prospective actual core Claude runner with current jobs skills and exact disk module/config; no private prototype ledger or region requirement",
  currentCoreAdmission: "Prospective comparison remains unimplemented. #1301 settles #1275: the actual core runner explicitly passes default permission with its unchanged tool allowlist/credential/settings restrictions. The original explicit-default API-key SDK fixture control is not current-core performance. Paid review transport supplies neither core comparison nor semantic approval.",
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
    route: "existing Claude subscription; original API-key offline fixture remains separate. Private native review accepts active extra usage only with exact Root policy, existing serialized window and original15/150 actual-charge allocation; genuine paid rejection or unknown attempt stops" },
  physicalAccounting: "private paid review retains literal native stdin/stdout/stderr and each actual subscription physical request/SSE/error, method/path/auth/model/quota/counters/EOF/reader/closure; reserves full supported1M context plus exact output before forwarding and reparses raw terminal counters. Missing/contradictory/partial receipts retain unresolved holds and stop. Original scored core workflow remains prospective.",
  offlineEvidence: "real SDK/native scripted tool/observer control, explicitly permissionMode default and exact fixture allowlist; no comparison with native auto, no real provider or semantic quality evidence",
  pricing: "actual invoice is unknown absent billing proof; API equivalents diagnostic only; verified shared Sonnet5.5 pricing source (#1239); null unknown prices and original historical receipts remain distinct",
  statistics: "all per-turn outcomes/time/token/cache/pricing receipts; p50/p95, throughput, all three repetitions/spread; no savings claim before complete matched native comparison",
  optionalNL: "not authored/admitted here; only after completed core comparison and remaining actual-charge budget; cannot authorize writes",
  inputReview: "fresh GPT-family author-provisional corpus/expectations/protocol need exact-hash complementary Claude review; exact-current full source/runtime/proof/prompt Root grant is required; no offline scripted control can approve it",
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
