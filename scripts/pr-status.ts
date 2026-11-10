/**
 * What a pull request's head is, whether its checks passed on that head, and
 * what failed, in one line. It replaces the dozen `gh` calls an agent
 * otherwise makes (and reads the output of) before every merge decision in
 * .agents/skills/work-issue/references/ci-and-merge.md.
 *
 *   bun scripts/pr-status.ts <pr> [--expect-head sha] [--expect-base sha]
 *   bun scripts/pr-status.ts <pr> --failures [--logs dir]
 *
 * Green is a claim about a SHA: every answer here is about the head it names.
 * `--expect-head` and `--expect-base` re-check an earlier inspection and exit
 * 1 when either moved, listing the files the base gained and which of them
 * the pull request also changes. `--failures` names each failed job and step;
 * with `--logs` it saves each failed job's log and prints only its failing
 * lines. This reads; it never reruns, merges or edits anything, and it does
 * not replace the proof checks of `scripts/integrate.ts`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_REPO, type Gh } from "./issue-queue";
import { RECEIPT_START } from "./check-receipt";

const realGh: Gh = args => {
  const result = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
};

function must(gh: Gh, args: string[]): string {
  const result = gh(args);
  if (result.code !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")}: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout;
}

interface Rollup { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string | null; state?: string }
export interface Checks { passed: number; skipped: number; pending: string[]; failed: Array<{ name: string; conclusion: string }> }

/** No rows is not green: `total` is zero when CI has not started on this head. */
export function summarizeChecks(rollup: readonly Rollup[]): Checks & { total: number; proof: "passed" | "failed" | "pending" | "absent" } {
  const checks: Checks = { passed: 0, skipped: 0, pending: [], failed: [] };
  let proof: "passed" | "failed" | "pending" | "absent" = "absent";
  for (const row of rollup) {
    const name = row.name ?? row.context ?? "(unnamed)";
    const outcome = (row.conclusion ?? row.state ?? "").toUpperCase();
    const done = row.__typename === "StatusContext" ? outcome !== "PENDING" && outcome !== "EXPECTED" : (row.status ?? "").toUpperCase() === "COMPLETED";
    const kind = !done ? "pending" : outcome === "SUCCESS" ? "passed" : outcome === "SKIPPED" || outcome === "NEUTRAL" ? "skipped" : "failed";
    if (kind === "pending") checks.pending.push(name);
    else if (kind === "failed") checks.failed.push({ name, conclusion: outcome.toLowerCase() });
    else checks[kind]++;
    // A skipped `proof` proves nothing; only its success is a pass.
    if (name === "proof") proof = kind === "passed" ? "passed" : kind === "pending" ? "pending" : "failed";
  }
  return { total: rollup.length, ...checks, proof };
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const FAILING = /\(fail\)|\berror\b[:\s]|\bError:|✗|\bFAIL\b|##\[error\]|Process completed with exit code [1-9]/;

/** The lines of a job log worth reading: failures, without timestamps or colour. */
export function failingLines(log: string, limit = 30): string[] {
  const lines = log.split("\n").map(line => line.replace(ANSI, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, "").trimEnd());
  const found = lines.filter(line => FAILING.test(line));
  return found.length > limit ? [...found.slice(0, limit), `(+${found.length - limit} more failing lines)`] : found;
}

export interface StatusIo { gh?: Gh; out: (text: string) => void }

export async function main(argv: readonly string[], io: StatusIo): Promise<number> {
  const gh = io.gh ?? realGh;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) positional.push(arg);
    else if (["failures", "pretty"].includes(arg.slice(2))) flags.set(arg.slice(2), true);
    else { const value = argv[++index]; if (value === undefined) throw new Error(`${arg} needs a value`); flags.set(arg.slice(2), value); }
  }
  const text = (name: string) => { const value = flags.get(name); return typeof value === "string" ? value : undefined; };
  const repo = text("repo") ?? DEFAULT_REPO;
  if (!/^[1-9]\d*$/.test(positional[0] ?? "")) { io.out("usage: bun scripts/pr-status.ts <pr> [--expect-head sha] [--expect-base sha] [--failures [--logs dir]]"); return 2; }
  const number = Number(positional[0]);
  const print = (value: unknown) => io.out(JSON.stringify(value, null, flags.has("pretty") ? 2 : undefined));

  const pr = JSON.parse(must(gh, ["pr", "view", String(number), "--repo", repo, "--json",
    "state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,body,files,statusCheckRollup"])) as {
    state: string; isDraft: boolean; headRefOid: string; baseRefName: string; mergeable: string; mergeStateStatus: string;
    reviewDecision: string; body: string; files: Array<{ path: string }>; statusCheckRollup: Rollup[] | null };
  const runs = (JSON.parse(must(gh, ["run", "list", "--repo", repo, "--commit", pr.headRefOid, "--limit", "50", "--json",
    "databaseId,workflowName,event,attempt,status,conclusion"])) as Array<{ databaseId: number; workflowName: string; event: string; attempt: number; status: string; conclusion: string }>)
    .map(run => ({ id: run.databaseId, workflow: run.workflowName, event: run.event, attempt: run.attempt, status: run.status, conclusion: run.conclusion || null }));

  if (flags.has("failures")) {
    const logs = text("logs");
    if (logs) mkdirSync(logs, { recursive: true });
    const jobs: Array<{ run: number; job: number; name: string; failedSteps: string[]; log?: string; failing?: string[] }> = [];
    for (const run of runs.filter(entry => entry.conclusion && !["success", "skipped", "neutral"].includes(entry.conclusion))) {
      const detail = JSON.parse(must(gh, ["run", "view", String(run.id), "--repo", repo, "--json", "jobs"])) as
        { jobs: Array<{ databaseId: number; name: string; conclusion: string; steps?: Array<{ name: string; conclusion: string }> }> };
      for (const job of detail.jobs.filter(entry => !["success", "skipped", "neutral", ""].includes(entry.conclusion ?? ""))) {
        const row: (typeof jobs)[number] = { run: run.id, job: job.databaseId, name: job.name,
          failedSteps: (job.steps ?? []).filter(step => step.conclusion === "failure").map(step => step.name) };
        if (logs) {
          // A job that was refused before it started has no log; that is an answer, not an error.
          const log = gh(["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${job.databaseId}/logs`]);
          if (log.code === 0) { row.log = join(logs, `job-${job.databaseId}.log`); writeFileSync(row.log, log.stdout); row.failing = failingLines(log.stdout); }
          else row.failing = ["(no log: the job did not execute; read its check-run annotations)"];
        }
        jobs.push(row);
      }
    }
    print({ pr: number, head: pr.headRefOid, failedJobs: jobs });
    return 0;
  }

  const liveBase = must(gh, ["api", `repos/${repo}/git/ref/heads/${pr.baseRefName}`, "--jq", ".object.sha"]).trim();
  // GitHub can keep an old base in the synthetic merge commit across a draft/ready transition.
  const mergeSha = gh(["api", `repos/${repo}/git/ref/pull/${number}/merge`, "--jq", ".object.sha"]);
  let mergeRef: { sha: string; parents: string[]; current: boolean } | null = null;
  if (mergeSha.code === 0 && mergeSha.stdout.trim()) {
    const parents = JSON.parse(must(gh, ["api", `repos/${repo}/git/commits/${mergeSha.stdout.trim()}`, "--jq", "[.parents[].sha] | tojson"])) as string[];
    mergeRef = { sha: mergeSha.stdout.trim(), parents, current: parents.length === 2 && parents[0] === liveBase && parents[1] === pr.headRefOid };
  }
  const { total, proof, ...checks } = summarizeChecks(pr.statusCheckRollup ?? []);
  const status: Record<string, unknown> = { pr: number, state: pr.state, draft: pr.isDraft, head: pr.headRefOid, baseRef: pr.baseRefName, liveBase,
    mergeable: pr.mergeable, mergeState: pr.mergeStateStatus, review: pr.reviewDecision || null, mergeRef,
    receipt: pr.body.includes(RECEIPT_START), proof, checks: { total, ...checks }, runs };

  const [expectHead, expectBase] = [text("expect-head"), text("expect-base")];
  let moved = false;
  if (expectHead || expectBase) {
    const unchanged = { head: !expectHead || expectHead === pr.headRefOid, base: !expectBase || expectBase === liveBase };
    status.unchanged = unchanged;
    moved = !unchanged.head || !unchanged.base;
    if (expectBase && !unchanged.base) {
      const gained = JSON.parse(must(gh, ["api", `repos/${repo}/compare/${expectBase}...${liveBase}`, "--jq", "[.files[].filename] | tojson"])) as string[];
      const mine = new Set(pr.files.map(file => file.path));
      status.baseGained = { files: gained.length, overlapsThisPr: gained.filter(file => mine.has(file)) };
    }
  }
  print(status);
  return moved ? 1 : 0;
}

if (import.meta.main) {
  try { process.exit(await main(process.argv.slice(2), { out: text => console.log(text) })); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(2); }
}
