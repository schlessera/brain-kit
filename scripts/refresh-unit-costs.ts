/** Explicit reviewed unit-weight refresh; contribution CI never downloads timings. */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { API } from "./proof-reuse";
import type { Checkout } from "./proof-inputs";

export interface UnitEvidenceAPI extends API {
  archive(id: number): Promise<{ digest: string; files: Record<string, string> }>;
}
const SHA = /^[a-f0-9]{40}$/;
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const validPath = (file: string) => /^(packages|tests)\//.test(file) && !file.split("/").some(p => p === ".." || p.startsWith(".") || p.toLowerCase() === "node_modules") && /(?:\.test|\.spec|_test|_spec)\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file);

/** Name expensive omissions explicitly; zero elapsed observations retain a positive default. */
export function assertWeightedLongFiles(milliseconds: Readonly<Record<string, number>>, costs: Readonly<Record<string, number>>, thresholdSeconds = 30): void {
  for (const [file, ms] of Object.entries(milliseconds)) {
    if (ms > thresholdSeconds * 1000 && (!Object.hasOwn(costs, file) || !Number.isFinite(costs[file]) || costs[file]! <= 0)) throw new Error(`Missing unit weight above ${thresholdSeconds}s: ${file}`);
  }
}

/** Require four fresh successful jobs, immutable source and complete completed-file partitions. */
export async function refreshUnitCosts(run: number, attempt: number, api: UnitEvidenceAPI) {
  const info = await api.json(`actions/runs/${run}/attempts/${attempt}`);
  if (info.id !== run || info.run_attempt !== attempt || info.status !== "completed" || info.conclusion !== "success" ||
      info.path !== ".github/workflows/ci.yml" || info.repository?.full_name !== "schlessera/brain-kit" ||
      !["push", "pull_request", "workflow_dispatch", "schedule"].includes(info.event) || !SHA.test(info.head_sha)) throw new Error("Successful attributed CI run/attempt required");
  const page = await api.json(`actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`);
  const artifacts = await api.json(`actions/runs/${run}/artifacts?per_page=100`);
  if (!Array.isArray(page.jobs) || page.total_count !== page.jobs.length || !Array.isArray(artifacts.artifacts) || artifacts.total_count !== artifacts.artifacts.length) throw new Error("Incomplete evidence inventory");
  const milliseconds: Record<string, number> = {}, observations = [];
  const jobIDs = new Set<number>();
  let identity: Checkout | undefined;
  for (let shard = 1; shard <= 4; shard++) {
    const jobs = page.jobs.filter((j: any) => j.name === `unit (${shard})`), job = jobs[0];
    const steps = job?.steps?.filter((s: any) => s.name === "Complete unit proof"), step = steps?.[0];
    if (jobs.length !== 1 || !Number.isSafeInteger(job.id) || jobIDs.has(job.id) || job.run_id !== run || job.head_sha !== info.head_sha || job.status !== "completed" || job.conclusion !== "success" || steps.length !== 1 || step.status !== "completed" || step.conclusion !== "success") throw new Error("Four fresh successful unit jobs required");
    jobIDs.add(job.id);
    const found = artifacts.artifacts.filter((a: any) => a.name === `unit-proof-${shard}`), artifact = found[0];
    const created = Date.parse(artifact?.created_at);
    if (found.length !== 1 || !Number.isFinite(created) || !(created >= Date.parse(job.started_at) && created <= Date.parse(job.completed_at)) || artifact.expired || artifact.workflow_run?.id !== run || artifact.workflow_run?.head_sha !== info.head_sha || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) throw new Error("Attributed unit artifact required");
    const archive = await api.archive(artifact.id);
    if (archive.digest !== artifact.digest) throw new Error("Unit artifact digest mismatch");
    const receipt = JSON.parse(archive.files["proof-checkout.json"]!), timings = JSON.parse(archive.files["unit-timings.json"]!);
    const log = (await api.log(job.id)).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
    const checkouts = [...log.matchAll(/git log -1 --format=%H[^\n]*\n[^\n]*? ([a-f0-9]{40})\s*(?:\n|$)/g)];
    if (receipt.category !== "unit" || receipt.shard !== `${shard}/4` || !receipt.plan?.global || !receipt.plan?.local?.fullTests ||
        !SHA.test(receipt.checkout?.sha) || !SHA.test(receipt.checkout?.tree) || checkouts.length !== 1 || checkouts[0]![1] !== receipt.checkout.sha ||
        (identity && JSON.stringify(identity) !== JSON.stringify(receipt.checkout))) throw new Error("Unit checkout/source identity mismatch or nonexhaustive selection");
    identity = receipt.checkout;
    const xml = archive.files["unit-report.xml"]!;
    if (!/<testsuites\s/.test(xml) || !/<\/testsuites>\s*$/.test(xml) || /(?:failures|errors)="[1-9]/.test(xml)) throw new Error("Incomplete or failed file report");
    const completed = [...new Set([...xml.matchAll(/<testsuite\s[^>]*file="([^"]+)"/g)].map(m => m[1]!))];
    if (timings.version !== 1 || !timings.files || !Array.isArray(receipt.files) || !receipt.files.length ||
        new Set(receipt.files).size !== receipt.files.length || !same(receipt.files, Object.keys(timings.files)) || !same(receipt.files, completed)) throw new Error("Incomplete completed-file timing partition");
    for (const [file, ms] of Object.entries(timings.files)) {
      if (!validPath(file) || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || Object.hasOwn(milliseconds, file)) throw new Error("Invalid or duplicate file measurement");
      milliseconds[file] = ms;
    }
    const elapsedSeconds = (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000;
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) throw new Error("Missing execution step timing");
    observations.push({ shard, job: job.id, artifact: artifact.id, digest: artifact.digest, files: receipt.files.length, elapsedSeconds });
  }
  if (!identity) throw new Error("Missing unit checkout");
  const commit = await api.json(`git/commits/${identity.sha}`);
  const parents = commit.parents?.map((p: any) => p.sha);
  if (commit.sha !== identity.sha || commit.tree?.sha !== identity.tree || !Array.isArray(parents) || JSON.stringify(parents) !== JSON.stringify(identity.parents) || parents.some((s: string) => !SHA.test(s)) ||
      (info.event === "pull_request" ? parents.length !== 2 || parents[1] !== info.head_sha : identity.sha !== info.head_sha)) throw new Error("Immutable source/tree/parent mismatch");
  const source = await api.json(`git/trees/${identity.tree}?recursive=1`);
  if (source.sha !== identity.tree || source.truncated || !Array.isArray(source.tree) || !same(source.tree.filter((p: any) => p.type === "blob" && validPath(p.path)).map((p: any) => p.path), Object.keys(milliseconds))) throw new Error("Timings do not cover complete source discovery");
  const seconds = Object.fromEntries(Object.entries(milliseconds).sort(([a], [b]) => a.localeCompare(b)).map(([file, ms]) => [file, Math.max(0.1, ms / 1000)]));
  assertWeightedLongFiles(milliseconds, seconds);
  return { seconds, measurement: { run, attempt, head: info.head_sha, ...identity, jobs: observations,
    units: "seconds", aggregation: "completed-file elapsed milliseconds / 1000; minimum positive weight 0.1s", missingWeightThresholdSeconds: 30 } };
}

if (import.meta.main) {
  let directory: string | undefined;
  try {
    const [run, attempt] = process.argv.slice(2);
    if (process.argv.length !== 4 || !run || !attempt || !/^[1-9]\d*$/.test(run) || !/^[1-9]\d*$/.test(attempt) || !Number.isSafeInteger(Number(run)) || !Number.isSafeInteger(Number(attempt))) throw new Error("usage: bun scripts/refresh-unit-costs.ts <run-id> <attempt>");
    directory = await mkdtemp(join(tmpdir(), "brain-unit-costs-"));
    const invoke = async (args: string[]) => {
      const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const [code, bytes, error] = await Promise.all([p.exited, new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()]);
      if (code) throw new Error(`Measurement evidence unavailable: ${error}`);
      return Buffer.from(bytes);
    };
    const path = "repos/schlessera/brain-kit/";
    const api: UnitEvidenceAPI = {
      json: async p => JSON.parse((await invoke(["gh", "api", path + p])).toString()),
      log: async id => (await invoke(["gh", "api", "--allow-escape-sequences", path + `actions/jobs/${id}/logs`])).toString(),
      archive: async id => {
        const bytes = await invoke(["gh", "api", path + `actions/artifacts/${id}/zip`]);
        const zip = join(directory!, `${id}.zip`); await Bun.write(zip, bytes);
        const files: Record<string, string> = {};
        for (const file of ["proof-checkout.json", "unit-timings.json", "unit-report.xml"]) files[file] = (await invoke(["unzip", "-p", zip, `tmp/${file}`])).toString();
        return { digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, files };
      },
    };
    const result = await refreshUnitCosts(Number(run), Number(attempt), api);
    await Bun.write(join(import.meta.dir, "test-shard-costs.json"), JSON.stringify(result.seconds, null, 2) + "\n");
    await Bun.write(join(import.meta.dir, "unit-shard-measurement.json"), JSON.stringify(result.measurement, null, 2) + "\n");
    console.log(`Recorded ${Object.keys(result.seconds).length} reviewed unit weights from run ${run} attempt ${attempt}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}
