/** GitHub is the sole CI provider; contributions share read-only workflows. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DETERMINISM_PARTITIONS, PROOF_SHARDS, shardNumbers, type ShardedDomain } from "./proof-shards";
import { FEEDBACK_AGGREGATE } from "./heavy-feedback";
import { CATEGORY_JOBS, FEEDBACK_GROUP, renderHeavyFeedbackWorkflow, sameWorkflow } from "./heavy-feedback-workflow";
import { actionPinProblems, pinned } from "./action-pins";

export const CI_WORKFLOWS = ["ci.yml", "contract.yml"] as const;
const RUN_EXPRESSIONS = new Set(["matrix.shard", "github.event_name", "github.base_ref", "github.event.before"]);
type Step = { id?: string; "continue-on-error"?: unknown; uses?: string; run?: string; if?: string; "timeout-minutes"?: unknown; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs?: Record<string, { name?: string; "runs-on"?: unknown; "timeout-minutes"?: unknown; if?: string; needs?: unknown; permissions?: unknown; steps?: Step[] }>;
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
  const permissions = file === "ci.yml" ? { contents: "read", actions: "read" } : { contents: "read" };
  if (JSON.stringify(workflow.permissions) !== JSON.stringify(permissions)) fail("workflow permissions must be the specified read-only contents/actions scope");
  const expectedTriggers = file === "ci.yml" ? ["pull_request", "push", "schedule", "workflow_dispatch"] : ["pull_request"];
  if (JSON.stringify(Object.keys(workflow.on ?? {}).sort()) !== JSON.stringify(expectedTriggers)) fail("unexpected contribution triggers");
  const expectedJobs = file === "ci.yml" ? ["browser", "captures", "changeset", "determinism", "endurance", "layout", "pack", "proof", "runtime", "runtime_host", "unit", "verify"] : ["contract"];
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
    const names = ["verify", "pack", "unit", "runtime", "runtime_host", "browser", "layout", "captures", "endurance", "determinism"];
    for (const name of names) {
      const job = workflow.jobs?.[name];
      if (job?.needs !== "changeset") fail(`${name}: independent proof must depend only on metadata`);
      // The planner's selection alone decides: no second output may skip a selected category (#4107).
      const selection = `needs.changeset.outputs.${name} == 'true'`;
      // Main pushes run selected proof even when the metadata job fails (#2942);
      // PR proof still requires a successful metadata job.
      if (job?.if !== `\${{ !cancelled() && (needs.changeset.result == 'success' || github.event_name == 'push') && ${selection} }}`) fail(`${name}: proof must run on its explicit planner selection alone`);
    }
    const verify = workflow.jobs?.verify;
    const verifySteps = verify?.steps ?? [];
    for (const [id, command, minutes] of [["verify_install", "bun install --frozen-lockfile", 1],
      ["verify_plan", "bun scripts/ci-plan.ts", 1], ["verify_proof", "bun scripts/ci-runner.ts", 4]] as const) {
      const step = verifySteps.find(s => s.id === id);
      if (step?.run !== command || step["timeout-minutes"] !== minutes || step.if !== undefined || step["continue-on-error"] !== undefined)
        fail(`verify: ${id} must retain its separate ${minutes}-minute limit and command`);
    }
    if (verify?.["timeout-minutes"] !== 1 + 1 + 4 + 1) fail("verify: job limit must equal 1+1+4+1 minutes");
    const summary = verifySteps.find(s => s.run === "bun scripts/ci-verify-summary.ts");
    if (summary?.if !== "always()" || summary.env?.INSTALL_OUTCOME !== "${{ steps.verify_install.outcome }}" ||
        summary.env?.PLAN_OUTCOME !== "${{ steps.verify_plan.outcome }}" || summary.env?.PROOF_OUTCOME !== "${{ steps.verify_proof.outcome }}" ||
        summary.env?.CI_COMMAND_RECEIPTS !== "tmp/verify-commands.jsonl" ||
        verifySteps.find(s => s.id === "verify_proof")?.env?.CI_COMMAND_RECEIPTS !== "tmp/verify-commands.jsonl" ||
        verifySteps.indexOf(summary) <= verifySteps.findIndex(s => s.id === "verify_proof"))
      fail("verify: always summary must separate raw install, planning and proof outcomes and receipts");
    // Network prerequisites cannot spend proof capacity; measured basis: docs/decisions/ci-utility.md (#2658).
    // Repeated changed tests need the unit job's prerequisites: they may drive real Chrome (#4109).
    for (const [name, proofMinutes] of [["unit", 30], ["runtime", 15], ["runtime_host", 15], ["determinism", DETERMINISM_PARTITIONS.stepMinutes]] as const) {
      const job = workflow.jobs?.[name];
      const setup = job?.steps?.find(step => step.run === `bash scripts/ci-runtime-setup.sh${name === "unit" || name === "determinism" ? "" : " --native"}`);
      const command = `bun scripts/ci-proof.ts ${name}`;
      const proof = job?.steps?.find(step => step.run === command || step.run?.startsWith(`${command} `));
      if (setup?.["timeout-minutes"] !== 12) fail(`${name}: environment setup must have its separate 12-minute limit`);
      if (proof?.["timeout-minutes"] !== proofMinutes) fail(`${name}: proof must retain its ${proofMinutes}-minute limit`);
      const limit = job?.["timeout-minutes"];
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 12 + proofMinutes + 3) fail(`${name}: job limit must cover setup, proof and 3 minutes of other steps`);
    }
    // Matrices, the merge path and the cost refresh share one shard table; a drifted matrix would strand a partition.
    for (const domain of Object.keys(PROOF_SHARDS) as ShardedDomain[]) {
      const job = workflow.jobs?.[domain] as any;
      if (JSON.stringify(job?.strategy?.matrix?.shard) !== JSON.stringify(shardNumbers(domain)) ||
          !job?.steps?.some((step: any) => step.run === `bun scripts/ci-proof.ts ${domain} --shard=\${{ matrix.shard }}/${PROOF_SHARDS[domain]}`)) fail(`${domain}: matrix and shard divisor must match PROOF_SHARDS`);
    }
    // The unit partition count has one owner, UNIT_PARTITIONS, read by the planner per cadence (#4108).
    // A literal matrix, a second matrix dimension or a literal divisor would disagree with it.
    const unit = workflow.jobs?.unit as any, changeset = workflow.jobs?.changeset as any;
    const unitProof = unit?.steps?.find((step: Step) => step.run?.startsWith("bun scripts/ci-proof.ts unit"));
    if (changeset?.outputs?.unit_shards !== "${{ steps.plan.outputs.unit_shards }}" ||
        changeset?.steps?.find((step: Step) => step.id === "plan")?.run !== "bun scripts/ci-plan.ts" ||
        JSON.stringify(unit?.strategy?.matrix) !== JSON.stringify({ shard: "${{ fromJSON(needs.changeset.outputs.unit_shards) }}" }) ||
        unitProof?.run !== 'bun scripts/ci-proof.ts unit --shard=${{ matrix.shard }}/"$UNIT_SHARDS"' ||
        unitProof?.env?.UNIT_SHARDS !== "${{ strategy.job-total }}") fail("unit: matrix and shard divisor must come from the planner's unit_shards output");
    // The determinism partition set has one owner too, DETERMINISM_PARTITIONS, read by the planner (#4117).
    // A literal matrix or divisor would run a partition of some split the planner did not make.
    const determinism = workflow.jobs?.determinism as any;
    const determinismProof = determinism?.steps?.find((step: Step) => step.run?.startsWith("bun scripts/ci-proof.ts determinism"));
    if (changeset?.outputs?.determinism_shards !== "${{ steps.plan.outputs.determinism_shards }}" ||
        JSON.stringify(determinism?.strategy?.matrix) !== JSON.stringify({ shard: "${{ fromJSON(needs.changeset.outputs.determinism_shards) }}" }) ||
        determinismProof?.run !== 'bun scripts/ci-proof.ts determinism --shard=${{ matrix.shard }}/"$DETERMINISM_SHARDS"' ||
        determinismProof?.env?.DETERMINISM_SHARDS !== "${{ strategy.job-total }}") fail("determinism: matrix and shard divisor must come from the planner's determinism_shards output");
    // One artifact name per partition: a shared name fails every upload after the first.
    if (!determinism?.steps?.some((step: Step) => step.uses?.startsWith("actions/upload-artifact@") && step.with?.name === "determinism-proof-${{ matrix.shard }}")) fail("determinism: each partition must upload its own receipts");
    const proof = workflow.jobs?.proof;
    if (proof?.name !== "${{ github.event_name != 'pull_request' && 'integrated or exhaustive proof' || github.event.pull_request.draft && 'draft gates' || 'proof' }}") fail("proof: draft, manual or main runs must not impersonate candidate confirmation");
    if (JSON.stringify(proof?.needs) !== JSON.stringify(["changeset", ...names])) fail("proof: aggregate must observe every selected category");
    if (proof?.if !== "${{ always() && !cancelled() }}") fail("proof: aggregate must observe failures/skips and reject cancellation");
    for (const category of ["unit", "runtime", "runtime_host", "browser", "layout", "captures", "endurance", "determinism"]) {
      if (!workflow.jobs?.[category]?.steps?.some(step => step.run === `bun scripts/ci-proof.ts ${category}` || step.run?.startsWith(`bun scripts/ci-proof.ts ${category} `))) fail(`${category}: complete proof command is missing`);
    }
    if (!proof?.steps?.some(step => step.run === "bun scripts/ci-proof.ts aggregate")) fail("proof: executable aggregate is missing");
    const metadata = workflow.jobs?.changeset?.steps ?? [];
    const admission = metadata.findIndex(step => step.run === "bun scripts/candidate-proof.ts");
    const planning = metadata.findIndex(step => step.run === "bun scripts/ci-plan.ts");
    const discovery = metadata.findIndex(step => step.run === "bun scripts/proof-inventory.ts");
    if (admission <= planning || discovery <= admission || metadata[admission]?.if !== "steps.plan.outputs.cadence == 'confirmation'" ||
        metadata[admission]?.env?.GH_TOKEN !== "${{ github.token }}") fail("metadata: confirmation admission must validate identity after planning and before product discovery");
  }
  if (file === "contract.yml") {
    // The event's base is wrong for native stack layers on some triggers (#2650).
    const steps = workflow.jobs?.contract?.steps ?? [];
    const gate = steps.find(step => step.run?.startsWith("bun scripts/check-contract-pr.ts"));
    const eventBase = /github\.base_ref|pull_request\.base/;
    if (gate?.run !== 'bun scripts/check-contract-pr.ts --declared-base "$HEAD_SHA"' ||
        gate.env?.PR_NUMBER !== "${{ github.event.pull_request.number }}" || gate.env?.GH_TOKEN !== "${{ github.token }}" ||
        steps.some(step => Object.entries(step.env ?? {}).some(([key, value]) => key !== "EVENT_BASE_REF" && eventBase.test(String(value))) || eventBase.test(step.run ?? ""))) {
      fail("contract: the comparison base must be the PR's declared base, read at run time, never the event's");
    }
  }
  return problems;
}

export function checkCIWorkflows(root: string): string[] {
  const problems: string[] = [];
  const directory = join(root, ".github/workflows");
  const files = existsSync(directory) ? readdirSync(directory).sort() : [];
  // The red-main coordinator and its triage probe are authoritative coordination (#2942).
  const expected = ["ci.yml", "contract.yml", "project-sync.yml", "red-main.yml", "red-main-probe.yml"];
  if (files.includes("publish-pages.yml")) expected.push("publish-pages.yml");
  if (files.includes("ci-timings.yml")) expected.push("ci-timings.yml");
  if (files.includes("heavy-feedback.yml")) expected.push("heavy-feedback.yml");
  if (files.includes("ci-evidence-archive.yml")) expected.push("ci-evidence-archive.yml");
  if (files.includes("ci-evidence-report.yml")) expected.push("ci-evidence-report.yml");
  if (JSON.stringify(files) !== JSON.stringify(expected.sort())) problems.push("GitHub must contain only authoritative CI, contract, project-sync, red-main coordination and optional Pages/timing/archive/report/heavy-feedback workflows");
  // Every workflow, authoritative or not, runs only reviewed action commits (#4111).
  for (const file of files.filter(file => /\.ya?ml$/.test(file))) problems.push(...actionPinProblems(readFileSync(join(directory, file), "utf8"), file));
  const depot = join(root, ".depot/workflows");
  if (existsSync(depot) && readdirSync(depot).some(file => /\.ya?ml$/.test(file))) problems.push("Active Depot CI workflow definitions must be removed");
  for (const file of CI_WORKFLOWS) {
    const path = join(directory, file);
    if (!existsSync(path)) problems.push(`${file}: missing authoritative GitHub workflow`);
    else problems.push(...workflowProblems(readFileSync(path, "utf8"), file));
  }
  const pages = join(directory, "publish-pages.yml");
  if (existsSync(pages)) problems.push(...publicationWorkflowProblems(readFileSync(pages, "utf8")));
  const feedback = join(directory, "heavy-feedback.yml");
  if (existsSync(feedback) && existsSync(join(directory, "ci.yml"))) problems.push(...heavyFeedbackWorkflowProblems(readFileSync(feedback, "utf8"), readFileSync(join(directory, "ci.yml"), "utf8")));
  const timings = join(directory, "ci-timings.yml");
  if (existsSync(timings)) problems.push(...timingWorkflowProblems(readFileSync(timings, "utf8")));
  const archive = join(directory, "ci-evidence-archive.yml");
  if (existsSync(archive)) problems.push(...archiveWorkflowProblems(readFileSync(archive, "utf8")));
  const report = join(directory, "ci-evidence-report.yml");
  if (existsSync(report)) problems.push(...reportWorkflowProblems(readFileSync(report, "utf8")));
  return problems;
}

/**
 * The evidence archive (#2955) is the one measurement job with write
 * authority: `contents: write` on that job alone, for the data ref, as
 * docs/decisions/ci-evidence.md rules. It runs trusted default-branch code.
 */
export function archiveWorkflowProblems(text: string): string[] {
  const errors: string[] = [], fail = (message: string) => errors.push(`ci-evidence-archive.yml: ${message}`);
  let workflow: Workflow;
  try { workflow = Bun.YAML.parse(text) as Workflow; }
  catch { return ["ci-evidence-archive.yml: invalid YAML"]; }
  if (!workflow || typeof workflow !== "object") return ["ci-evidence-archive.yml: workflow must be a mapping"];
  if (JSON.stringify(Object.keys(workflow.on ?? {}).sort()) !== JSON.stringify(["schedule", "workflow_dispatch"]) ||
      /\bsecrets\.|\bpull_request(?:_target)?\b|\bworkflow_run\b/.test(text)) fail("archive must use scheduled/manual trusted execution only");
  const schedule = workflow.on?.schedule as { cron?: string }[] | undefined;
  if (!Array.isArray(schedule) || schedule.length !== 1 || !/^\d{1,2} \d{1,2} \* \* \*$/.test(schedule[0]?.cron ?? "")) fail("archive compaction must run once a day");
  if (JSON.stringify(workflow.permissions) !== "{}") fail("workflow token must grant nothing; write authority belongs to the archive job alone");
  if (JSON.stringify(Object.keys(workflow.jobs ?? {})) !== JSON.stringify(["archive"])) fail("archive workflow must contain only the archive job");
  const job = workflow.jobs?.archive;
  if (JSON.stringify(job?.permissions) !== JSON.stringify({ contents: "write", actions: "read" })) fail("archive job may only write contents (the data ref) and read actions");
  if (job?.needs !== undefined || job?.["runs-on"] !== "ubuntu-24.04") fail("archive job must be independent on its declared hosted runner");
  const steps = job?.steps ?? [], checkouts = steps.filter(s => s.uses?.startsWith("actions/checkout@"));
  if (checkouts.length !== 1 || checkouts[0]?.with?.ref !== "${{ github.event.repository.default_branch }}" || checkouts[0]?.with?.repository !== undefined) fail("archive must check out trusted default-branch code");
  const archive = steps.find(s => s.run?.includes("bun scripts/ci-timings.ts archive"));
  if (!archive?.run?.includes('bun scripts/ci-timings.ts archive --repo "$ARCHIVE_REPO" --branch "$ARCHIVE_DEFAULT_BRANCH" --request-budget "$ARCHIVE_BUDGET" --reserve 500') ||
    archive.env?.ARCHIVE_DEFAULT_BRANCH !== "${{ github.event.repository.default_branch }}") fail("archive requires the default branch's artifacts, a hard budget and the shared quota reserve");
  for (const step of steps) if ((step.run ?? "").includes("${{") || /bun install/.test(step.run ?? "")) fail("archive scripts must not interpolate events or install dependencies");
  return errors;
}

/**
 * The scheduled evidence reports (#2956) read the data ref and main's history
 * and write only their own artifacts: no write authority at all, trusted
 * default-branch code, and an always-uploaded 90-day artifact
 * (docs/decisions/ci-evidence.md). Posting them is a separate job's grant.
 */
export function reportWorkflowProblems(text: string): string[] {
  const errors: string[] = [], fail = (message: string) => errors.push(`ci-evidence-report.yml: ${message}`);
  let workflow: Workflow;
  try { workflow = Bun.YAML.parse(text) as Workflow; }
  catch { return ["ci-evidence-report.yml: invalid YAML"]; }
  if (!workflow || typeof workflow !== "object") return ["ci-evidence-report.yml: workflow must be a mapping"];
  if (JSON.stringify(Object.keys(workflow.on ?? {}).sort()) !== JSON.stringify(["schedule", "workflow_dispatch"]) ||
      /\bsecrets\.|\bpull_request(?:_target)?\b|\bworkflow_run\b/.test(text)) fail("reports must use scheduled/manual trusted execution only");
  const schedule = workflow.on?.schedule as { cron?: string }[] | undefined;
  if (!Array.isArray(schedule) || schedule.length !== 1 || !/^\d{1,2} \d{1,2} \* \* \*$/.test(schedule[0]?.cron ?? "")) fail("reports must run once a day");
  if (JSON.stringify(workflow.permissions) !== "{}") fail("workflow token must grant nothing");
  if (JSON.stringify(Object.keys(workflow.jobs ?? {})) !== JSON.stringify(["report"])) fail("report workflow must contain only the report job");
  const job = workflow.jobs?.report;
  if (JSON.stringify(job?.permissions) !== JSON.stringify({ contents: "read" })) fail("the report job may only read contents");
  const steps = job?.steps ?? [], checkouts = steps.filter(s => s.uses?.startsWith("actions/checkout@"));
  if (checkouts.length !== 1 || checkouts[0]?.with?.ref !== "${{ github.event.repository.default_branch }}" || checkouts[0]?.with?.repository !== undefined ||
    checkouts[0]?.with?.["fetch-depth"] !== 0 || checkouts[0]?.with?.["persist-credentials"] !== false) fail("reports must check out trusted default-branch code with full history");
  if (!steps.some(s => s.run?.includes("bun scripts/ci-evidence-report.ts --cadence daily")) || !steps.some(s => s.run?.includes("bun scripts/ci-evidence-report.ts --cadence weekly")))
    fail("reports must generate the daily digest and the weekly report");
  if (!steps.some(s => s.uses === pinned("actions/upload-artifact@v7") && s.if === "always()" && s.with?.["retention-days"] === 90 && s.with?.path === "tmp/ci-evidence/"))
    fail("the report artifacts must always be uploaded for 90 days");
  for (const step of steps) if ((step.run ?? "").includes("${{") || /bun install/.test(step.run ?? "")) fail("report scripts must not interpolate events or install dependencies");
  return errors;
}

/** Draft heavy feedback (#3272): ci.yml's own category jobs, per-PR cancellation, never `proof`. */
export function heavyFeedbackWorkflowProblems(text: string, ciText: string): string[] {
  const errors: string[] = [], fail = (message: string) => errors.push(`heavy-feedback.yml: ${message}`);
  let workflow: Workflow & { concurrency?: Record<string, unknown> };
  try { workflow = Bun.YAML.parse(text) as typeof workflow; }
  catch { return ["heavy-feedback.yml: invalid YAML"]; }
  if (!workflow || typeof workflow !== "object") return ["heavy-feedback.yml: workflow must be a mapping"];
  let rendered = "";
  try { rendered = renderHeavyFeedbackWorkflow(ciText); } catch (error) { fail(`cannot derive from ci.yml: ${String(error)}`); }
  if (rendered && !sameWorkflow(text, rendered)) fail("stale copy of ci.yml's category jobs and pins; run bun scripts/heavy-feedback-workflow.ts");
  if (/\bsecrets\.|\bpull_request_target\b|\bworkflow_run\b/.test(text)) fail("feedback must not expose secrets or privileged triggers");
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: "read", actions: "read" })) fail("token must stay read-only");
  if (JSON.stringify(Object.keys(workflow.on ?? {}).sort()) !== JSON.stringify(["pull_request", "workflow_dispatch"])) fail("only a dispatch requests feedback; pull_request only cancels it");
  const inputs = (workflow.on?.workflow_dispatch as any)?.inputs;
  if (inputs?.pr?.required !== true || inputs?.head_sha?.required !== true) fail("dispatch must name the PR and its exact head");
  if (workflow.concurrency?.group !== FEEDBACK_GROUP || workflow.concurrency?.["cancel-in-progress"] !== true) fail("at most one draft heavy run per PR: per-PR group with cancel-in-progress");
  const jobs = workflow.jobs ?? {};
  // A job's check name is its `name`, or its id when unnamed.
  if (Object.entries(jobs).some(([id, job]) => String(job.name ?? id).trim().toLowerCase() === "proof")) fail("feedback must never be named proof");
  if (jobs.aggregate?.name !== FEEDBACK_AGGREGATE) fail(`aggregate must be named ${FEEDBACK_AGGREGATE}`);
  if (JSON.stringify(jobs.aggregate?.needs) !== JSON.stringify(["changeset", ...CATEGORY_JOBS])) fail("aggregate must observe every selected category");
  if (!jobs.aggregate?.steps?.some(step => step.run === "bun scripts/heavy-feedback.ts aggregate") ||
      jobs.aggregate?.steps?.some(step => /ci-proof\.ts aggregate|candidate-proof/.test(step.run ?? ""))) fail("aggregate must report feedback without candidate receipts");
  const admission = jobs.changeset?.steps ?? [];
  const admit = admission.findIndex(step => step.run === "bun scripts/heavy-feedback.ts admit");
  const headCheckout = admission.findIndex(step => step.uses?.startsWith("actions/checkout@") && step.with?.ref === "${{ inputs.head_sha }}");
  if (admit < 0 || headCheckout <= admit) fail("admission must refuse a stale, ready, closed or foreign head before checking it out");
  for (const [name, job] of Object.entries(jobs)) {
    if (job["runs-on"] !== "ubuntu-24.04") fail(`${name}: unmapped GitHub-hosted runner`);
    if (job.permissions !== undefined) fail(`${name}: job permissions must inherit the read-only workflow token`);
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith("actions/checkout@") && step.with?.["persist-credentials"] !== false) fail(`${name}: checkout credentials must not persist`);
      for (const match of (step.run ?? "").matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)) if (!RUN_EXPRESSIONS.has(match[1]!)) fail(`${name}: untrusted expression in run script: ${match[1]}`);
    }
  }
  return errors;
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
  if (!collection?.run?.includes('bun scripts/ci-timings.ts collect --repo "$TIMING_REPO" --since "$since" --seed "$TIMING_DEFAULT_BRANCH" --request-budget 200 --reserve 500 --reservations --red-main') ||
    /--resources\b/.test(collection.run) || collection.env?.TIMING_DEFAULT_BRANCH !== "${{ github.event.repository.default_branch }}") fail("timing collection requires seeded acquisition, a hard budget/reserve and no scheduled resource logs");
  for (const step of steps) if ((step.run ?? "").includes("${{") || /bun install/.test(step.run ?? "")) fail("collector scripts must not interpolate events or install candidate dependencies");
  if (!steps.some(s => s.uses === pinned("actions/upload-artifact@v7") && s.if === "always()" && s.with?.["retention-days"] === 90 && s.with?.path === "tmp/ci-timings/")) fail("bounded always-upload timing archive missing");
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
  const upload = steps.findIndex(step => step.uses === pinned("actions/upload-pages-artifact@v4"));
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
