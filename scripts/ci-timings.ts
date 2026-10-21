/** Read-only CI timing archive. Logs are data; no candidate code is executed. */
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface TimingAPI { json(path: string): Promise<any>; log(job: number): Promise<string>; }
interface RawRun {
  id: number; run_attempt: number; name: string; path: string; event: string;
  head_sha: string; head_branch: string; created_at: string; run_started_at?: string;
  head_repository?: { full_name: string };
  status: string; conclusion: string | null; pull_requests?: { number: number }[];
}
interface RawStep { name: string; number: number; status: string; conclusion: string | null; started_at?: string; completed_at?: string; }
interface RawJob {
  id: number; run_id: number; run_attempt?: number; name: string; status: string;
  conclusion: string | null; started_at?: string; completed_at?: string; labels?: string[]; steps?: RawStep[];
}
export interface TimingJob {
  id: number; name: string; category: string; conclusion: string | null; labels: string[];
  execution: "observed" | "excluded" | "retained" | "unobserved";
  startedAt: string | null; completedAt: string | null; seconds: number | null;
  steps: { number: number; name: string; conclusion: string | null; seconds: number | null }[];
  resource: Resource | null; resourceProblem: string | null;
}
interface Resource {
  category: string; shard?: string; checkout: { sha: string; tree: string; parents: string[] };
  elapsedSeconds: number; phases: { name: string; elapsedSeconds: number; success: boolean }[];
  machine: { logicalCpus: number; totalBytes: number; activeCpuSeconds: number; sampledPeakUsedBytes: number };
}
export interface TimingSnapshot {
  version: 1; repository: string; collectedAt: string;
  run: { id: number; attempt: number; workflow: string; path: string; event: string; head: string;
    branch?: string; headRepository?: string;
    createdAt: string; startedAt: string | null; status: string; conclusion: string | null;
    prs: number[]; attribution: string };
  jobs: TimingJob[]; problems: string[];
  selection?: { selections: Record<string, string>; retained: string[] };
  selectionProblem?: string;
}
const WORKFLOWS = ["ci.yml", "contract.yml"];
const CATEGORIES = ["verify", "pack", "unit", "browser", "layout", "captures", "runtime", "runtime_host", "endurance"];
const SHA = /^[a-f0-9]{40}$/;
const validSeconds = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
export function seconds(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const elapsed = (Date.parse(end) - Date.parse(start)) / 1000;
  return validSeconds(elapsed) ? elapsed : null;
}
export function category(name: string): string {
  return name.replace(/ \(.*\)$/, "").replace(/^(?:integrated or exhaustive proof|draft gates)$/, "proof");
}

/** A timestamp on a cancelled queued job is not evidence of execution. */
export function normalizeJob(job: RawJob): TimingJob {
  const observed = job.steps?.some(step => ["completed", "in_progress"].includes(step.status) &&
    step.conclusion !== "skipped" && Number.isFinite(Date.parse(step.started_at ?? "")));
  const execution = job.conclusion === "skipped" ? "excluded" : observed ? "observed" : "unobserved";
  return { id: job.id, name: job.name, category: category(job.name), conclusion: job.conclusion,
    labels: job.labels ?? [], execution, startedAt: job.started_at ?? null, completedAt: job.completed_at ?? null,
    seconds: execution === "observed" ? seconds(job.started_at, job.completed_at) : null,
    steps: (job.steps ?? []).map(step => ({ number: step.number, name: step.name, conclusion: step.conclusion,
      seconds: step.conclusion === "skipped" ? null : seconds(step.started_at, step.completed_at) })),
    resource: null, resourceProblem: null };
}

/** Preserve original checkout identity, but never interpret a timing receipt as proof. */
export function resourceFromLog(log: string, expectedCategory: string): Resource {
  const rows = log.split("\n").filter(line => line.includes("BRAIN_RESOURCE_RECEIPT "));
  if (rows.length !== 1) throw new Error("Resource receipt missing or ambiguous");
  const value = JSON.parse(rows[0]!.split("BRAIN_RESOURCE_RECEIPT ")[1]!) as Resource;
  if (value.category !== expectedCategory || !SHA.test(value.checkout?.sha) || !SHA.test(value.checkout?.tree) ||
    !Array.isArray(value.checkout?.parents) || value.checkout.parents.some(p => !SHA.test(p)) ||
    !validSeconds(value.elapsedSeconds) || !Array.isArray(value.phases) || value.phases.some(p =>
      typeof p.name !== "string" || !validSeconds(p.elapsedSeconds) || typeof p.success !== "boolean") ||
    ![value.machine?.logicalCpus, value.machine?.totalBytes, value.machine?.activeCpuSeconds,
      value.machine?.sampledPeakUsedBytes].every(validSeconds)) throw new Error("Invalid resource receipt");
  // Whitelist fields rather than archiving arbitrary log content.
  return { category: value.category, shard: value.shard,
    checkout: { sha: value.checkout.sha, tree: value.checkout.tree, parents: value.checkout.parents },
    elapsedSeconds: value.elapsedSeconds,
    phases: value.phases.map(p => ({ name: p.name, elapsedSeconds: p.elapsedSeconds, success: p.success })),
    machine: { logicalCpus: value.machine.logicalCpus, totalBytes: value.machine.totalBytes,
      activeCpuSeconds: value.machine.activeCpuSeconds, sampledPeakUsedBytes: value.machine.sampledPeakUsedBytes } };
}

/** GitHub limits filtered run searches to 1,000; split instead of truncating. */
export async function discoverRuns(api: TimingAPI, workflow: string, since: string, until: string): Promise<RawRun[]> {
  if (!WORKFLOWS.includes(workflow) || !Number.isFinite(Date.parse(since)) || Date.parse(until) <= Date.parse(since)) throw new Error("Invalid workflow/time interval");
  const query = `actions/workflows/${workflow}/runs?per_page=100&created=${encodeURIComponent(`${since}..${until}`)}`;
  const first = await api.json(query + "&page=1");
  if (!Number.isSafeInteger(first.total_count) || first.total_count < 0 || !Array.isArray(first.workflow_runs)) throw new Error("Invalid run inventory");
  if (first.total_count >= 1000) {
    const mid = Math.floor((Date.parse(since) + Date.parse(until)) / 2000) * 1000;
    if (mid <= Date.parse(since) || mid >= Date.parse(until)) throw new Error("Run search cap cannot be split further");
    return uniqueRuns([...(await discoverRuns(api, workflow, since, new Date(mid).toISOString())),
      ...(await discoverRuns(api, workflow, new Date(mid).toISOString(), until))]);
  }
  const rows: RawRun[] = [...first.workflow_runs];
  for (let page = 2; rows.length < first.total_count; page++) {
    const next = await api.json(query + `&page=${page}`);
    if (!Array.isArray(next.workflow_runs) || !next.workflow_runs.length) throw new Error("Incomplete run pagination");
    rows.push(...next.workflow_runs);
  }
  if (uniqueRuns(rows).length !== first.total_count) throw new Error("Incomplete or changing run inventory; recollect the fixed interval");
  return uniqueRuns(rows).filter(run => Date.parse(run.created_at) >= Date.parse(since) && Date.parse(run.created_at) <= Date.parse(until));
}
function uniqueRuns(rows: RawRun[]): RawRun[] { return [...new Map(rows.map(row => [row.id, row])).values()]; }

export async function collectAttempt(api: TimingAPI, repository: string, raw: RawRun, attempt: number,
  resources: boolean, now = new Date().toISOString()): Promise<TimingSnapshot> {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > raw.run_attempt) throw new Error("Run attempt identity mismatch");
  const run: RawRun = attempt === raw.run_attempt ? raw : await api.json(`actions/runs/${raw.id}/attempts/${attempt}`);
  if (run.id !== raw.id || run.run_attempt !== attempt || !SHA.test(run.head_sha) ||
    !WORKFLOWS.some(w => run.path === `.github/workflows/${w}`)) throw new Error("Run attempt identity mismatch");
  const snapshot: TimingSnapshot = { version: 1, repository, collectedAt: now,
    run: { id: run.id, attempt, workflow: run.name, path: run.path, event: run.event, head: run.head_sha,
      branch: run.head_branch, headRepository: run.head_repository?.full_name,
      createdAt: run.created_at, startedAt: run.run_started_at ?? null, status: run.status, conclusion: run.conclusion,
      prs: [...new Set((run.pull_requests ?? raw.pull_requests ?? []).map(pr => pr.number))], attribution: "run payload" }, jobs: [], problems: [] };
  const jobs: RawJob[] = [];
  try {
    for (let page = 1; ; page++) {
      const result = await api.json(`actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
      if (!Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count) || result.total_count < 0) throw new Error("Invalid job inventory");
      jobs.push(...result.jobs);
      if (jobs.length >= result.total_count) break;
      if (!result.jobs.length) throw new Error("Incomplete job pagination");
    }
    if (new Set(jobs.map(j => j.id)).size !== jobs.length || jobs.some(j => j.run_id !== run.id || (j.run_attempt !== undefined && j.run_attempt !== attempt))) throw new Error("Job identity mismatch");
  } catch (error) { snapshot.problems.push(String(error)); return snapshot; }
  if (!jobs.length && run.status === "completed") snapshot.problems.push("Completed attempt has no available jobs");
  for (const rawJob of jobs) {
    const job = normalizeJob(rawJob);
    if (resources && job.execution === "observed" && CATEGORIES.includes(job.category) && !["verify", "pack"].includes(job.category)) {
      try { job.resource = resourceFromLog(await api.log(job.id), job.category); }
      catch (error) { job.resourceProblem = String(error); }
    }
    snapshot.jobs.push(job);
  }
  if (resources) {
    const aggregate = snapshot.jobs.find(j => j.category === "proof" && j.execution === "observed");
    if (aggregate) {
      try {
        const log = await api.log(aggregate.id);
        const rows = log.split("\n").filter(line => line.includes("BRAIN_SELECTED_PROOF_RECEIPT "));
        if (rows.length !== 1) throw new Error("Selected-proof timing metadata missing or ambiguous");
        const receipt = JSON.parse(rows[0]!.split("BRAIN_SELECTED_PROOF_RECEIPT ")[1]!);
        if (!Array.isArray(receipt.retained) || receipt.retained.some((c: unknown) => c !== "browser" && c !== "layout") ||
          !CATEGORIES.every(c => ["true", "false"].includes(receipt.selections?.[c]))) throw new Error("Invalid selected-proof timing metadata");
        snapshot.selection = { selections: Object.fromEntries(CATEGORIES.map(c => [c, receipt.selections[c]])), retained: receipt.retained };
        for (const job of snapshot.jobs) if (job.execution === "excluded" && receipt.retained.includes(job.category)) job.execution = "retained";
      } catch (error) { snapshot.selectionProblem = String(error); }
    }
  }
  return snapshot;
}

export function stats(values: number[]) {
  const sorted = values.filter(validSeconds).sort((a, b) => a - b), n = sorted.length;
  return { n, mean: n ? sorted.reduce((a, b) => a + b, 0) / n : null,
    median: n ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.floor(n / 2)]!) / 2 : null,
    p90: n ? sorted[Math.ceil(n * .9) - 1]! : null };
}
function executionSeconds(snapshot: TimingSnapshot): number {
  return snapshot.jobs.reduce((sum, job) => sum + (job.seconds ?? 0), 0);
}
function end(snapshot: TimingSnapshot): string | null {
  if (snapshot.run.status !== "completed" || snapshot.problems.length || !snapshot.jobs.length) return null;
  const ends = snapshot.jobs.filter(job => job.execution === "observed").map(job => job.completedAt)
    .filter((v): v is string => Boolean(v) && Number.isFinite(Date.parse(v!)));
  return ends.sort().at(-1) ?? null;
}

/** Overlapping archives/reruns are not additional executions of the same job. */
export function deduplicate(snapshots: TimingSnapshot[]): TimingSnapshot[] {
  const result = new Map<string, TimingSnapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.version !== 1 || !/^[\w.-]+\/[\w.-]+$/.test(snapshot.repository) || !Number.isSafeInteger(snapshot.run?.id) || !Number.isSafeInteger(snapshot.run.attempt) || !Array.isArray(snapshot.jobs) || !Array.isArray(snapshot.problems)) throw new Error("Invalid timing snapshot");
    const key = `${snapshot.repository}/${snapshot.run.id}/${snapshot.run.attempt}`;
    const old = result.get(key);
    if (!old) { result.set(key, structuredClone(snapshot)); continue; }
    if (old.run.head !== snapshot.run.head || old.run.path !== snapshot.run.path) throw new Error("Conflicting archive identity");
    const newer = Date.parse(old.collectedAt) <= Date.parse(snapshot.collectedAt) ? snapshot : old;
    const older = newer === snapshot ? old : snapshot;
    const merged = structuredClone(newer);
    if (!merged.run.prs.length && older.run.attribution === "exact merged squash SHA") {
      merged.run.prs = older.run.prs; merged.run.attribution = older.run.attribution;
    }
    if (!merged.selection && older.selection) merged.selection = older.selection;
    for (const job of merged.jobs) {
      const previous = older.jobs.find(j => j.id === job.id);
      if (!job.resource && previous?.resource) { job.resource = previous.resource; job.resourceProblem = null; }
      if (job.execution === "excluded" && merged.selection?.retained.includes(job.category)) job.execution = "retained";
    }
    result.set(key, merged);
  }
  return [...result.values()].sort((a, b) => a.run.id - b.run.id || a.run.attempt - b.run.attempt);
}

export function summarize(input: TimingSnapshot[]) {
  const snapshots = deduplicate(input), ci = snapshots.filter(s => s.run.path === ".github/workflows/ci.yml");
  if (new Set(snapshots.map(s => s.repository)).size > 1) throw new Error("Report one repository at a time");
  const jobsSeen = new Set<number>();
  for (const snapshot of snapshots) for (const job of snapshot.jobs) {
    if (jobsSeen.has(job.id)) throw new Error("Job appears in more than one attempt; reconcile its original attempt before accounting");
    jobsSeen.add(job.id);
  }
  const buckets = new Map<string, number[]>(), steps = new Map<string, number[]>(), commands = new Map<string, number[]>();
  const add = (map: Map<string, number[]>, key: string, value: number | null) => {
    if (value !== null) map.set(key, [...(map.get(key) ?? []), value]);
  };
  for (const s of snapshots) for (const j of s.jobs) {
    add(buckets, `${s.run.event}/${j.category}`, j.seconds);
    if (j.execution === "observed") for (const step of j.steps) add(steps, `${s.run.event}/${j.category}/${step.name}`, step.seconds);
    for (const phase of j.resource?.phases ?? []) if (phase.success) add(commands, `${s.run.event}/${j.category}/${phase.name}`, phase.elapsedSeconds);
  }
  const prs = [...new Set(snapshots.flatMap(s => s.run.prs))].sort((a, b) => a - b).map(number => {
    const associated = ci.filter(s => s.run.prs.length === 1 && s.run.prs[0] === number);
    const pre = associated.filter(s => s.run.event === "pull_request"), post = associated.filter(s => s.run.event === "push");
    return { number, preAttempts: pre.length, postAttempts: post.length,
      observedPreRunnerSeconds: pre.reduce((sum, s) => sum + executionSeconds(s), 0),
      observedPostRunnerSeconds: post.reduce((sum, s) => sum + executionSeconds(s), 0),
      pairedInWindow: pre.length > 0 && post.length > 0 };
  });
  // Historical exhaustive runs are a proxy, not a same-source counterfactual.
  const baseline = ci.filter(s => ["schedule", "workflow_dispatch"].includes(s.run.event) && s.run.conclusion === "success" && !s.problems.length &&
    CATEGORIES.every(c => s.jobs.some(j => j.category === c)) && s.jobs.every(j => j.execution === "observed" && j.seconds !== null && j.conclusion === "success"));
  const baselineStats = stats(baseline.map(executionSeconds));
  const baselineElapsed = stats(baseline.flatMap(s => { const n = seconds(s.run.startedAt, end(s)); return n === null ? [] : [n]; }));
  const paired = prs.filter(pr => pr.pairedInWindow);
  return { version: 1, coverage: { runAttempts: snapshots.length, runs: new Set(snapshots.map(s => `${s.repository}/${s.run.id}`)).size,
      prs: prs.length, pairedPRs: paired.length, incompleteAttempts: snapshots.filter(s => s.problems.length || s.run.status !== "completed").length,
      jobs: snapshots.reduce((n, s) => n + s.jobs.length, 0),
      unobservedJobs: snapshots.flatMap(s => s.jobs).filter(j => j.execution === "unobserved").length,
      observedJobsWithoutDuration: snapshots.flatMap(s => s.jobs).filter(j => j.execution === "observed" && j.seconds === null).length,
      resourceReceipts: snapshots.flatMap(s => s.jobs).filter(j => j.resource).length,
      retainedJobs: snapshots.flatMap(s => s.jobs).filter(j => j.execution === "retained").length,
      excludedOrUnresolvedSkippedJobs: snapshots.flatMap(s => s.jobs).filter(j => j.execution === "excluded").length,
      resourceProblems: snapshots.flatMap(s => s.jobs).filter(j => j.resourceProblem).length,
      unattributedCIAttempts: ci.filter(s => ["pull_request", "push"].includes(s.run.event) && s.run.prs.length !== 1).length },
    observedRunnerSeconds: snapshots.reduce((sum, s) => sum + executionSeconds(s), 0),
    cancelledAttemptRunnerSeconds: snapshots.filter(s => s.run.conclusion === "cancelled").reduce((sum, s) => sum + executionSeconds(s), 0),
    failedAttemptRunnerSeconds: snapshots.filter(s => s.run.conclusion === "failure").reduce((sum, s) => sum + executionSeconds(s), 0),
    attemptElapsedSeconds: stats(snapshots.flatMap(s => { const n = seconds(s.run.startedAt, end(s)); return n === null ? [] : [n]; })),
    initialQueueSeconds: stats(snapshots.flatMap(s => {
      // run.created_at is the original request, not the rerun request.
      if (s.run.attempt !== 1) return [];
      const first = s.jobs.filter(j => j.execution === "observed").map(j => j.startedAt).filter((v): v is string => !!v).sort()[0];
      const n = seconds(s.run.createdAt, first); return n === null ? [] : [n];
    })),
    ciByEvent: Object.fromEntries([...new Set(ci.map(s => s.run.event))].sort().map(event => {
      const rows = ci.filter(s => s.run.event === event);
      return [event, { attempts: rows.length, observedRunnerSeconds: rows.reduce((sum, s) => sum + executionSeconds(s), 0),
        elapsedSeconds: stats(rows.flatMap(s => { const n = seconds(s.run.startedAt, end(s)); return n === null ? [] : [n]; })) }];
    })),
    successfulCandidateElapsedSeconds: stats(ci.filter(s => s.run.event === "pull_request" && s.run.conclusion === "success" &&
      s.jobs.some(j => j.name === "proof" && j.conclusion === "success")).flatMap(s => {
        const n = seconds(s.run.startedAt, end(s)); return n === null ? [] : [n];
      })),
    categories: Object.fromEntries([...buckets].sort().map(([key, values]) => [key, stats(values)])),
    steps: Object.fromEntries([...steps].sort().map(([key, values]) => [key, stats(values)])),
    commands: Object.fromEntries([...commands].sort().map(([key, values]) => [key, stats(values)])), prs,
    baseline: { label: "Historical successful exhaustive-run proxy; different source/queue conditions, not measured savings",
      samples: baseline.map(s => ({ run: s.run.id, attempt: s.run.attempt, head: s.run.head, runnerSeconds: executionSeconds(s),
        labels: [...new Set(s.jobs.flatMap(j => j.labels))].sort() })), runnerSeconds: baselineStats, elapsedSeconds: baselineElapsed,
      estimatedElapsedPerPRBeforeAndAfter: baselineElapsed.median === null ? null : 2 * baselineElapsed.median,
      pairedObservedCIRunnerSeconds: paired.reduce((sum, pr) => sum + pr.observedPreRunnerSeconds + pr.observedPostRunnerSeconds, 0),
      onceBeforeAndAfterEstimate: baselineStats.median === null ? null : paired.length * 2 * baselineStats.median,
      everyAttemptEstimate: baselineStats.median === null ? null : paired.reduce((sum, pr) => sum + pr.preAttempts + pr.postAttempts, 0) * baselineStats.median },
    limitations: ["Observed runner time is a lower bound when jobs or execution timestamps are missing; unobserved cancellations are not measured zero.",
      "Averages include failures/cancellations where execution was observed. Successful command averages exclude failed phases.",
      "Windowed PR totals are not complete lifetime cost. Multiple-PR attribution is excluded from per-PR accounting.",
      "Queue is request-to-first-observed-job for first attempts only; dependent-job eligibility/queue is not reconstructed.",
      "Elapsed time ends at the last observed executed job completion, not a measured ready-to-merge or human review interval.",
      "Resource receipts are untrusted timing data, not validated passing proof. CPU/memory are VM-wide, not process peaks.",
      "No local checks, human review, reservation wait or exact counterfactual speedup is inferred."] };
}

export function markdown(report: ReturnType<typeof summarize>): string {
  const minutes = (n: number | null) => n === null ? "unknown" : (n / 60).toFixed(2);
  return ["# CI timing observations", "", `Run attempts: ${report.coverage.runAttempts}; PRs: ${report.coverage.prs}; paired pre/post PRs: ${report.coverage.pairedPRs}.`,
    `Observed runner minutes: ${minutes(report.observedRunnerSeconds)}; cancelled attempts: ${minutes(report.cancelledAttemptRunnerSeconds)}; failed attempts: ${minutes(report.failedAttemptRunnerSeconds)}.`, "",
    "| Event / category | Jobs | Mean min | Median min | p90 min |", "| --- | ---: | ---: | ---: | ---: |",
    ...Object.entries(report.categories).map(([key, value]) => `| ${key.replaceAll("|", "\\|")} | ${value.n} | ${minutes(value.mean)} | ${minutes(value.median)} | ${minutes(value.p90)} |`), "",
    "## Approximate full-proof comparison", "", report.baseline.label + ".",
    `Successful exhaustive samples: ${report.baseline.samples.length}; median runner minutes per full run: ${minutes(report.baseline.runnerSeconds.median)}.`,
    `Median full-run attempt elapsed minutes: ${minutes(report.baseline.elapsedSeconds.median)}; estimated combined pre/post elapsed minutes per PR: ${minutes(report.baseline.estimatedElapsedPerPRBeforeAndAfter)} (queue/review differences are not modeled).`,
    `For paired PRs only: observed CI runner minutes ${minutes(report.baseline.pairedObservedCIRunnerSeconds)}; estimated full proof once before and after ${minutes(report.baseline.onceBeforeAndAfterEstimate)}; estimated full proof on every observed attempt ${minutes(report.baseline.everyAttemptEstimate)}.`, "",
    "## Coverage", "", "```json", JSON.stringify(report.coverage, null, 2), "```", "", "## Limits", "",
    ...report.limitations.map(line => `- ${line}`), ""].join("\n");
}

async function gh(path: string, repository: string, log = false): Promise<string> {
  const child = Bun.spawn(["gh", "api", ...(log ? ["--allow-escape-sequences"] : []), `repos/${repository}/${path}`],
    { stdout: "pipe", stderr: "pipe", timeout: 60000 });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`GitHub evidence unavailable (${path}): ${err.trim()}`);
  return out;
}
async function readSnapshots(dir: string): Promise<TimingSnapshot[]> {
  const result: TimingSnapshot[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await readSnapshots(path));
    else if (/^run-\d+-attempt-\d+\.json$/.test(entry.name)) result.push(await Bun.file(path).json());
  }
  return result;
}
async function readCollections(dir: string): Promise<any[]> {
  const rows: any[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) rows.push(...await readCollections(join(dir, entry.name)));
    else if (entry.name === "collection.json") rows.push(await Bun.file(join(dir, entry.name)).json());
  }
  return rows;
}

interface PullIdentity { number: number; head: string; branch: string; repository: string | null; merge: string | null; }
export function attributePR(snapshot: TimingSnapshot, pulls: PullIdentity[]): void {
  if (snapshot.run.event === "push") {
    const matches = pulls.filter(p => p.merge === snapshot.run.head);
    snapshot.run.prs = [...new Set(matches.map(p => p.number))];
    snapshot.run.attribution = matches.length ? "exact merged squash SHA" : "unresolved exact squash lookup";
  } else if (snapshot.run.event === "pull_request" && !snapshot.run.prs.length) {
    const exact = pulls.filter(p => p.head === snapshot.run.head);
    const branch = pulls.filter(p => snapshot.run.headRepository && p.repository === snapshot.run.headRepository && p.branch === snapshot.run.branch);
    const matches = exact.length ? exact : branch;
    const numbers = [...new Set(matches.map(p => p.number))];
    if (numbers.length === 1) {
      snapshot.run.prs = numbers;
      snapshot.run.attribution = exact.length ? "exact PR head SHA" : "unique PR repository/branch (historical head not independently verified)";
    }
  }
}

async function pullIdentities(api: TimingAPI, since: string): Promise<PullIdentity[]> {
  const rows: PullIdentity[] = [];
  for (let page = 1; ; page++) {
    const pulls = await api.json(`pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`);
    if (!Array.isArray(pulls)) throw new Error("Invalid PR identity inventory");
    for (const p of pulls) rows.push({ number: p.number, head: p.head.sha, branch: p.head.ref,
      repository: p.head.repo?.full_name ?? null, merge: p.merged_at ? p.merge_commit_sha : null });
    if (pulls.length < 100 || Date.parse(pulls.at(-1).updated_at) < Date.parse(since)) break;
  }
  return rows;
}
async function writeReport(dir: string) {
  const snapshots = await readSnapshots(dir), collections = await readCollections(dir);
  const observed = new Set(snapshots.map(s => `${s.repository}/${s.run.id}/${s.run.attempt}`));
  const missing = new Set<string>();
  for (const c of collections) for (const r of c.expected ?? []) for (let attempt = 1; attempt <= r.attempts; attempt++) {
    const key = `${c.repository}/${r.run}/${attempt}`;
    if (!observed.has(key)) missing.add(key);
  }
  const report = { ...summarize(snapshots), collectionCoverage: { missingAttempts: [...missing],
    scopes: collections.map(c => ({ repository: c.repository, since: c.since, until: c.until, requestedRun: c.requestedRun,
      collectedAt: c.collectedAt, status: c.status, errors: c.errors })) } };
  await Bun.write(join(dir, "summary.json"), JSON.stringify(report, null, 2) + "\n");
  await Bun.write(join(dir, "summary.md"), markdown(report) + `\nMissing discovered attempts: ${missing.size}. See summary.json for collection windows and acquisition errors.\n`);
  return report;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2), mode = args.shift();
    const options = new Map<string, string>();
    let resources = false;
    while (args.length) {
      const flag = args.shift()!;
      if (flag === "--resources") { resources = true; continue; }
      if (!["--repo", "--since", "--until", "--run", "--out"].includes(flag) || !args.length || options.has(flag)) throw new Error("Invalid timing option");
      options.set(flag, args.shift()!);
    }
    const dir = resolve(options.get("--out") ?? "tmp/ci-timings");
    await mkdir(dir, { recursive: true });
    if (mode === "report") { await writeReport(dir); console.log(`Report written to ${dir}`); }
    else if (mode === "collect") {
      const repository = options.get("--repo") ?? "schlessera/brain-kit";
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
      const api: TimingAPI = { json: async path => JSON.parse(await gh(path, repository)), log: id => gh(`actions/jobs/${id}/logs`, repository, true) };
      const cutoff = options.get("--until") ?? new Date().toISOString();
      let runs: RawRun[];
      if (options.has("--run")) {
        if (!/^[1-9]\d*$/.test(options.get("--run")!)) throw new Error("Invalid run ID");
        runs = [await api.json(`actions/runs/${options.get("--run")}`)];
      } else {
        const since = options.get("--since");
        if (!since) throw new Error("Collection requires --run or --since");
        runs = [];
        for (const workflow of WORKFLOWS) runs.push(...await discoverRuns(api, workflow, since, cutoff));
      }
      console.log(`Discovered ${runs.length} runs; collecting attempts with four concurrent requests`);
      const errors: { run: number; attempt: number; error: string }[] = [];
      const collection = { version: 1, repository, collectedAt: new Date().toISOString(), status: "collecting",
        since: options.get("--since") ?? null, until: cutoff, requestedRun: options.get("--run") ?? null,
        expected: runs.map(r => ({ run: r.id, attempts: r.run_attempt })), resourcesRequested: resources, errors };
      await Bun.write(join(dir, "collection.json"), JSON.stringify(collection, null, 2) + "\n");
      let next = 0, done = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < runs.length) {
          const raw = runs[next++]!;
          for (let attempt = 1; attempt <= raw.run_attempt; attempt++) {
            const path = join(dir, `run-${raw.id}-attempt-${attempt}.json`);
            const previous: TimingSnapshot | null = await Bun.file(path).exists() ? await Bun.file(path).json() : null;
            if (previous && previous.repository !== repository) throw new Error("Output directory belongs to another repository");
            if (previous && !previous.run.branch) {
              previous.run.branch = raw.head_branch; previous.run.headRepository = raw.head_repository?.full_name;
              await Bun.write(path, JSON.stringify(previous, null, 2) + "\n");
            }
            if (previous?.repository === repository && previous.run.status === "completed" && !previous.problems.length &&
              (!resources || previous.jobs.every(j => !CATEGORIES.includes(j.category) || ["verify", "pack"].includes(j.category) || j.execution !== "observed" || j.resource))) continue;
            try {
              const fresh = await collectAttempt(api, repository, raw, attempt, resources);
              await Bun.write(path, JSON.stringify(previous ? deduplicate([previous, fresh])[0] : fresh, null, 2) + "\n");
            }
            catch (error) { errors.push({ run: raw.id, attempt, error: String(error) }); }
          }
          done++; if (done % 100 === 0) console.log(`Collected ${done}/${runs.length} runs`);
        }
      }));
      // Link main pushes only by exact squash identity, never by time proximity.
      const snapshots = await readSnapshots(dir);
      if (!options.has("--run")) {
        try {
          const pulls = await pullIdentities(api, options.get("--since")!);
          for (const s of snapshots) if (s.repository === repository) {
            attributePR(s, pulls);
            await Bun.write(join(dir, `run-${s.run.id}-attempt-${s.run.attempt}.json`), JSON.stringify(s, null, 2) + "\n");
          }
        } catch (error) { errors.push({ run: 0, attempt: 0, error: `PR attribution unavailable: ${String(error)}` }); }
      }
      const main = snapshots.filter(s => s.repository === repository && s.run.event === "push" && s.run.attribution !== "exact merged squash SHA");
      const byHead = new Map<string, number[]>();
      for (const s of main) {
        let numbers = byHead.get(s.run.head);
        if (!numbers) {
          try {
            const pulls = await api.json(`commits/${s.run.head}/pulls?per_page=100`);
            numbers = pulls.filter((p: any) => p.merged_at && p.merge_commit_sha === s.run.head && p.base?.repo?.full_name === repository).map((p: any) => p.number);
            byHead.set(s.run.head, numbers!);
          } catch { numbers = []; }
        }
        s.run.prs = numbers!; s.run.attribution = numbers!.length ? "exact merged squash SHA" : "unresolved exact squash lookup";
        await Bun.write(join(dir, `run-${s.run.id}-attempt-${s.run.attempt}.json`), JSON.stringify(s, null, 2) + "\n");
      }
      collection.status = "completed";
      await Bun.write(join(dir, "collection.json"), JSON.stringify(collection, null, 2) + "\n");
      const report = await writeReport(dir);
      console.log(JSON.stringify({ directory: dir, coverage: report.coverage, errors: errors.length }));
      if (errors.length || report.collectionCoverage.missingAttempts.length ||
        (await readSnapshots(dir)).some(s => s.problems.length)) process.exitCode = 1;
    } else throw new Error("usage: bun scripts/ci-timings.ts collect (--since ISO [--until ISO] | --run ID) [--resources] [--repo owner/repo] [--out DIR] | report [--out DIR]");
  } catch (error) { console.error(error); process.exitCode = 1; }
}
