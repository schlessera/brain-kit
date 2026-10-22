/** Offline executable fixture: no network transport or host gh fallback. */
import { appendFileSync, readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(process.env.TIMING_FIXTURE!, "utf8"));
const callsFile = process.env.TIMING_CALLS!;
const path = process.argv.at(-1)!;
appendFileSync(callsFile, path + "\n");
const calls = readFileSync(callsFile, "utf8").trim().split("\n");
const used = calls.filter(p => p !== "rate_limit").length;
const remaining = config.quotaDropAt && calls.length >= config.quotaDropAt ? 500 : (config.remaining ?? 1000) - used;
const sha = "a".repeat(40), stamp = "2026-07-12T10:00:00Z";
const run = (id: number) => ({ id, run_attempt: id === 12 && config.rerun ? 2 : 1,
  name: "CI", path: ".github/workflows/ci.yml", event: "pull_request", head_sha: sha,
  head_branch: "feat/ithaca", created_at: stamp, run_started_at: stamp,
  status: "completed", conclusion: "success", pull_requests: config.pullCount ? [{ number: 42 }] : [] });
let body: unknown, code = 0;
if (path === "rate_limit") body = config.badQuota ? {} : { resources: { core: { remaining, limit: 1000, reset: 1783854000 } } };
else if (path.includes("actions/workflows/ci-timings.yml/runs")) body = { workflow_runs: [{
  id: 99, path: ".github/workflows/ci-timings.yml", head_branch: "main", status: "completed", event: "schedule" }] };
else if (path.includes("actions/runs/99/artifacts")) body = { artifacts: [{ id: 77, name: "ci-timings", expired: false }] };
else if (path.endsWith("actions/artifacts/77/zip")) body = readFileSync(config.seedZip);
else if (path.includes("actions/workflows/contract.yml/runs")) body = { total_count: 0, workflow_runs: [] };
else if (path.includes("actions/workflows/ci.yml/runs")) {
  const page = Number(new URL("https://fixture.invalid/" + path).searchParams.get("page"));
  const rows = Array.from({ length: config.count ?? 1 }, (_, i) => run(12 + i));
  body = config.discoveryFailure ? { total_count: 2, workflow_runs: [run(12)] } : {
    total_count: rows.length, workflow_runs: rows.slice((page - 1) * 100, page * 100) };
} else if (path.includes("/jobs?")) {
  const id = Number(/actions\/runs\/(\d+)/.exec(path)![1]);
  const attempt = Number(/attempts\/(\d+)/.exec(path)![1]);
  body = { total_count: 1, jobs: [{ id: id * 10 + attempt, run_id: id, run_attempt: attempt, name: "unit",
    status: "completed", conclusion: "success", started_at: stamp, completed_at: "2026-07-12T10:01:00Z",
    steps: [{ number: 1, name: "Unit proof", status: "completed", conclusion: "success", started_at: stamp }] }] };
} else if (/actions\/runs\/\d+\/attempts\/\d+$/.test(path)) {
  const [id, attempt] = /actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(path)!.slice(1).map(Number);
  body = { ...run(id!), run_attempt: attempt };
} else if (path.includes("/logs")) body = "resource marker unavailable";
else if (path.includes("pulls?state=")) body = Array.from({ length: config.pullCount ?? 0 }, (_, i) => ({
  number: 42 + i, head: { sha, ref: "feat/ithaca", repo: { full_name: "odysseus/chronicle" } },
  merged_at: null, updated_at: stamp }));
else if (/\/pulls\/\d+$/.test(path)) body = { number: Number(path.split("/").at(-1)), head: { sha },
  base: { ref: "main", repo: { full_name: "odysseus/chronicle" } }, created_at: stamp, closed_at: null, merged_at: null, changed_files: 1, additions: 1, deletions: 0 };
else if (path.includes("/timeline?")) body = [];
else throw new Error(`Unexpected fixture request: ${path}`);
if (config.rateLimitAt === calls.length) { code = 1; body = { message: "secondary rate limit" }; }
if (process.argv.includes("--include")) process.stdout.write(
  `HTTP/2.0 ${code ? "429 Too Many Requests" : "200 OK"}\r\nX-RateLimit-Remaining: ${remaining}\r\n\r\n`);
process.stdout.write(body instanceof Uint8Array ? body : typeof body === "string" ? body : JSON.stringify(body));
if (code) process.stderr.write("secondary rate limit; retry later");
process.exitCode = code;
