/** GitHub is the sole CI provider; contributions share read-only workflows. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROOF_SHARDS, shardNumbers, type ShardedDomain } from "./proof-shards";

export const CI_WORKFLOWS = ["ci.yml", "contract.yml"] as const;
const RUN_EXPRESSIONS = new Set(["matrix.shard", "github.event_name", "github.base_ref", "github.event.before"]);
type Step = { uses?: string; run?: string; if?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs?: Record<string, { name?: string; "runs-on"?: unknown; if?: string; needs?: unknown; permissions?: unknown; steps?: Step[] }>;
};

export function workflowProblems(text: string, file: string): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const match of text.matchAll(/^([A-Za-z_-]+):/gm)) {
    if (keys.has(match[1]!)) problems.push(`${file}: duplicate top-level key ${match[1]}`);
    keys.add(match[1]!);
  }
  let workflow: Workflow;
  try { workflow = Bun.YAML.parse(text) as Workflow; }
  catch { return [`${file}: invalid YAML`]; }
  if (!workflow || typeof workflow !== "object") return [`${file}: workflow must be a mapping`];
  const fail = (message: string) => problems.push(`${file}: ${message}`);
  if (/\bsecrets\.|\bpull_request_target\b|\bworkflow_run\b/.test(text)) fail("CI must not expose secrets or privileged triggers");
  const permissions = file === "ci.yml" ? { contents: "read", actions: "read", checks: "read" } : { contents: "read" };
  if (JSON.stringify(workflow.permissions) !== JSON.stringify(permissions)) fail("workflow permissions must be the specified read-only contents/actions scope");
  const expectedTriggers = file === "ci.yml" ? ["pull_request", "push", "schedule", "workflow_dispatch"] : ["pull_request"];
  if (JSON.stringify(Object.keys(workflow.on ?? {}).sort()) !== JSON.stringify(expectedTriggers)) fail("unexpected contribution triggers");
  const expectedJobs = file === "ci.yml" ? ["browser", "captures", "changeset", "endurance", "layout", "pack", "proof", "runtime", "runtime_host", "unit", "verify"] : ["contract"];
  if (JSON.stringify(Object.keys(workflow.jobs ?? {}).sort()) !== JSON.stringify(expectedJobs)) fail("missing or unexpected CI jobs");
  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    if (job["runs-on"] !== "ubuntu-24.04") fail(`${name}: unmapped GitHub-hosted runner`);
    if (job.permissions !== undefined) fail(`${name}: job permissions must inherit the read-only workflow token`);
    if (/head\.repo|depot|fork\s*\//i.test(job.if ?? "")) fail(`${name}: provider routing must not exclude contributions`);
    if (!job.steps?.length) fail(`${name}: executable steps must be nonempty`);
    const checkouts = job.steps?.filter(step => step.uses?.startsWith("actions/checkout@")) ?? [];
    if (!checkouts.length) fail(`${name}: checkout is missing`);
    for (const step of checkouts) {
      if (step.with?.["persist-credentials"] !== false) fail(`${name}: checkout credentials must not persist`);
      if (file === "ci.yml" && ["ref", "repository", "path"].some(key => step.with?.[key] !== undefined)) fail(`${name}: proof checkout must use the event candidate`);
    }
    for (const step of job.steps ?? []) {
      for (const match of (step.run ?? "").matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)) {
        if (!RUN_EXPRESSIONS.has(match[1]!)) fail(`${name}: untrusted expression in run script: ${match[1]}`);
      }
    }
  }
  if (file === "ci.yml") {
    const names = ["verify", "pack", "unit", "runtime", "runtime_host", "browser", "layout", "captures", "endurance"];
    for (const name of names) {
      const job = workflow.jobs?.[name];
      if (job?.needs !== "changeset") fail(`${name}: independent proof must depend only on metadata`);
      const selection = `needs.changeset.outputs.${name} == 'true'` + (["browser", "layout"].includes(name) ? ` && needs.changeset.outputs.run_${name} == 'true'` : "");
      if (job?.if !== selection) fail(`${name}: proof must use its explicit planner selection and validated retention`);
    }
    // Matrices, retention and refresh share one shard table; a drifted matrix would strand a partition.
    for (const domain of Object.keys(PROOF_SHARDS) as ShardedDomain[]) {
      const job = workflow.jobs?.[domain] as any;
      if (JSON.stringify(job?.strategy?.matrix?.shard) !== JSON.stringify(shardNumbers(domain)) ||
          !job?.steps?.some((step: any) => step.run === `bun scripts/ci-proof.ts ${domain} --shard=\${{ matrix.shard }}/${PROOF_SHARDS[domain]}`)) fail(`${domain}: matrix and shard divisor must match PROOF_SHARDS`);
    }
    const proof = workflow.jobs?.proof;
    if (proof?.name !== "${{ github.event_name != 'pull_request' && 'integrated or exhaustive proof' || github.event.pull_request.draft && 'draft gates' || 'proof' }}") fail("proof: draft, manual or main runs must not impersonate candidate confirmation");
    if (JSON.stringify(proof?.needs) !== JSON.stringify(["changeset", ...names])) fail("proof: aggregate must observe every selected category");
    if (proof?.if !== "${{ always() && !cancelled() }}") fail("proof: aggregate must observe failures/skips and reject cancellation");
    for (const category of ["unit", "runtime", "runtime_host", "browser", "layout", "captures", "endurance"]) {
      if (!workflow.jobs?.[category]?.steps?.some(step => step.run === `bun scripts/ci-proof.ts ${category}` || step.run?.startsWith(`bun scripts/ci-proof.ts ${category} `))) fail(`${category}: complete proof command is missing`);
    }
    if (!proof?.steps?.some(step => step.run === "bun scripts/ci-proof.ts aggregate")) fail("proof: executable aggregate is missing");
    if (!workflow.jobs?.changeset?.steps?.some(step => step.run === "bun scripts/proof-reuse.ts")) fail("metadata: immutable retention validation is missing");
    const metadata = workflow.jobs?.changeset?.steps ?? [];
    const admission = metadata.findIndex(step => step.run === "bun scripts/candidate-proof.ts");
    const planning = metadata.findIndex(step => step.run === "bun scripts/ci-plan.ts");
    const discovery = metadata.findIndex(step => step.run === "bun scripts/proof-inventory.ts");
    if (admission <= planning || discovery <= admission || metadata[admission]?.if !== "steps.plan.outputs.cadence == 'confirmation'" ||
        metadata[admission]?.env?.GH_TOKEN !== "${{ github.token }}") fail("metadata: confirmation admission must validate identity after planning and before product discovery");
  }
  return problems;
}

export function checkCIWorkflows(root: string): string[] {
  const problems: string[] = [];
  const directory = join(root, ".github/workflows");
  const files = existsSync(directory) ? readdirSync(directory).sort() : [];
  const expected = ["ci.yml", "contract.yml", "project-sync.yml"];
  if (files.includes("publish-pages.yml")) expected.push("publish-pages.yml");
  if (files.includes("ci-timings.yml")) expected.push("ci-timings.yml");
  if (JSON.stringify(files) !== JSON.stringify(expected.sort())) problems.push("GitHub must contain only authoritative CI, contract, project-sync and optional Pages/timing workflows");
  const depot = join(root, ".depot/workflows");
  if (existsSync(depot) && readdirSync(depot).some(file => /\.ya?ml$/.test(file))) problems.push("Active Depot CI workflow definitions must be removed");
  for (const file of CI_WORKFLOWS) {
    const path = join(directory, file);
    if (!existsSync(path)) problems.push(`${file}: missing authoritative GitHub workflow`);
    else problems.push(...workflowProblems(readFileSync(path, "utf8"), file));
  }
  const pages = join(directory, "publish-pages.yml");
  if (existsSync(pages)) problems.push(...publicationWorkflowProblems(readFileSync(pages, "utf8")));
  const timings = join(directory, "ci-timings.yml");
  if (existsSync(timings)) problems.push(...timingWorkflowProblems(readFileSync(timings, "utf8")));
  return problems;
}

/** Measurement is scheduled trusted code with no product-proof authority. */
export function timingWorkflowProblems(text: string): string[] {
  const errors: string[] = [], fail = (message: string) => errors.push(`ci-timings.yml: ${message}`);
  let workflow: Workflow;
  try { workflow = Bun.YAML.parse(text) as Workflow; }
  catch { return ["ci-timings.yml: invalid YAML"]; }
  if (!workflow || typeof workflow !== "object") return ["ci-timings.yml: workflow must be a mapping"];
  if (JSON.stringify(Object.keys(workflow.on ?? {}).sort()) !== JSON.stringify(["schedule", "workflow_dispatch"]) ||
      /\bsecrets\.|\bpull_request(?:_target)?\b|\bworkflow_run\b/.test(text)) fail("measurement must use scheduled/manual trusted execution only");
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: "read", actions: "read", "pull-requests": "read" })) fail("measurement token must remain read-only");
  if (JSON.stringify(Object.keys(workflow.jobs ?? {})) !== JSON.stringify(["collect"])) fail("measurement must contain only the collector job");
  const job = workflow.jobs?.collect;
  if (job?.permissions !== undefined || job?.needs !== undefined || job?.["runs-on"] !== "ubuntu-24.04") fail("collector must be independent on its declared hosted runner");
  const steps = job?.steps ?? [], checkouts = steps.filter(s => s.uses?.startsWith("actions/checkout@"));
  if (checkouts.length !== 1 || checkouts[0]?.with?.ref !== "${{ github.event.repository.default_branch }}" ||
    checkouts[0]?.with?.["persist-credentials"] !== false || checkouts[0]?.with?.repository !== undefined) fail("collector must check out trusted default-branch code without credentials");
  if (JSON.stringify(workflow.on?.schedule) !== JSON.stringify([{ cron: "43 * * * *" }])) fail("timing collection must remain hourly and incremental");
  const collection = steps.find(s => s.run?.includes("bun scripts/ci-timings.ts collect"));
  if (!collection?.run?.includes('bun scripts/ci-timings.ts collect --repo "$TIMING_REPO" --since "$since" --seed "$TIMING_DEFAULT_BRANCH" --request-budget 200 --reserve 500 --reservations') ||
    /--resources\b/.test(collection.run) || collection.env?.TIMING_DEFAULT_BRANCH !== "${{ github.event.repository.default_branch }}") fail("timing collection requires seeded acquisition, a hard budget/reserve and no scheduled resource logs");
  for (const step of steps) if ((step.run ?? "").includes("${{") || /bun install/.test(step.run ?? "")) fail("collector scripts must not interpolate events or install candidate dependencies");
  if (!steps.some(s => s.uses === "actions/upload-artifact@v7" && s.if === "always()" && s.with?.["retention-days"] === 90 && s.with?.path === "tmp/ci-timings/")) fail("bounded always-upload timing archive missing");
  return errors;
}

/** Publication has its own narrowly scoped deploy token; contribution CI stays read-only. */
export function publicationWorkflowProblems(text: string): string[] {
  const errors: string[] = [];
  const fail = (message: string) => errors.push(`publish-pages.yml: ${message}`);
  let workflow: Workflow;
  try { workflow = Bun.YAML.parse(text) as Workflow; }
  catch { return ["publish-pages.yml: invalid YAML"]; }
  if (!workflow || typeof workflow !== "object") return ["publish-pages.yml: workflow must be a mapping"];
  if (/\bsecrets\.|\bpull_request(?:_target)?\b|\bworkflow_run\b/.test(text)) fail("publication must not run privileged contribution events or read secrets");
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: "read" })) fail("build token must be contents: read only");
  if (JSON.stringify(Object.keys(workflow.jobs ?? {}).sort()) !== JSON.stringify(["artifact", "deploy"])) fail("publication must separate artifact and deploy jobs");
  const artifact = workflow.jobs?.artifact;
  const deploy = workflow.jobs?.deploy as (NonNullable<Workflow["jobs"]>[string] & { needs?: unknown }) | undefined;
  if (artifact?.permissions !== undefined) fail("artifact job must inherit read-only permissions");
  if (JSON.stringify(deploy?.permissions) !== JSON.stringify({ pages: "write", "id-token": "write" })) fail("only deploy may receive the Pages/OIDC token");
  if (deploy?.needs !== "artifact" || deploy.if !== "needs.artifact.outputs.publish == 'true'") fail("deploy must depend on successful, selected artifact verification");
  const steps = artifact?.steps ?? [];
  const checkouts = steps.filter(step => step.uses?.startsWith("actions/checkout@"));
  if (!checkouts.length || checkouts.some(step => step.with?.["persist-credentials"] !== false)) fail("checkout credentials must not persist");
  const upload = steps.findIndex(step => step.uses === "actions/upload-pages-artifact@v4");
  for (const command of ["bun website/scripts/check.ts", "bun website/scripts/verify-publication.ts"]) {
    const check = steps.findIndex(step => step.run === command);
    if (check < 0 || upload < 0 || check >= upload) fail("browser and identity checks must precede Pages artifact upload");
  }
  return errors;
}

if (import.meta.main) {
  const problems = checkCIWorkflows(resolve(import.meta.dir, ".."));
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log("GitHub CI workflows cover all contributions with read-only execution; Depot CI is disabled.");
}
