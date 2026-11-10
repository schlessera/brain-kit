/**
 * Accounts for every test that a change makes disappear.
 *
 * An audit is allowed to remove a test, but only on purpose. Two comparisons
 * make an accidental loss impossible to record or to land:
 *
 * - **Declarations**, from git, for every tier. Each test title present before
 *   a change and absent after it must be named by a fixed finding: as a
 *   removal (which needs an obligation map and a killed mutation) or as a
 *   rename. One declared removal accounts for exactly one disappearance, so a
 *   legitimate removal cannot cover for a second, unnoticed one.
 * - **Executed cases**, from the runner's report, for Bun tiers. A file's count
 *   of passing cases may fall only by the number its findings declare. This
 *   catches what the source does not show: a shortened table, a loop that
 *   yields fewer cases, a test that is no longer collected. A case that newly
 *   passes without executing an assertion, or is newly skipped, is refused.
 */
import { REDUCING_ACTIONS } from "./catalog";
import type { Finding } from "./worksheet";

export interface Declared { removes: string[]; renames: Array<{ from: string; to: string }>; removedCases: number }

/** What the fixed findings on one file say will disappear from it. */
export function declaredFor(file: string, findings: readonly Finding[]): Declared {
  const declared: Declared = { removes: [], renames: [], removedCases: 0 };
  for (const finding of findings) {
    if (finding.file !== file || finding.status !== "fixed") continue;
    declared.renames.push(...(finding.evidence?.renames ?? []));
    if (!REDUCING_ACTIONS.includes(finding.action)) continue;
    const removes = finding.evidence?.removes ?? [];
    declared.removes.push(...removes);
    declared.removedCases += finding.evidence?.removedCases ?? removes.length;
  }
  return declared;
}

export interface StaticAccounting {
  before: number;
  after: number;
  /** Titles present before and absent after, once per missing occurrence. */
  gone: string[];
  problems: string[];
}

/** `left` minus `right` as multisets: a title declared twice must disappear twice to count twice. */
function minus(left: readonly string[], right: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const item of right) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  const out: string[] = [];
  for (const item of left) {
    const count = remaining.get(item) ?? 0;
    if (count > 0) remaining.set(item, count - 1); else out.push(item);
  }
  return out;
}

export function staticAccounting(before: readonly string[], after: readonly string[], declared: Declared): StaticAccounting {
  const gone = minus(before, after);
  const problems: string[] = [];
  const accountedFor = [...declared.removes, ...declared.renames.map(rename => rename.from)];
  const undeclared = minus(gone, accountedFor);
  if (undeclared.length) {
    problems.push(`${undeclared.length} test(s) disappeared without being declared: ${undeclared.map(title => JSON.stringify(title)).join(", ")}`);
  }
  // A declaration that names something still present would let the record claim a removal that did not happen.
  const stillThere = minus(accountedFor, gone);
  if (stillThere.length) problems.push(`declared as removed or renamed but still present: ${stillThere.map(title => JSON.stringify(title)).join(", ")}`);
  const added = minus(after, before);
  const missingTargets = minus(declared.renames.map(rename => rename.to), added);
  if (missingTargets.length) problems.push(`renamed to a title that does not exist after the change: ${missingTargets.map(title => JSON.stringify(title)).join(", ")}`);
  return { before: before.length, after: after.length, gone, problems };
}

export interface CaseSummary { name: string; state: "passed" | "failed" | "skipped"; assertions: number | null }

export interface RuntimeAccounting {
  casesBefore: number;
  casesAfter: number;
  assertionsBefore: number;
  assertionsAfter: number;
  problems: string[];
}

export function runtimeAccounting(before: readonly CaseSummary[], after: readonly CaseSummary[], removedCases: number): RuntimeAccounting {
  const passed = (cases: readonly CaseSummary[]) => cases.filter(entry => entry.state === "passed");
  const executed = (cases: readonly CaseSummary[]) => passed(cases).reduce((sum, entry) => sum + (entry.assertions ?? 0), 0);
  const [was, is] = [passed(before), passed(after)];
  const problems: string[] = [];
  const lost = was.length - is.length;
  if (lost > removedCases) problems.push(`${lost} executed case(s) fewer than before, and the findings declare ${removedCases}`);
  const earlier = new Map(before.map(entry => [entry.name, entry]));
  const hollow = is.filter(entry => entry.assertions === 0 && (earlier.get(entry.name)?.assertions ?? 0) > 0).map(entry => entry.name);
  if (hollow.length) problems.push(`now pass without executing an assertion: ${hollow.map(name => JSON.stringify(name)).join(", ")}`);
  const skipped = after.filter(entry => entry.state === "skipped" && earlier.get(entry.name)?.state === "passed").map(entry => entry.name);
  if (skipped.length) problems.push(`ran before and are skipped now: ${skipped.map(name => JSON.stringify(name)).join(", ")}`);
  return { casesBefore: was.length, casesAfter: is.length, assertionsBefore: executed(before), assertionsAfter: executed(after), problems };
}

/** One file's accounting as the ledger keeps it. `runtime` is `null` where the runner reports no cases (browser tiers). */
export interface FileAccounting {
  file: string;
  testsBefore: number;
  testsAfter: number;
  declaredRemoved: number;
  runtime: Omit<RuntimeAccounting, "problems"> | null;
}

/** Bun test files report every case; the browser runner reports only an exit code. */
export const reportsCases = (file: string): boolean => /(?:\.test|\.spec|_test|_spec)\.(?:[cm]?[jt]s|[jt]sx)$/.test(file);
