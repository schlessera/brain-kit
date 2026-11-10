/**
 * The machine-readable `check:pr` receipt (#2940). It lists every selected local
 * check with its outcome. The PR template carries it, and the merge path in
 * `scripts/integrate.ts` refuses a candidate whose skipped, timed-out or
 * preempted local checks map to a hosted category that its exact-head hosted
 * proof did not run successfully.
 */
import { CATEGORIES, isPostMerge, type Category } from "./red-main";

export const RECEIPT_KIND = "brain-check-pr-receipt";
export const RECEIPT_START = "<!-- brain-check-pr-receipt:start -->";
export const RECEIPT_END = "<!-- brain-check-pr-receipt:end -->";
/**
 * Exit status of a check cancelled by host admission (#2943): sysexits
 * EX_TEMPFAIL. A preempted check must be rerun; it never counts as checked or
 * as a failure.
 */
export const PREEMPTED_EXIT = 75;
export const OUTCOMES = ["passed", "failed", "skipped", "timed-out", "preempted"] as const;
export type Outcome = typeof OUTCOMES[number];
/** Outcomes that leave a check unproven locally; hosted proof must cover them. */
export const UNPROVEN: readonly Outcome[] = ["skipped", "timed-out", "preempted"];

export interface ReceiptCheck { name: string; categories: Category[]; outcome: Outcome; elapsedMs?: number; reason?: string; }
export interface CheckReceipt {
  version: 1; kind: typeof RECEIPT_KIND; head: string; base: string; mode: "focused" | "full" | "all";
  startedAt: string; finishedAt: string | null; checks: ReceiptCheck[];
}

const RUNTIME = ["measure-claude-runtime", "measure-claude-enforcement", "native delegation, capabilities and measurement isolation", "shared-process Chrome then child cleanup"];
const RUNTIME_HOST = ["native managed hosted admission", "native separate-UID worker identity", "native reference pool allocation"];

/**
 * Hosted categories whose exact-head success proves a local check. Any one of
 * them suffices. An unknown check maps to none and can never be covered, so a
 * new local check cannot silently escape the merge gate.
 */
export function checkCategories(name: string): Category[] {
  if (["all lint and leakage gates", "environment documentation", "pending changeset package names", "contribution changeset"].includes(name)) return ["changeset"];
  if (name === "affected fast invariants" || name.startsWith("import-graph affected tests")) return ["verify", "unit"];
  if (name === "strict typecheck") return ["verify"];
  if (name === "complete unit and integration suite" || name === "first real Chrome launch and render") return ["unit"];
  if (name === "workspace build for real browser checks") return ["browser", "layout", "endurance"];
  if (name === "complete pinned visual/accessibility/pointer suite") return ["browser"];
  if (name === "complete pinned layout/offline suite") return ["layout"];
  if (name === "complete pinned endurance suite") return ["endurance"];
  if (name === "editorial provenance and reproducibility" || name === "pinned capture fonts and original notices") return ["captures"];
  if (name === "packed consumer checks") return ["pack"];
  if (RUNTIME.includes(name)) return ["runtime"];
  if (RUNTIME_HOST.includes(name)) return ["runtime_host"];
  return [];
}

const SHA = /^[a-f0-9]{40}$/;
const stamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));

export function parseReceipt(value: unknown): CheckReceipt {
  const r = value as CheckReceipt;
  if (!r || typeof r !== "object" || r.version !== 1 || r.kind !== RECEIPT_KIND || !SHA.test(r.head ?? "") ||
      typeof r.base !== "string" || !r.base.length || r.base.length > 200 || !["focused", "full", "all"].includes(r.mode) ||
      !stamp(r.startedAt) || !(r.finishedAt === null || stamp(r.finishedAt)) || !Array.isArray(r.checks) || !r.checks.length || r.checks.length > 100) throw new Error("Invalid check:pr receipt");
  const names = new Set<string>();
  for (const check of r.checks) {
    if (!check || typeof check.name !== "string" || !check.name.length || check.name.length > 200 || names.has(check.name) ||
        !OUTCOMES.includes(check.outcome) || !Array.isArray(check.categories) || check.categories.some(c => !CATEGORIES.includes(c)) ||
        (check.elapsedMs !== undefined && !(Number.isFinite(check.elapsedMs) && check.elapsedMs >= 0)) ||
        (check.reason !== undefined && (typeof check.reason !== "string" || check.reason.length > 300))) throw new Error("Invalid check:pr receipt check");
    names.add(check.name);
  }
  return r;
}

/** The block `check:pr` prints for the PR body; the template carries its markers. */
export function receiptBlock(receipt: CheckReceipt): string {
  return [RECEIPT_START, "```json", JSON.stringify(receipt), "```", RECEIPT_END].join("\n");
}

/**
 * The receipt carried by a PR body: null when the body has none (or only the
 * template's empty markers). More than one receipt, or an unreadable one, refuses.
 */
export function receiptFromBody(body: string | null | undefined): CheckReceipt | null {
  const text = (body ?? "").replace(/\r\n/g, "\n");
  const blocks: string[] = [];
  let at = 0;
  for (;;) {
    const start = text.indexOf(RECEIPT_START, at);
    if (start < 0) break;
    const end = text.indexOf(RECEIPT_END, start);
    if (end < 0) throw new Error("Unterminated check:pr receipt block in the PR body");
    blocks.push(text.slice(start + RECEIPT_START.length, end)); at = end + RECEIPT_END.length;
  }
  const filled = blocks.map(block => /```json\s*\n([\s\S]*?)\n\s*```/.exec(block)?.[1]?.trim()).filter((json): json is string => !!json);
  if (!filled.length) return null;
  if (filled.length > 1) throw new Error("The PR body carries more than one check:pr receipt; keep only the latest");
  let parsed: unknown;
  try { parsed = JSON.parse(filled[0]!); } catch { throw new Error("The PR body's check:pr receipt is not JSON"); }
  return parseReceipt(parsed);
}

/** Hosted categories the exact-head selected proof ran successfully (or validly retained). */
export function coveredCategories(selected: { selections: Record<string, string>; results: Record<string, string>; retained: string[] }): Set<Category> {
  const covered = new Set<Category>(["changeset"]);
  for (const category of CATEGORIES) {
    if (category === "changeset" || selected.selections[category] !== "true") continue;
    if (selected.results[category] === "success" || selected.retained.includes(category)) covered.add(category);
  }
  return covered;
}

export interface Uncovered { name: string; outcome: Outcome; categories: Category[]; }
/**
 * Local checks the receipt leaves unproven whose hosted categories did not run
 * successfully. A check mapped only to post-merge categories is proved by the
 * main run of its own squash, never by ready confirmation, so it is not a
 * pre-merge gap (the 2026-11-10 hybrid ruling). An unmapped check stays uncovered.
 */
export function uncoveredChecks(receipt: CheckReceipt, covered: Set<Category>): Uncovered[] {
  const postMerge = (categories: Category[]) => categories.length > 0 && categories.every(isPostMerge);
  return receipt.checks.filter(check => UNPROVEN.includes(check.outcome) && !postMerge(check.categories) && !check.categories.some(c => covered.has(c)))
    .map(({ name, outcome, categories }) => ({ name, outcome, categories }));
}

/** The merge decision for an ordinary candidate's receipt; returns the refusal text or null. */
export function receiptRefusal(body: string | null | undefined, covered: Set<Category>): string | null {
  const receipt = receiptFromBody(body);
  if (!receipt) return "No check:pr receipt in the PR body. Run `bun run check:pr --base origin/main` and paste the block it prints between the receipt markers of the PR template";
  const missing = uncoveredChecks(receipt, covered);
  if (!missing.length) return null;
  return `Local checks recorded as not run are not covered by exact-head hosted proof: ${missing.map(m =>
    `${m.name} (${m.outcome}; needs ${m.categories.length ? m.categories.join(" or ") : "no hosted category: rerun it locally"})`).join("; ")}. Rerun them locally and update the receipt, or get the categories selected in hosted proof`;
}
