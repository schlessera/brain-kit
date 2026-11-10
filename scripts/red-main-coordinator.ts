/**
 * Red-main coordinator (#2942): runs on every completed main CI run and every
 * triage probe. It records a red main in the shared coordination ref, files one
 * incident issue, cancels doomed PR proof and reports squashes that land while red.
 * A rerun is only a triage probe: it never turns proof green or makes anything mergeable.
 */
import { scanText } from "./check-leakage";
import { addSuspect, attachIncident, CATEGORIES, classifyFailure, clearRed, coversRedSet, failureKey, gateDecision, junitFailures, openRed, postMergeOnly, refineFirstBad,
  reportLanded, settleSuspect, type Category, type FailureEvidence, type IncludedRedSet, type RedFailure, type RedMainRecord, type Signature } from "./red-main";

export const PROBE_WORKFLOW = "red-main-probe.yml";
/** The shard's merged JUnit report, or one per unit worker (`scripts/unit-workers.ts`). */
export const UNIT_REPORT = /^unit-(?:worker-\d+-)?report\.xml$/;
/** Bisect only bounded ranges; a wider range keeps the conservative first red. */
export const MAX_BISECT = 10;
const SETUP_STEP = /prerequisites|environment setup/i;

export interface WorkflowRun {
  id: number; name: string; event: string; head_branch: string; head_sha: string; status: string; conclusion: string | null;
  run_attempt: number; display_title: string; created_at: string;
  /** GitHub records each PR's base and head as they stood when the run was created. */
  pull_requests?: { number: number; base?: { sha: string }; head?: { sha: string } }[];
}
export interface Job { id: number; name: string; conclusion: string | null; steps?: { name: string; conclusion: string | null }[]; }
export interface Snapshot { oid: string | null; redMain: RedMainRecord; }
export interface CoordinatorIO {
  repository: string;
  json(path: string): Promise<any>;
  write(method: "POST" | "PATCH", path: string, body?: unknown): Promise<any>;
  /** Authoritative GitHub server time. */
  now(): Promise<number>;
  read(): Snapshot;
  publish(snapshot: Snapshot, record: RedMainRecord): boolean;
  /** Every file, at any depth inside the named artifact, whose base name matches. */
  artifactFiles(run: number, artifact: string, file: RegExp): Promise<{ name: string; text: string }[]>;
  log(job: number): Promise<string>;
  /** Whether a failing test or category belongs to the commit's own affected closure; null when unknown. */
  inClosure(sha: string, failure: { test: string | null; category: Category }): boolean | null;
  /** First-parent main commits after `since` (exclusive) up to `until` (inclusive), oldest first. */
  range(since: string, until: string): string[];
  isAncestor(ancestor: string, descendant: string): boolean;
  commitTime(sha: string): number;
  recordEvent(event: { kind: "incident"; pr: number; run: number; evidence: string }): Promise<void>;
  print(line: string): void;
}

const short = (sha: string) => sha.slice(0, 12);
const issueUrl = (io: CoordinatorIO, number: number) => `https://github.com/${io.repository}/issues/${number}`;
const runUrl = (io: CoordinatorIO, run: number) => `https://github.com/${io.repository}/actions/runs/${run}`;
/** Keyed by the record's opening run: bisect may later move its first bad SHA. */
export const incidentMarker = (run: number) => `<!-- brain-red-main: run ${run} -->`;
export const flakeMarker = (key: string) => `<!-- brain-flake: ${key} -->`;

/** Retries a compare-and-swap update of the shared record; an unchanged result writes nothing. */
export async function updateRecord(io: Pick<CoordinatorIO, "read" | "publish" | "now">, update: (record: RedMainRecord, now: number) => RedMainRecord): Promise<{ before: RedMainRecord; after: RedMainRecord }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const snapshot = io.read(), after = update(snapshot.redMain, await io.now());
    if (after === snapshot.redMain) return { before: snapshot.redMain, after };
    if (scanText("coordination", JSON.stringify(after)).length) throw new Error("Public coordination state failed the leakage gate");
    if (io.publish(snapshot, after)) return { before: snapshot.redMain, after };
    await Bun.sleep(200 * 2 ** attempt);
  }
  throw new Error("Concurrent red-main update; bounded retries exhausted");
}

export function jobCategory(name: string): Category | null {
  const base = name.split(" ")[0]!;
  return CATEGORIES.includes(base as Category) ? base as Category : null;
}

/** Failures of one completed main run, with their deterministic estimator evidence. */
export async function runFailures(io: CoordinatorIO, run: WorkflowRun, jobs: Job[]): Promise<FailureEvidence[]> {
  const out: FailureEvidence[] = [];
  for (const job of jobs.filter(job => job.conclusion === "failure" || job.conclusion === "timed_out")) {
    const category = jobCategory(job.name);
    if (!category) continue;
    const setup = job.steps?.some(step => SETUP_STEP.test(step.name) && step.conclusion === "failure");
    const fallback: Signature = setup ? "setup" : job.conclusion === "timed_out" ? "timeout" : "unknown";
    if (category === "unit" && !setup) {
      const shard = /\((\d+)\)/.exec(job.name)?.[1];
      // The shard's merged report exists only once every worker's report
      // reconciled; a failing shard may carry only its workers' own reports (#3324).
      const files = shard ? await io.artifactFiles(run.id, `unit-proof-${shard}`, UNIT_REPORT) : [];
      const merged = files.filter(file => file.name === "unit-report.xml");
      const tests = (merged.length ? merged : files).flatMap(file => junitFailures(file.text));
      if (tests.length) {
        for (const { test, signature } of tests) out.push({ test, category, signature, inClosure: io.inClosure(run.head_sha, { test, category }) });
        continue;
      }
    }
    if (!out.some(f => f.test === null && f.category === category)) out.push({ test: null, category, signature: fallback, inClosure: io.inClosure(run.head_sha, { test: null, category }) });
  }
  return out;
}

/** Parses the exact record snapshot a main run printed as included in its selection. */
export function includedRedSet(log: string): IncludedRedSet | null {
  const line = log.split("\n").find(entry => entry.includes("BRAIN_RED_MAIN_INCLUDED "));
  if (!line) return null;
  try { return JSON.parse(line.slice(line.indexOf("BRAIN_RED_MAIN_INCLUDED ") + 24)); } catch { return null; }
}

async function search(io: CoordinatorIO, query: string): Promise<{ number: number; title: string; body?: string }[]> {
  const result = await io.json(`search/issues?q=${encodeURIComponent(`repo:${io.repository} is:issue is:open ${query}`)}&per_page=20`);
  return result.items ?? [];
}

/** Exactly one incident issue per record: the record and a body marker both deduplicate. */
export async function ensureIncident(io: CoordinatorIO, record: RedMainRecord): Promise<RedMainRecord> {
  const open = record.open;
  if (!open || open.incident !== null) return record;
  const marker = incidentMarker(open.run);
  let number = (await search(io, `"brain-red-main: run ${open.run}" in:body`)).find(issue => issue.body?.includes(marker))?.number;
  if (!number) {
    const related = new Set<number>();
    for (const failure of open.failures.filter(f => f.test)) for (const issue of await search(io, `"${failure.test}" in:title,body`)) related.add(issue.number);
    const lines = [
      marker,
      `Main is red at \`${open.firstBad}\` (first failing main run: ${runUrl(io, open.run)}).`,
      "",
      "Failing tests and categories:",
      ...open.failures.map(f => `- \`${f.test ?? f.category}\` (${f.category}; ${f.reasons.join(", ")}; run ${runUrl(io, f.run)})`),
      "",
      postMergeOnly(open.failures)
        ? "Every failure here is post-merge proof, which ready confirmation does not run, so ordinary confirmation and merges continue. Each main run includes this failing set until one is green."
        : "Hosted proof whose merge ref contains this commit is refused or cancelled, and `integrate.ts` refuses ordinary confirmation and merges, until a main run that includes this failing set is green.",
      "Declare a fix or targeted revert PR with `bun scripts/integrate.ts declare-fix <pr>`; the first confirmed fix wins. Only a green main run that includes this failing set clears the record, so a failure that does not reproduce still needs a declared fix to land.",
      "",
      "One orchestrator owns the fix: it claims it with `bun scripts/red-main-incident.ts claim --worker <id> --orchestrator <id>`, which writes the claim into the red-main record. After a quick assessment the claimant chooses a fix PR or a targeted revert PR from causal and current-tree evidence, and records that choice and its rationale here as `decision` evidence; a red check or the latest squash alone is not proof of cause. Every other orchestrator adds evidence here with `bun scripts/red-main-incident.ts evidence ...` instead of opening another issue.",
      ...(related.size ? ["", `Possibly related open issues: ${[...related].sort((a, b) => a - b).map(n => `#${n}`).join(", ")}.`] : []),
    ];
    const issue = await io.write("POST", `repos/${io.repository}/issues`, {
      title: `ci: main red at ${short(open.firstBad)}: ${open.failures[0]!.test ?? open.failures[0]!.category}`,
      body: lines.join("\n"), labels: ["type: fix", "area: ci"] });
    number = issue.number as number;
  }
  const { after } = await updateRecord(io, (current, now) => current.open?.run === open.run && current.open.incident === null ? attachIncident(current, number!, now) : current);
  return after;
}

/** Files or updates the issue of a suspected flake, whatever the probe result. */
export async function noteFlake(io: CoordinatorIO, key: string, text: string, existing: number | null): Promise<number> {
  const marker = flakeMarker(key);
  const number = existing ?? (await search(io, `"brain-flake: ${key}" in:body`)).find(issue => issue.body?.includes(marker))?.number;
  if (number) { await io.write("POST", `repos/${io.repository}/issues/${number}/comments`, { body: text }); return number; }
  const issue = await io.write("POST", `repos/${io.repository}/issues`, {
    title: `test: suspected flake in ${key}`, labels: ["type: test", "area: ci"],
    body: `${marker}\nThe red-main coordinator suspected a flake in \`${key}\`. A rerun is only a triage probe: it never turns proof green. A second suspected flake within the window is treated as a real failure.\n\n${text}` });
  return issue.number as number;
}

/**
 * Cancels queued and in-progress PR proof whose tested merge ref contains the bad
 * commit, except declared fixes (#3321). The merge ref contains it when the PR's
 * base or head at run creation descends from it; unknown ancestry leaves the run alone.
 */
export async function cancelDoomed(io: CoordinatorIO, record: RedMainRecord): Promise<number[]> {
  const open = record.open;
  if (!open) return [];
  const landed = io.commitTime(open.firstBad), cancelled: number[] = [];
  for (const status of ["queued", "in_progress"]) {
    const runs = await io.json(`repos/${io.repository}/actions/workflows/ci.yml/runs?event=pull_request&status=${status}&per_page=100`);
    for (const run of (runs.workflow_runs ?? []) as WorkflowRun[]) {
      const prs = run.pull_requests ?? [];
      // A run created before the bad commit landed cannot test a merge ref containing it.
      if (!prs.length || Date.parse(run.created_at) < landed) continue;
      let doomed: boolean;
      try {
        // Without the recorded base the merge ref is unknown, so the run is not doomed.
        doomed = prs.every(pr => gateDecision({ record, pr: pr.number,
          contains: sha => pr.base?.sha !== undefined && (io.isAncestor(sha, pr.base.sha) || io.isAncestor(sha, run.head_sha)) }).refuse);
      } catch (error) {
        io.print(`left run ${run.id} alone: ancestry of ${short(open.firstBad)} unknown (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      if (!doomed) continue;
      await io.write("POST", `repos/${io.repository}/actions/runs/${run.id}/cancel`);
      cancelled.push(run.id);
    }
  }
  return cancelled;
}

/** Reports a non-fix squash that landed on main while the record was open. */
export async function detectLanded(io: CoordinatorIO, record: RedMainRecord, run: WorkflowRun): Promise<boolean> {
  const open = record.open, sha = run.head_sha;
  if (!open || sha === open.firstBad || open.reported.includes(sha) || !io.isAncestor(open.firstBad, sha)) return false;
  // Landing while only post-merge proof is red is the hybrid model's normal path, not a bypass.
  if (postMergeOnly(open.failures)) return false;
  const pulls = await io.json(`repos/${io.repository}/commits/${sha}/pulls`);
  const pr = (pulls as { number: number; merged_at: string | null }[]).find(p => p.merged_at)?.number;
  if (!pr || open.fixes.includes(pr)) return false;
  const incident = open.incident ? `incident #${open.incident}` : "the open red-main record";
  await io.write("POST", `repos/${io.repository}/issues/${pr}/comments`, { body: `This PR's squash \`${sha}\` landed on main while main was red at \`${open.firstBad}\` (${incident}) without being a declared fix. Merge blocking while red is cooperative; this report is the detection.` });
  if (open.incident) await io.write("POST", `repos/${io.repository}/issues/${open.incident}/comments`, { body: `Squash \`${sha}\` from #${pr} landed while red without being a declared fix (main run ${runUrl(io, run.id)}).` });
  await io.recordEvent({ kind: "incident", pr, run: run.id, evidence: open.incident ? issueUrl(io, open.incident) : runUrl(io, run.id) });
  await updateRecord(io, (current, now) => reportLanded(current, sha, now));
  return true;
}

export async function dispatchProbe(io: CoordinatorIO, purpose: "flake" | "bisect", source: number, sha: string, tests: string[]) {
  await io.write("POST", `repos/${io.repository}/actions/workflows/${PROBE_WORKFLOW}/dispatches`, {
    ref: "main", inputs: { purpose, source_run: String(source), sha, tests: JSON.stringify(tests) } });
}

/** Last earlier main run where the failing category's job actually ran green. */
async function lastGreen(io: CoordinatorIO, run: WorkflowRun, category: Category): Promise<string | null> {
  const runs = await io.json(`repos/${io.repository}/actions/workflows/ci.yml/runs?event=push&branch=main&status=completed&per_page=30`);
  for (const earlier of ((runs.workflow_runs ?? []) as WorkflowRun[]).filter(r => r.id !== run.id && r.head_sha !== run.head_sha && io.isAncestor(r.head_sha, run.head_sha))) {
    const jobs: Job[] = (await io.json(`repos/${io.repository}/actions/runs/${earlier.id}/attempts/${earlier.run_attempt}/jobs?per_page=100`)).jobs ?? [];
    if (jobs.some(job => jobCategory(job.name) === category && job.conclusion === "success") &&
        !jobs.some(job => jobCategory(job.name) === category && job.conclusion !== "success" && job.conclusion !== "skipped")) return earlier.head_sha;
  }
  return null;
}

async function handleMainRun(io: CoordinatorIO, run: WorkflowRun) {
  const jobs: Job[] = (await io.json(`repos/${io.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)).jobs ?? [];
  const start = io.read().redMain;
  // Detection uses the record as it stood before this run's own result.
  if (start.open) await detectLanded(io, start, run);
  if (run.conclusion === "success") {
    const metadata = jobs.find(job => job.name === "changeset");
    const included = metadata ? includedRedSet(await io.log(metadata.id)) : null;
    if (start.open && coversRedSet(start, included)) {
      const { after } = await updateRecord(io, (current, now) => coversRedSet(current, included)
        ? clearRed(current, { id: run.id, conclusion: "success", included }, now) : current);
      if (!after.open && start.open.incident) await io.write("POST", `repos/${io.repository}/issues/${start.open.incident}/comments`, { body: `Main is green again: run ${runUrl(io, run.id)} at \`${run.head_sha}\` included the failing set and passed. The red-main record is cleared.` });
      io.print(`cleared red-main record ${start.open.firstBad}`);
    }
    return;
  }
  if (run.conclusion !== "failure") return;
  const evidence = await runFailures(io, run, jobs), now = await io.now();
  const real: RedFailure[] = [], suspects: FailureEvidence[] = [];
  for (const failure of evidence) {
    const verdict = classifyFailure(failure, io.read().redMain, now);
    io.print(`BRAIN_FLAKE_ESTIMATE ${JSON.stringify({ test: failure.test, category: failure.category, ...verdict })}`);
    if (verdict.verdict === "real") real.push({ test: failure.test, category: failure.category, verdict: "real", reasons: verdict.reasons, run: run.id, sha: run.head_sha });
    else suspects.push(failure);
  }
  for (const suspect of suspects) {
    const key = failureKey(suspect);
    await updateRecord(io, (current, at) => addSuspect(current, { test: key, category: suspect.category, run: run.id, sha: run.head_sha, at }, at));
    const issue = await noteFlake(io, key, `Suspected flake in main run ${runUrl(io, run.id)} at \`${run.head_sha}\` (${suspect.signature} signature, ${suspect.inClosure === false ? "outside" : "inside"} the commit's affected closure).${suspect.test ? " A triage probe reruns only this test file at that SHA." : " No single-file probe exists for this category; the next suspected flake escalates to real."}`, null);
    await updateRecord(io, (current, at) => settleSuspect(current, { test: key, run: run.id }, { issue, ...(suspect.test ? {} : { probe: "unavailable" }) }, at));
  }
  const probeTests = suspects.flatMap(s => s.test ? [s.test] : []);
  if (probeTests.length) await dispatchProbe(io, "flake", run.id, run.head_sha, probeTests);
  if (!real.length) return;
  // First bad: the first red after the last run where the failing category actually ran green.
  // With several failing categories, the oldest of their last greens bounds the range;
  // a category with no green run in the window keeps the conservative current SHA.
  let firstBad = run.head_sha, range: string[] = [];
  const greens = await Promise.all([...new Set(real.map(f => f.category))].map(category => lastGreen(io, run, category)));
  if (greens.length && greens.every(green => green !== null)) {
    const oldest = greens.find(green => greens.every(other => other === green || io.isAncestor(green!, other!)))!;
    range = oldest ? io.range(oldest, run.head_sha) : [];
    if (range.length) firstBad = range[0]!;
  }
  const { after } = await updateRecord(io, (current, at) => openRed(current, { firstBad, run: run.id, failures: real }, at));
  const withIncident = await ensureIncident(io, after);
  const tests = real.flatMap(f => f.test ? [f.test] : []);
  // Probe each candidate commit with only the failing test files.
  if (range.length > 1 && range.length <= MAX_BISECT && tests.length) for (const sha of range) await dispatchProbe(io, "bisect", run.id, sha, tests);
  const cancelled = await cancelDoomed(io, withIncident);
  io.print(`BRAIN_RED_MAIN ${JSON.stringify({ firstBad: withIncident.open?.firstBad, incident: withIncident.open?.incident, cancelled })}`);
}

/**
 * Probe run names carry their purpose, source run and SHA; tests come from the record.
 * `fix` probes are expedited fix evidence for integrate.ts (#2940) and are ignored here.
 */
export function probeIdentity(title: string): { purpose: "flake" | "bisect"; source: number; sha: string } | null {
  const match = /^red-main probe (flake|bisect) ([1-9]\d*) ([a-f0-9]{40})$/.exec(title);
  return match ? { purpose: match[1] as "flake" | "bisect", source: Number(match[2]), sha: match[3]! } : null;
}

async function handleProbe(io: CoordinatorIO, run: WorkflowRun) {
  const identity = probeIdentity(run.display_title);
  if (!identity || run.status !== "completed") return;
  const failed = run.conclusion === "failure", result = failed ? "failed" : run.conclusion === "success" ? "passed" : "unavailable";
  if (identity.purpose === "bisect") {
    // Starts at the earliest candidate after the last green run. A passing probe proves the
    // first bad commit is later; a failing probe proves it is no later than the probed SHA.
    if (result === "unavailable") return;
    const { before, after } = await updateRecord(io, (current, now) => {
      const open = current.open;
      if (!open || open.run !== identity.source) return current;
      if (failed) return io.isAncestor(identity.sha, open.firstBad) && identity.sha !== open.firstBad ? refineFirstBad(current, identity.sha, run.id, now) : current;
      if (!io.isAncestor(open.firstBad, identity.sha)) return current;
      const later = io.range(identity.sha, open.failures[0]!.sha)[0];
      return later ? refineFirstBad(current, later, run.id, now) : current;
    });
    if (after !== before && after.open?.incident) await io.write("POST", `repos/${io.repository}/issues/${after.open.incident}/comments`, { body: `Bisect probe ${runUrl(io, run.id)} ${failed ? "reproduced" : "passed"} at \`${identity.sha}\`; the record's first bad SHA is now \`${after.open.firstBad}\`.` });
    return;
  }
  const pending = io.read().redMain.suspects.filter(s => s.run === identity.source && s.sha === identity.sha && s.probe === "pending");
  const real: RedFailure[] = [];
  for (const suspect of pending) {
    await updateRecord(io, (current, now) => settleSuspect(current, { test: suspect.test, run: suspect.run }, { probe: result }, now));
    await noteFlake(io, suspect.test, `Triage probe ${runUrl(io, run.id)} at \`${identity.sha}\`: **${result}**. ${failed ? "The failure reproduced; main is declared red." : "A passing probe does not turn the original run green."}`, suspect.issue);
    if (failed) real.push({ test: suspect.test.startsWith("category:") ? null : suspect.test, category: suspect.category, verdict: "real", reasons: ["probe-reproduced"], run: identity.source, sha: identity.sha });
  }
  if (!real.length) return;
  const { after } = await updateRecord(io, (current, now) => openRed(current, { firstBad: identity.sha, run: identity.source, failures: real }, now));
  await cancelDoomed(io, await ensureIncident(io, after));
}

export async function coordinate(io: CoordinatorIO, run: WorkflowRun) {
  if (run.name === "CI" && run.event === "push" && run.head_branch === "main" && run.status === "completed") await handleMainRun(io, run);
  else if (run.name === "red-main-probe") await handleProbe(io, run);
}
