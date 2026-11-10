/** Bounded diff-assisted automatic review. Only a separate Markdown receipt is written. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { resolveEnv } from "../config/env.js";
import type { BrainContext } from "./context.js";
import { createJevClient, type JevChoiceAnswer } from "./jev.js";
import { acceptsPropagation, completePropagationAnswers, PROPAGATION_MODEL, PROPAGATION_QUESTION_VERSION,
  propagationQuestions, propagationSensitivity, propagationSettings, type PropagationSettings } from "./propagation-policy.js";
import { propagationContext, propagationHash, propagationText, readPropagationStore, receiptMatches,
  writePropagationStore, PROPAGATION_REVIEWS_PATH, PropagationUnavailable, type PropagationContext, type PropagationReceipt } from "./propagation-state.js";

type ReviewBrain = Pick<BrainContext, "root" | "taxonomy" | "config" | "configPath">;
export interface PropagationReviewItem {
  path: string;
  status: "acknowledged" | "would_acknowledge" | "review_required" | "unavailable" | "deferred";
  reason: string;
  cached: boolean;
  fingerprint?: string;
  reference?: string;
  referenceKind?: "explicit" | "derivative-commit";
  answers?: Record<string, JevChoiceAnswer>;
  sensitivity?: ReturnType<typeof propagationSensitivity>;
  changesSinceReference?: { path: string; unifiedDiff: string }[];
}
export interface PropagationReviewReport {
  enabled: boolean;
  dryRun: boolean;
  settings: PropagationSettings;
  model: string;
  questionVersion: string;
  acknowledged: number;
  reviewRequired: number;
  unavailable: number;
  deferred: number;
  changedFiles: string[];
  findings: PropagationReviewItem[];
}

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining < 1) throw new PropagationUnavailable("run-limit");
  return Math.min(5000, remaining);
}
function git(root: string, args: string[], deadline: number): string {
  const result = Bun.spawnSync(["git", "--no-pager", "--literal-pathspecs", "-C", root, "-c", "core.fsmonitor=false", ...args],
    { stdout: "pipe", stderr: "pipe", timeout: remainingMs(deadline) });
  if (result.exitCode !== 0) throw new PropagationUnavailable("missing-reference-history");
  const text = result.stdout.toString();
  if (!Buffer.from(text, "utf8").equals(result.stdout)) throw new PropagationUnavailable("non-utf8-history");
  return text;
}
/** Diff the actual supplied bytes, unaffected by the brain's filters/attributes or dirty index. */
function sourceDiff(before: string, current: string, deadline: number): string {
  const root = mkdtempSync(join(tmpdir(), "brain-propagation-diff-"));
  try {
    writeFileSync(join(root, "before.md"), before);
    writeFileSync(join(root, "current.md"), current);
    const result = Bun.spawnSync(["git", "--no-pager", "-c", "core.attributesFile=/dev/null", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--no-prefix", "--unified=3", "--", "before.md", "current.md"],
      { cwd: root, stdout: "pipe", stderr: "pipe", timeout: remainingMs(deadline) });
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new PropagationUnavailable("diff-unavailable");
    return result.stdout.toString();
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function reference(brain: ReviewBrain, context: PropagationContext, settings: PropagationSettings, deadline: number) {
  const data = parseFrontmatter(context.derivative, { dataOnly: true }).data;
  const explicit = data.propagation_reference;
  if (explicit !== undefined && (typeof explicit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(explicit))) throw new PropagationUnavailable("invalid-reference");
  const prefix = git(brain.root, ["rev-parse", "--show-prefix"], deadline).replace(/\r?\n$/, "");
  const commit = typeof explicit === "string" ? explicit : git(brain.root, ["log", "-1", "--format=%H", "--", context.path], deadline).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new PropagationUnavailable("missing-reference-history");
  git(brain.root, ["cat-file", "-e", `${commit}^{commit}`], deadline);
  const blob = (path: string) => {
    const entry = git(brain.root, ["ls-tree", "-z", commit, "--", path], deadline);
    if (!/^100(?:644|755) blob [0-9a-f]+\t/.test(entry) || entry.split("\0").filter(Boolean).length !== 1) throw new PropagationUnavailable("historical-source-not-regular");
    const spec = `${commit}:${prefix}${path}`;
    const size = Number(git(brain.root, ["cat-file", "-s", spec], deadline).trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > settings.maxInputChars) throw new PropagationUnavailable("reference-size-limit");
    return git(brain.root, ["show", "--no-ext-diff", "--no-textconv", spec], deadline);
  };
  // A commit is evidence of a recorded content version, never proof of generation time.
  if (explicit === undefined && blob(context.path) !== context.derivative) throw new PropagationUnavailable("uncommitted-derivative");
  const sources = context.sources.map(s => ({ ...s, before: blob(s.path) }));
  const changesSinceReference = sources.map(s => ({ path: s.path, unifiedDiff: sourceDiff(s.before, s.current, deadline) }));
  return { commit, kind: explicit === undefined ? "derivative-commit" as const : "explicit" as const, sources, changesSinceReference };
}

/** All input bytes are checked again after judgment and immediately before receipt publication. */
export async function reviewPropagations(brain: ReviewBrain, paths: string[], opts: { dryRun?: boolean; now?: Date } = {}): Promise<PropagationReviewReport> {
  const settings = propagationSettings(brain.config?.hygiene?.propagation), now = opts.now ?? new Date();
  const report: PropagationReviewReport = { enabled: settings.enabled, dryRun: opts.dryRun === true, settings, model: PROPAGATION_MODEL,
    questionVersion: PROPAGATION_QUESTION_VERSION, acknowledged: 0, reviewRequired: 0, unavailable: 0, deferred: 0, changedFiles: [], findings: [] };
  if (!settings.enabled) return report;
  let store;
  try { store = readPropagationStore(brain.root); }
  catch { report.findings = [...new Set(paths)].map(path => ({ path, status: "unavailable", reason: "invalid-review-log", cached: false })); report.unavailable = report.findings.length; return report; }
  let configBytes: string | null;
  try { configBytes = brain.configPath ? readFileSync(brain.configPath, "utf8") : null; }
  catch { report.findings = [...new Set(paths)].map(path => ({ path, status: "unavailable", reason: "config-unavailable", cached: false })); report.unavailable = report.findings.length; return report; }
  const checkConfig = () => {
    if (brain.configPath && readFileSync(brain.configPath, "utf8") !== configBytes) throw new PropagationUnavailable("config-changed");
  };
  const deadline = Date.now() + settings.budgetMs;
  const client = createJevClient({ apiKey: resolveEnv().typesafeApiKey, timeoutMs: settings.timeoutMs });
  let calls = 0;
  const reviewedTimes = new Map(store.receipts.map(r => [r.path, r.reviewedAt]));
  const ordered = [...new Set(paths)].sort((a, b) => (reviewedTimes.get(a) ?? "").localeCompare(reviewedTimes.get(b) ?? "") || a.localeCompare(b));
  for (const path of ordered) {
    const item: PropagationReviewItem = { path, status: "unavailable", reason: "unavailable-context", cached: false };
    report.findings.push(item);
    try {
      checkConfig();
      const context = propagationContext(brain.root, brain.taxonomy, path, settings, now);
      item.fingerprint = context.fingerprint;
      const existing = store.receipts.find(r => r.path === path);
      let receipt: PropagationReceipt;
      if (receiptMatches(existing, context) && completePropagationAnswers(existing.answers, settings.crossChecks)) {
        receipt = existing;
        item.cached = true;
      } else {
        if (!client.enabled) throw new PropagationUnavailable("no-key");
        if (calls >= settings.maxFiles || Date.now() >= deadline) { item.status = "deferred"; item.reason = "run-limit"; continue; }
        const source = reference(brain, context, settings, deadline);
        const questions = propagationQuestions(settings.crossChecks);
        const request = { model: PROPAGATION_MODEL, questions, state: {
          observationDay: context.observationDay, generationScope: context.scope,
          derivative: { path, text: context.derivative }, sources: source.sources,
          reference: { commit: source.commit, kind: source.kind }, changesSinceReference: source.changesSinceReference,
        } };
        if (JSON.stringify(request).length > settings.maxInputChars) throw new PropagationUnavailable("input-size-limit");
        // Bound total wall time as well as each request; no loop may acquire a fresh full budget.
        const remaining = deadline - Date.now();
        if (remaining < 100) { item.status = "deferred"; item.reason = "run-limit"; continue; }
        const timedClient = createJevClient({ apiKey: resolveEnv().typesafeApiKey, timeoutMs: Math.min(settings.timeoutMs, remaining) });
        checkConfig();
        calls++;
        const result = await timedClient.ask(request);
        if (result.outcome !== "answered" || result.model !== PROPAGATION_MODEL || !result.answers) throw new PropagationUnavailable(result.outcome === "answered" ? "unexpected-model" : result.outcome);
        const answers = Object.fromEntries(Object.entries(result.answers).filter((entry): entry is [string, JevChoiceAnswer] => entry[1].type === "choice"));
        if (!completePropagationAnswers(answers, settings.crossChecks)) throw new PropagationUnavailable("invalid-answers");
        receipt = { path, fingerprint: context.fingerprint, reviewedAt: now.toISOString(), observationDay: context.observationDay, reference: source.commit,
          referenceKind: source.kind, model: result.model, questionVersion: PROPAGATION_QUESTION_VERSION,
          policy: { minConfidence: settings.minConfidence, crossChecks: settings.crossChecks },
          derivativeSha256: propagationHash(context.derivative), scope: context.scope,
          sources: source.sources.map(s => ({ path: s.path, sha256: propagationHash(s.current), beforeSha256: propagationHash(s.before) })), answers };
        item.changesSinceReference = source.changesSinceReference;
      }
      const recheck = () => {
        checkConfig();
        if (propagationContext(brain.root, brain.taxonomy, path, settings, now).fingerprint !== context.fingerprint) throw new PropagationUnavailable("context-changed");
        // Read every consulted current source again, including canonical exclusion checks.
        for (const s of context.sources) if (propagationText(brain.root, s.path, brain.taxonomy, settings) !== s.current) throw new PropagationUnavailable("context-changed");
      };
      recheck();
      item.answers = receipt.answers;
      item.reference = receipt.reference;
      item.referenceKind = receipt.referenceKind;
      item.sensitivity = propagationSensitivity(receipt.answers);
      const accepted = acceptsPropagation(receipt.answers, settings);
      if (!opts.dryRun && !item.cached) {
        const receipts = [...store.receipts.filter(r => r.path !== path), receipt].sort((a, b) => a.path.localeCompare(b.path));
        writePropagationStore(brain.root, store, receipts, now, recheck);
        store = readPropagationStore(brain.root);
        if (!report.changedFiles.includes(PROPAGATION_REVIEWS_PATH)) report.changedFiles.push(PROPAGATION_REVIEWS_PATH);
      }
      item.status = accepted ? opts.dryRun && !item.cached ? "would_acknowledge" : "acknowledged" : "review_required";
      item.reason = accepted ? "still-current" : receipt.answers.currency.choice === "still_current" ? "confidence-or-cross-check" : "needs-owner-review";
    } catch (error) {
      item.status = error instanceof PropagationUnavailable && error.message === "run-limit" ? "deferred" : "unavailable";
      item.reason = error instanceof PropagationUnavailable ? error.message : "unavailable-context";
    }
  }
  report.acknowledged = report.findings.filter(i => i.status === "acknowledged" || i.status === "would_acknowledge").length;
  report.reviewRequired = report.findings.filter(i => i.status === "review_required").length;
  report.unavailable = report.findings.filter(i => i.status === "unavailable").length;
  report.deferred = report.findings.filter(i => i.status === "deferred").length;
  return report;
}
