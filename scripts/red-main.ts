/**
 * Repository-level red-main record (#2942): shared through the coordination ref,
 * written by the coordinator workflow, read by CI, `integrate.ts` and orchestrators.
 */
import type { CheckPlan } from "./ci-plan";

export const RED_MAIN_FILE = "red-main.json";
/** Two suspected flakes on one test within this window make the second real. */
export const FLAKE_WINDOW_MS = 7 * 24 * 60 * 60_000;
const MAX_SUSPECTS = 200, MAX_REPORTED = 200, MAX_FAILURES = 100, MAX_FIXES = 20;
const SHA = /^[a-f0-9]{40}$/;
/** `changeset` is the metadata/lint gate; it always runs and widens no selection. */
export const CATEGORIES = ["changeset", "verify", "pack", "unit", "runtime", "runtime_host", "browser", "layout", "captures", "endurance"] as const;
export type Category = typeof CATEGORIES[number];
export type Signature = "timeout" | "assertion" | "setup" | "unknown";
export type Verdict = "real" | "suspected-flake";

export interface RedFailure { test: string | null; category: Category; verdict: "real"; reasons: string[]; run: number; sha: string; }
export interface RedIncident {
  /** First red after the last run where the failing set actually ran green. */
  firstBad: string; run: number; opened: number;
  failures: RedFailure[]; incident: number | null; fixes: number[]; reported: string[];
}
export interface Suspect { test: string; category: Category; run: number; sha: string; at: number; probe: "pending" | "passed" | "failed" | "unavailable"; issue: number | null; }
export interface RedMainRecord {
  version: 1; updated: number; open: RedIncident | null; suspects: Suspect[];
  last: { action: "open" | "update" | "refine" | "incident" | "declare-fix" | "report" | "clear" | "suspect" | "probe"; at: number; run: number | null } | null;
}

export const emptyRedMain = (): RedMainRecord => ({ version: 1, updated: 0, open: null, suspects: [], last: null });
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const testPath = (value: unknown) => typeof value === "string" && value.length <= 300 && /^[A-Za-z0-9_./@-]+$/.test(value) && !value.split("/").includes("..");
const category = (value: unknown): value is Category => CATEGORIES.includes(value as Category);

export function parseRedMain(text: string): RedMainRecord {
  if (text.length > 64_000) throw new Error("Unbounded red-main record");
  const r = JSON.parse(text) as RedMainRecord;
  if (r?.version !== 1 || !Number.isSafeInteger(r.updated) || r.updated < 0 || !Array.isArray(r.suspects) || r.suspects.length > MAX_SUSPECTS ||
      !Object.hasOwn(r, "open") || !Object.hasOwn(r, "last")) throw new Error("Invalid red-main record");
  for (const s of r.suspects) if (!s || !testPath(s.test) || !category(s.category) || !positive(s.run) || !SHA.test(s.sha) || !Number.isSafeInteger(s.at) ||
      !["pending", "passed", "failed", "unavailable"].includes(s.probe) || !(s.issue === null || positive(s.issue))) throw new Error("Invalid red-main suspect");
  const o = r.open;
  if (o !== null && (!o || !SHA.test(o.firstBad) || !positive(o.run) || !Number.isSafeInteger(o.opened) || !Array.isArray(o.failures) ||
      !o.failures.length || o.failures.length > MAX_FAILURES || !(o.incident === null || positive(o.incident)) ||
      !Array.isArray(o.fixes) || o.fixes.length > MAX_FIXES || !o.fixes.every(positive) ||
      !Array.isArray(o.reported) || o.reported.length > MAX_REPORTED || !o.reported.every(sha => SHA.test(sha)) ||
      o.failures.some(f => !f || !(f.test === null || testPath(f.test)) || !category(f.category) || f.verdict !== "real" ||
        !Array.isArray(f.reasons) || !f.reasons.length || f.reasons.some(x => typeof x !== "string" || !/^[a-z0-9-]{1,60}$/.test(x)) || !positive(f.run) || !SHA.test(f.sha)))) throw new Error("Invalid red-main incident");
  if (r.last !== null && (!r.last || r.last.at !== r.updated || !(r.last.run === null || positive(r.last.run)) ||
      !["open", "update", "refine", "incident", "declare-fix", "report", "clear", "suspect", "probe"].includes(r.last.action))) throw new Error("Invalid red-main audit");
  return r;
}

const key = (f: { test: string | null; category: Category }) => f.test ?? `category:${f.category}`;
function next(record: RedMainRecord, now: number, action: NonNullable<RedMainRecord["last"]>["action"], run: number | null, change: Partial<RedMainRecord>): RedMainRecord {
  if (!Number.isSafeInteger(now) || now < record.updated) throw new Error("Backwards or unavailable clock");
  return parseRedMain(JSON.stringify({ ...record, ...change, version: 1, updated: now, last: { action, at: now, run } }));
}

/** Opens the record, or adds new failures to the open one; never changes its first bad SHA. */
export function openRed(record: RedMainRecord, input: { firstBad: string; run: number; failures: RedFailure[] }, now: number): RedMainRecord {
  if (!input.failures.length) throw new Error("A red record needs at least one real failure");
  if (record.open) {
    const known = new Set(record.open.failures.map(key)), added = input.failures.filter(f => !known.has(key(f)));
    if (!added.length) return record;
    return next(record, now, "update", input.run, { open: { ...record.open, failures: [...record.open.failures, ...added].slice(0, MAX_FAILURES) } });
  }
  return next(record, now, "open", input.run, { open: { firstBad: input.firstBad, run: input.run, opened: now, failures: input.failures.slice(0, MAX_FAILURES), incident: null, fixes: [], reported: [] } });
}

/** Bisect probes narrow the first bad SHA within the recorded range; the caller proves ancestry. */
export function refineFirstBad(record: RedMainRecord, sha: string, run: number, now: number): RedMainRecord {
  if (!record.open || record.open.firstBad === sha) return record;
  if (!SHA.test(sha)) throw new Error("Invalid first bad SHA");
  return next(record, now, "refine", run, { open: { ...record.open, firstBad: sha } });
}

export function attachIncident(record: RedMainRecord, incident: number, now: number): RedMainRecord {
  if (!record.open) throw new Error("No open red-main record");
  if (record.open.incident === incident) return record;
  if (record.open.incident !== null) throw new Error(`Red-main record already names incident #${record.open.incident}`);
  return next(record, now, "incident", record.open.run, { open: { ...record.open, incident } });
}

export function declareFix(record: RedMainRecord, pr: number, now: number): RedMainRecord {
  if (!record.open) throw new Error("Main is not red; there is nothing to declare a fix for");
  if (!positive(pr)) throw new Error("Invalid fix PR");
  if (record.open.fixes.includes(pr)) return record;
  return next(record, now, "declare-fix", null, { open: { ...record.open, fixes: [...record.open.fixes, pr] } });
}

export function reportLanded(record: RedMainRecord, sha: string, now: number): RedMainRecord {
  if (!record.open || record.open.reported.includes(sha)) return record;
  return next(record, now, "report", null, { open: { ...record.open, reported: [...record.open.reported, sha].slice(-MAX_REPORTED) } });
}

export interface IncludedRedSet { run: number; firstBad: string; failures: RedFailure[]; }
/** Whether a main run's printed selection covered every failure of this open record. */
export function coversRedSet(record: RedMainRecord, included: IncludedRedSet | null): boolean {
  if (!record.open || !included || included.run !== record.open.run) return false;
  const keys = new Set(included.failures.map(key));
  return record.open.failures.every(f => keys.has(key(f)));
}

/** Clears only on a green main run whose selection included this exact open record. */
export function clearRed(record: RedMainRecord, run: { id: number; conclusion: string; included: IncludedRedSet | null }, now: number): RedMainRecord {
  if (!record.open) return record;
  if (run.conclusion !== "success" || !coversRedSet(record, run.included)) throw new Error("Only a green main run that included the open red set clears it");
  return next(record, now, "clear", run.id, { open: null });
}

export function addSuspect(record: RedMainRecord, suspect: Omit<Suspect, "probe" | "issue"> & Partial<Pick<Suspect, "probe" | "issue">>, now: number): RedMainRecord {
  return next(record, now, "suspect", suspect.run, { suspects: [...record.suspects, { probe: "pending" as const, issue: null, ...suspect }].slice(-MAX_SUSPECTS) });
}

export function settleSuspect(record: RedMainRecord, match: { test: string; run: number }, update: Partial<Pick<Suspect, "probe" | "issue">>, now: number): RedMainRecord {
  let found = false;
  const suspects = record.suspects.map(s => s.test === match.test && s.run === match.run ? (found = true, { ...s, ...update }) : s);
  if (!found) throw new Error("Unknown suspected flake");
  return next(record, now, "probe", match.run, { suspects });
}

export interface FailureEvidence { test: string | null; category: Category; signature: Signature; inClosure: boolean | null; }

/**
 * Deterministic flake estimator. A rerun never turns proof green; this only
 * decides whether main is declared red now or after a triage probe.
 */
export function classifyFailure(failure: FailureEvidence, record: RedMainRecord, now: number, windowMs = FLAKE_WINDOW_MS): { verdict: Verdict; reasons: string[] } {
  const id = key(failure);
  const prior = record.suspects.filter(s => s.test === id && now - s.at <= windowMs);
  if (prior.length) return { verdict: "real", reasons: ["repeated-suspected-flake", `prior-suspect-run-${prior.at(-1)!.run}`] };
  if (failure.signature === "setup") return { verdict: "suspected-flake", reasons: ["setup-failure"] };
  if (failure.inClosure === null) return { verdict: "real", reasons: ["closure-unknown"] };
  if (failure.inClosure) return { verdict: "real", reasons: ["in-affected-closure", `${failure.signature}-signature`] };
  if (failure.signature === "timeout") return { verdict: "suspected-flake", reasons: ["outside-affected-closure", "timeout-signature"] };
  return { verdict: "real", reasons: ["outside-affected-closure", `${failure.signature}-signature`] };
}

export const failureKey = key;

export interface GateInput { record: RedMainRecord; pr: number; contains: (sha: string) => boolean; }
/** The hosted gate: refuse doomed proof, admit declared fixes and unaffected merge refs. */
export function gateDecision({ record, pr, contains }: GateInput): { refuse: boolean; message: string } {
  const open = record.open;
  if (!open) return { refuse: false, message: "main green: no open red-main record" };
  const incident = open.incident ? `incident #${open.incident}` : "incident pending";
  if (open.fixes.includes(pr)) return { refuse: false, message: `main red at ${open.firstBad}, ${incident}; PR #${pr} is a declared fix` };
  if (!contains(open.firstBad)) return { refuse: false, message: `main red at ${open.firstBad}, ${incident}; this merge ref does not contain it` };
  return { refuse: true, message: `main red at ${open.firstBad}, ${incident}` };
}

/** Main runs select their affected set plus every test and category in the open red record. */
export function includeRedSet(plan: CheckPlan, record: RedMainRecord | null, replan: (changed: string[]) => CheckPlan): CheckPlan {
  const open = record?.open;
  if (!open) return plan;
  const tests = open.failures.flatMap(f => f.test ? [f.test] : []);
  const widened = tests.length ? replan([...new Set([...plan.changed, ...tests])].sort()) : { ...plan, local: { ...plan.local } };
  const local = { ...widened.local };
  for (const f of open.failures) {
    if (f.category === "unit") local.fullTests = true;
    else if (f.category === "runtime" || f.category === "runtime_host") local.runtime = true;
    else if (f.category === "browser" || f.category === "layout" || f.category === "captures" || f.category === "endurance") local[f.category] = true;
  }
  const typecheck = widened.typecheck || open.failures.some(f => f.category === "verify");
  const pack = widened.pack || open.failures.some(f => f.category === "pack");
  // The file inventory, when narrowed, must still name each red test.
  const unitTests = widened.unitTests && [...new Set([...widened.unitTests, ...tests])].sort();
  return { ...widened, changed: plan.changed, typecheck, pack, local, ...(unitTests ? { unitTests } : {}), redMain: { run: open.run, firstBad: open.firstBad, failures: open.failures } };
}

/** Extracts failing test files and their signature from Bun JUnit output. */
export function junitFailures(xml: string): { test: string; signature: Signature }[] {
  const out = new Map<string, Signature>();
  const suites = xml.split(/(?=<testsuite\b)/);
  for (const suite of suites) {
    const tag = /^<testsuite\b[^>]*>/.exec(suite)?.[0];
    const file = tag && /\sfile="([^"]*)"/.exec(tag)?.[1];
    if (!file || !testPath(file) || out.has(file)) continue;
    const failures = [...suite.matchAll(/<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/g)];
    if (!failures.length) continue;
    const text = failures.map(m => `${m[2] ?? m[5] ?? ""} ${m[3] ?? ""}`).join("\n");
    out.set(file, /timed? ?out|timeout|deadline exceeded/i.test(text) ? "timeout" : /expect|assert|toBe|toEqual|received|expected/i.test(text) ? "assertion" : "unknown");
  }
  return [...out].map(([test, signature]) => ({ test, signature }));
}
