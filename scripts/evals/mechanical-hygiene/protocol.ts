/** Private comparison protocol. No production repair or command is adopted. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixtureSha256 } from "./fixture";
import { workload } from "./workload";

export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const protocol = {
  model: "claude-sonnet-5-5",
  capBasis: "actual additional billed charges",
  issueCapUsd: 15,
  aggregateCapUsd: 150,
  regressionSha: fixtureSha256,
  workloadSha: hash(JSON.stringify(workload)),
  skillSha: hash(readFileSync(new URL("../../../packages/core/skills/content-hygiene/SKILL.md", import.meta.url))),
  referenceInstant: "2026-07-12T12:00:00Z",
  sourceDocuments: [20, 1000],
  repetitions: 3,
  phases: ["dry-run", "apply", "repeat"],
  arms: ["current-skill", "mechanical-prototype"],
  sample: "18 authored cases, 6 Ogygia tuning and 12 Ithaca/Pylos/Sparta held-out. Documents and entities differ; supported table grammar is shared. Directional workload evidence, not unseen-template generalization or population safety.",
  baseline: "Actual shipped content-hygiene skill in a fresh native subscription session for each phase. Same fixture content, original file mtimes, runtime taxonomy and pinned document date. No fixture goldens or prototype source exposed through native tools. Model/provider/entitlement are checked before releasing the prompt. Retain every tool denial and report harness effects separately from task errors.",
  prototype: "Real index/detect/plan/apply/reconcile path. No semantic classifier. The CLI-without-agent control is not the current-skill baseline.",
  timing: "Fixture creation and initial input preparation excluded. Include native process startup, all actual model/tool requests, indexing, file edits and reconciliation through real process closure. Repeat uses the same brain but a fresh model session; no claim of cold provider cache. Three samples make nearest-rank p95 the maximum, not a stable tail estimate.",
  evidence: "Snapshot every filesystem entry, complete bytes including binary files and logs, mode, mtime and symlink target without following symlinks. Retain disposable index/scratch changes separately with exact approved paths; a directory prefix is not approval. Require complete independently reviewed log effects before live admission.",
  correctness: "Exact expected content for authored documents, no created/deleted/unapproved files, no wrong-target/content-loss/permission escape, no unchanged-file timestamp or permission churn, dry-run writes no content/log, repeat makes no content/log changes. Any destructive or unapproved effect stops future native phases. Log wording differences are reported explicitly and require review rather than silently ignored.",
  stale: "Changed source bytes, mtimes, read-only detail files or contained-path premises veto the complete prototype batch before its first write. Existing failedChecks and manual snooze/resolution rules remain covered by actual reconciler controls.",
  accounting: "Retain all physical request/raw usage and served-model receipts, retries and failures. Missing or nonfinite usage, incomplete model/auth receipt, unobserved or active subscription overage, missing natural transport completion or undrained owned child stops future dispatch. API-price equivalents and cache counts are diagnostics; no model receipt establishes a final invoice. Historic unknown charges remain unknown.",
  outcome: "A measured recommendation only. Production command/report and lock/recovery design require separate contract work coordinated with #597. Favorable fixture agreement does not authorize unattended repairs.",
};
export const protocolSha = hash(JSON.stringify(protocol));
