/** GitHub is the sole CI provider; contributions share read-only workflows. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const CI_WORKFLOWS = ["ci.yml", "contract.yml"] as const;
const RUN_EXPRESSIONS = new Set(["matrix.shard", "github.event_name", "github.base_ref", "github.event.before"]);
type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs?: Record<string, { "runs-on"?: unknown; if?: string; permissions?: unknown; steps?: Step[] }>;
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
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: "read" })) fail("workflow permissions must be contents: read only");
  const expectedTriggers = file === "ci.yml" ? ["pull_request", "push"] : ["pull_request"];
  if (JSON.stringify(Object.keys(workflow.on ?? {}).sort()) !== JSON.stringify(expectedTriggers)) fail("unexpected contribution triggers");
  const expectedJobs = file === "ci.yml" ? ["changeset", "pack", "verify"] : ["contract"];
  if (JSON.stringify(Object.keys(workflow.jobs ?? {}).sort()) !== JSON.stringify(expectedJobs)) fail("missing or unexpected CI jobs");
  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    if (job["runs-on"] !== "ubuntu-24.04") fail(`${name}: unmapped GitHub-hosted runner`);
    if (job.permissions !== undefined) fail(`${name}: job permissions must inherit the read-only workflow token`);
    if (/head\.repo|depot|fork\s*\//i.test(job.if ?? "")) fail(`${name}: provider routing must not exclude contributions`);
    if (!job.steps?.length) fail(`${name}: executable steps must be nonempty`);
    const checkouts = job.steps?.filter(step => step.uses?.startsWith("actions/checkout@")) ?? [];
    if (!checkouts.length) fail(`${name}: checkout is missing`);
    for (const step of checkouts) if (step.with?.["persist-credentials"] !== false) fail(`${name}: checkout credentials must not persist`);
    for (const step of job.steps ?? []) {
      for (const match of (step.run ?? "").matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)) {
        if (!RUN_EXPRESSIONS.has(match[1]!)) fail(`${name}: untrusted expression in run script: ${match[1]}`);
      }
    }
  }
  return problems;
}

export function checkCIWorkflows(root: string): string[] {
  const problems: string[] = [];
  const directory = join(root, ".github/workflows");
  const files = existsSync(directory) ? readdirSync(directory).sort() : [];
  if (JSON.stringify(files) !== JSON.stringify(["ci.yml", "contract.yml", "project-sync.yml"])) problems.push("GitHub must contain only the authoritative CI, contract and project-sync workflows");
  const depot = join(root, ".depot/workflows");
  if (existsSync(depot) && readdirSync(depot).some(file => /\.ya?ml$/.test(file))) problems.push("Active Depot CI workflow definitions must be removed");
  for (const file of CI_WORKFLOWS) {
    const path = join(directory, file);
    if (!existsSync(path)) problems.push(`${file}: missing authoritative GitHub workflow`);
    else problems.push(...workflowProblems(readFileSync(path, "utf8"), file));
  }
  return problems;
}

if (import.meta.main) {
  const problems = checkCIWorkflows(resolve(import.meta.dir, ".."));
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log("GitHub CI workflows cover all contributions with read-only execution; Depot CI is disabled.");
}
