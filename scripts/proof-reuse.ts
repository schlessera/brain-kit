/** Bounded immutable GitHub receipts; no passing-result cache or privileged event. */
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserInventory, checkout, git, normalizeInventory, proofInputs, REUSABLE, runnerIdentity,
  type Checkout, type Inputs, type Reusable } from "./proof-inputs";
import { proofSelections, type CheckPlan } from "./ci-plan";

export const RECEIPT_MARKER = "BRAIN_PROOF_RECEIPT ";
export interface FreshReceipt { version: 1; category: Reusable; shard: string; checkout: Checkout; inputs: Inputs; }
export interface Source { run: number; attempt: number; jobs: number[]; checkout: Checkout; inputs: Inputs; }
export interface Ledger { version: 1; checkout: Checkout; retained: Partial<Record<Reusable, Source>>; }
export interface Context { repository: string; headRepository: string; branch: string; pr: number; run: number; }
export interface API { json(path: string): Promise<any>; log(job: number): Promise<string>; }
const SHA = /^[a-f0-9]{40}$/;
const validID = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function contextFromEvent(event: any, env: NodeJS.ProcessEnv): Context | undefined {
  const pr = event.pull_request;
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "pull_request" || pr?.draft || !validID(pr?.number) ||
      !pr.head?.repo?.full_name || !pr.head.ref || !validID(Number(env.GITHUB_RUN_ID)) ||
      env.GITHUB_REPOSITORY !== "schlessera/brain-kit") return undefined;
  return { repository: env.GITHUB_REPOSITORY, headRepository: pr.head.repo.full_name,
    branch: pr.head.ref, pr: pr.number, run: Number(env.GITHUB_RUN_ID) };
}
export class GitHubProofAPI implements API {
  private readonly deadline = Date.now() + 45000;
  private requests = 0;
  constructor(private readonly repository: string, private readonly token: string) {}
  private async read(path: string, log = false): Promise<string> {
    if (++this.requests > 32 || Date.now() >= this.deadline) throw new Error("Proof lookup budget exhausted");
    let url = `https://api.github.com/repos/${this.repository}/${path}`;
    let response: Response;
    for (let redirects = 0;; redirects++) {
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(Math.min(8000, this.deadline - Date.now())),
        headers: { Accept: "application/vnd.github+json", ...(url.startsWith("https://api.github.com/") ? { Authorization: `Bearer ${this.token}` } : {}) } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirects >= 2 || !log) throw new Error("Unexpected proof API redirect");
      await response.body?.cancel();
      url = new URL(response.headers.get("location") ?? "", url).href;
      if (!url.startsWith("https://")) throw new Error("Unsafe log redirect");
    }
    if (!response.ok) throw new Error(`Proof API refused ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing proof API response");
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > (log ? 16000000 : 2000000)) { await reader.cancel(); throw new Error("Unbounded proof response"); }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }
  async json(path: string): Promise<any> {
    const text = await this.read(path);
    try { return JSON.parse(text); }
    catch { throw new Error(`Invalid GitHub proof JSON: ${path}`); }
  }
  async log(job: number): Promise<string> { return this.read(`actions/jobs/${job}/logs`, true); }
}
async function ensureCommit(root: string, sha: string): Promise<void> {
  if (!SHA.test(sha)) throw new Error("Invalid source commit");
  const present = Bun.spawnSync(["git", "cat-file", "-e", `${sha}^{commit}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (present.exitCode === 0) return;
  const p = Bun.spawn(["git", "fetch", "--no-tags", "--quiet", "origin", sha], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill("SIGKILL"), 8000);
  try { if (await p.exited) throw new Error("Source commit is unavailable"); }
  finally { clearTimeout(timer); }
}
export function receiptFromLog(text: string, category: Reusable, shard: number): FreshReceipt {
  const clean = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const rows = clean.split("\n").filter(line => /^\S+ BRAIN_PROOF_RECEIPT /.test(line));
  if (rows.length !== 1) throw new Error("Missing or ambiguous fresh execution receipt");
  const receipt = JSON.parse(rows[0]!.slice(rows[0]!.indexOf(RECEIPT_MARKER) + RECEIPT_MARKER.length)) as FreshReceipt;
  if (receipt.version !== 1 || receipt.category !== category || receipt.shard !== `${shard}/2` ||
      !SHA.test(receipt.checkout?.sha ?? "") || !SHA.test(receipt.checkout?.tree ?? "") || !receipt.inputs) throw new Error("Wrong fresh execution receipt");
  if (!clean.split("\n").some(line => /^\S+ /.test(line) && line.trim().endsWith(`Z ${receipt.checkout.sha}`))) throw new Error("Receipt is not the actual job checkout");
  return receipt;
}

/** Recompute BOTH immutable trees; artifact/log claims cannot authorize retention. */
export async function validateSource(root: string, category: Reusable, source: Source, inputs: Inputs,
  context: Context, api: API): Promise<void> {
  if (!validID(source?.run) || source.run === context.run || !validID(source.attempt) ||
      !Array.isArray(source.jobs) || source.jobs.length !== 2 || source.jobs.some(id => !validID(id)) || new Set(source.jobs).size !== 2 ||
      source.inputs?.fingerprint !== inputs.fingerprint || JSON.stringify(source.inputs) !== JSON.stringify(inputs)) throw new Error("Missing complete input equivalence");
  const run = await api.json(`actions/runs/${source.run}/attempts/${source.attempt}`);
  if (run.id !== source.run || run.run_attempt !== source.attempt || run.event !== "pull_request" ||
      run.status !== "completed" || run.conclusion !== "success" || run.path !== ".github/workflows/ci.yml" ||
      run.head_branch !== context.branch || run.repository?.full_name !== context.repository || run.head_repository?.full_name !== context.headRepository ||
      !SHA.test(run.head_sha ?? "") || !Number.isFinite(Date.parse(run.created_at)) || Date.now() - Date.parse(run.created_at) > 7 * 86400000 || Date.parse(run.created_at) > Date.now()) throw new Error("Source is not recent successful automatic proof for this contribution");
  const page = await api.json(`actions/runs/${source.run}/attempts/${source.attempt}/jobs?per_page=100`);
  if (!Array.isArray(page.jobs) || page.total_count !== page.jobs.length || page.jobs.length > 30) throw new Error("Incomplete source job inventory");
  const found: FreshReceipt[] = [];
  for (let shard = 1; shard <= 2; shard++) {
    const matching = page.jobs.filter((j: any) => j.name === `${category} (${shard})`);
    const job = matching[0];
    if (matching.length !== 1 || job?.id !== source.jobs[shard - 1] || job.run_id !== source.run || job.head_sha !== run.head_sha ||
        job.status !== "completed" || job.conclusion !== "success" ||
        !job.steps?.some((s: any) => s.name === `Complete ${category} proof` && s.status === "completed" && s.conclusion === "success") ||
        !String(job.check_run_url).startsWith(`https://api.github.com/repos/${context.repository}/check-runs/`)) throw new Error("Source has no fresh successful job for every shard");
    const checkId = String(job.check_run_url).split("/").at(-1)!;
    if (!/^\d+$/.test(checkId)) throw new Error("Invalid source check identity");
    const check = await api.json(`check-runs/${checkId}`);
    if (String(check.id) !== checkId || check.app?.slug !== "github-actions" || check.head_sha !== run.head_sha ||
        check.status !== "completed" || check.conclusion !== "success") throw new Error("Source check does not establish successful execution");
    const log = await api.log(job.id);
    if (!log.includes(`refs/remotes/pull/${context.pr}/merge`) && !log.includes(`refs/pull/${context.pr}/merge`)) throw new Error("Job checkout does not belong to the source pull request");
    const receipt = receiptFromLog(log, category, shard);
    if (JSON.stringify(receipt.checkout) !== JSON.stringify(source.checkout) || JSON.stringify(receipt.inputs) !== JSON.stringify(inputs)) throw new Error("Job receipt has no complete input equivalence");
    found.push(receipt);
  }
  const commit = await api.json(`git/commits/${source.checkout.sha}`);
  if (commit.sha !== source.checkout.sha || commit.tree?.sha !== source.checkout.tree ||
      JSON.stringify(commit.parents?.map((p: any) => p.sha)) !== JSON.stringify(source.checkout.parents) ||
      source.checkout.parents.length !== 2 || source.checkout.parents[1] !== run.head_sha) throw new Error("Source checkout/tree/parents do not match immutable GitHub execution");
  await ensureCommit(root, source.checkout.sha);
  if (JSON.stringify(checkout(root, source.checkout.sha)) !== JSON.stringify(source.checkout) ||
      git(root, "rev-parse", `${source.checkout.sha}:.github/workflows/ci.yml`).trim() !== git(root, "rev-parse", "HEAD:.github/workflows/ci.yml").trim()) throw new Error("Source workflow or Git identity changed");
  const recomputed = proofInputs(root, category, normalizeInventory(source.inputs.inventory), inputs.runner,
    source.checkout.sha, inputs.excluded);
  if (recomputed.fingerprint !== inputs.fingerprint || JSON.stringify(recomputed.partitions) !== JSON.stringify(inputs.partitions) || found.length !== 2) throw new Error("Immutable source inputs do not establish input equivalence");
}

export async function findRetained(root: string, selected: Record<string, boolean>, context: Context, api: API,
  inventory: ReturnType<typeof normalizeInventory>, runner: string): Promise<Ledger["retained"]> {
  const retained: Ledger["retained"] = {};
  const targets = REUSABLE.filter(category => selected[category]);
  if (!targets.length || !runner) return retained;
  const page = await api.json(`actions/workflows/ci.yml/runs?event=pull_request&status=success&branch=${encodeURIComponent(context.branch)}&per_page=3`);
  if (!Array.isArray(page.workflow_runs) || page.workflow_runs.length > 3) throw new Error("Unbounded source runs");
  for (const run of page.workflow_runs) {
    if (run.id === context.run || run.status !== "completed" || run.conclusion !== "success") continue;
    const jobs = await api.json(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    for (const category of targets) {
      if (retained[category]) continue;
      try {
        const pair = [1, 2].map(shard => jobs.jobs.find((j: any) => j.name === `${category} (${shard})` && j.conclusion === "success"));
        if (pair.some(j => !j)) continue; // Never form transitive chains through skipped/reused jobs.
        const first = receiptFromLog(await api.log(pair[0].id), category, 1);
        const inputs = proofInputs(root, category, inventory, runner);
        const source: Source = { run: run.id, attempt: run.run_attempt, jobs: pair.map(j => j.id), checkout: first.checkout, inputs: first.inputs };
        await validateSource(root, category, source, inputs, context, api);
        retained[category] = source;
      } catch { /* Unknown/missing/mismatched source evidence means fresh execution. */ }
    }
    if (targets.every(category => retained[category])) break;
  }
  return retained;
}

export async function retainedCategories(root: string, ledger: unknown, context: Context | undefined, api: API | undefined): Promise<Set<string>> {
  const value = ledger as Ledger;
  if (value?.version !== 1 || !value.retained || typeof value.retained !== "object" || Array.isArray(value.retained) || JSON.stringify(value.checkout) !== JSON.stringify(checkout(root))) throw new Error("Missing or mismatched current-head proof ledger");
  if (Object.keys(value.retained).some(key => !(REUSABLE as readonly string[]).includes(key))) throw new Error("Unknown retained proof domain");
  const accepted = new Set<string>();
  if (!Object.keys(value.retained).length) return accepted;
  if (!context || !api) throw new Error("Retention requires an automatic ready PR");
  const inventory = await browserInventory(root);
  for (const category of REUSABLE) {
    const source = value.retained[category]; if (!source) continue;
    await validateSource(root, category, source, proofInputs(root, category, inventory, runnerIdentity()), context, api);
    accepted.add(category);
  }
  return accepted;
}

/** Leave headroom for the aggregate's other outputs below Linux's per-env limit.
 * Measure the escaped outer JSON envelope, not just the receipt JSON bytes. */
export function boundedLedger(ledger: Ledger): Ledger {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(ledger))) <= 90000 ? ledger : { ...ledger, retained: {} };
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, "..");
    const plan = await Bun.file(join(root, "tmp/ci-plan.json")).json() as CheckPlan;
    let ledger: Ledger = { version: 1, checkout: checkout(root), retained: {} };
    const selected = proofSelections(plan, process.env.PR_DRAFT === "true");
    const event = process.env.GITHUB_EVENT_PATH ? await Bun.file(process.env.GITHUB_EVENT_PATH).json() : {};
    const context = contextFromEvent(event, process.env);
    const start = performance.now();
    if (context && process.env.GH_TOKEN && runnerIdentity() && REUSABLE.some(category => selected[category])) {
      try {
        if (git(root, "diff", "HEAD", "--").trim()) throw new Error("Dirty tracked inputs require fresh proof");
        ledger.retained = await findRetained(root, selected, context, new GitHubProofAPI(context.repository, process.env.GH_TOKEN), await browserInventory(root), runnerIdentity());
      } catch (error) { console.log(`Proof retention unavailable; execute fresh: ${String(error).slice(0, 200)}`); }
    }
    ledger = boundedLedger(ledger);
    await Bun.write(join(root, "tmp/proof-reuse.json"), JSON.stringify(ledger, null, 2));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      `reuse=${JSON.stringify(ledger)}\n` + REUSABLE.map(category => `run_${category}=${selected[category] && !ledger.retained[category]}\n`).join(""));
    console.log(JSON.stringify({ ...ledger, lookupSeconds: (performance.now() - start) / 1000 }));
  } catch (error) { console.error(error); process.exit(1); }
}
