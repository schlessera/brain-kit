/** Generates `.github/workflows/heavy-feedback.yml` from `ci.yml` (#3272).
 *
 * Draft heavy feedback must run the same category jobs and pins as candidate
 * confirmation. Rather than a hand-maintained copy, the category jobs are
 * copied from ci.yml and only their checkout ref and planner environment are
 * replaced. `bun run lint` refuses a stale file through check-ci-workflows.ts.
 *
 *   bun scripts/heavy-feedback-workflow.ts           # rewrite the workflow
 *   bun scripts/heavy-feedback-workflow.ts --check   # fail if it is stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FEEDBACK_AGGREGATE } from "./heavy-feedback";

export const CATEGORY_JOBS = ["verify", "pack", "unit", "runtime", "runtime_host", "browser", "layout", "captures", "endurance"] as const;
export const FEEDBACK_GROUP = "heavy-feedback-${{ github.event.pull_request.number || inputs.pr }}";
const HEAD = "${{ inputs.head_sha }}";
const DISPATCH = "github.event_name == 'workflow_dispatch'";

type Step = Record<string, any> & { uses?: string; run?: string; with?: Record<string, any>; env?: Record<string, any> };
type Job = Record<string, any> & { steps: Step[] };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const pinned = (job: Job, action: string): Step => {
  const step = job.steps.find(s => s.uses?.startsWith(`${action}@`));
  if (!step) throw new Error(`ci.yml changeset job lost its ${action} pin`);
  return clone(step);
};

/** Category jobs check out the requested head and plan it against the admitted PR base. */
function categoryJob(job: Job): Job {
  const copy = clone(job);
  for (const step of copy.steps) {
    if (step.uses?.startsWith("actions/checkout@")) step.with = { ...step.with, ref: HEAD };
    if (step.run === "bun scripts/ci-plan.ts") step.env = {
      BASE_SHA: "${{ needs.changeset.outputs.base_sha }}", HEAD_SHA: HEAD, FEEDBACK_PR: "${{ inputs.pr }}",
    };
  }
  return copy;
}

export function renderHeavyFeedbackWorkflow(ciText: string): string {
  const ci = Bun.YAML.parse(ciText) as { jobs: Record<string, Job> };
  const metadata = ci.jobs.changeset!;
  const checkout = pinned(metadata, "actions/checkout"), bun = pinned(metadata, "oven-sh/setup-bun");
  const install = metadata.steps.find(s => s.run === "bun install --frozen-lockfile");
  if (!install) throw new Error("ci.yml changeset job lost its frozen install");
  const request = { FEEDBACK_PR: "${{ inputs.pr }}", FEEDBACK_HEAD_SHA: HEAD, GH_TOKEN: "${{ github.token }}" };
  const outputs = { ...clone(metadata.outputs), base_sha: "${{ steps.admit.outputs.base_sha }}" };
  delete outputs.reuse; // Feedback never retains or records proof.
  const workflow = {
    name: "Draft heavy feedback",
    on: {
      workflow_dispatch: { inputs: {
        pr: { description: "Draft PR number", required: true, type: "string" },
        head_sha: { description: "Exact live head SHA of that PR", required: true, type: "string" },
      } },
      // A push, a ready transition or closing the PR cancels its in-flight feedback run.
      pull_request: { types: ["synchronize", "ready_for_review", "closed"] },
    },
    permissions: { contents: "read", actions: "read", checks: "read" },
    concurrency: { group: FEEDBACK_GROUP, "cancel-in-progress": true },
    jobs: {
      supersede: {
        if: "github.event_name == 'pull_request'",
        "runs-on": "ubuntu-24.04", "timeout-minutes": 1,
        steps: [{ name: "Cancel this PR's in-flight draft heavy feedback", run: "echo 'A newer head or readiness change superseded draft heavy feedback for this PR.'" }],
      },
      changeset: {
        name: "heavy feedback admission",
        if: DISPATCH,
        "runs-on": "ubuntu-24.04",
        // 30 minutes of bounded yielding to ready confirmation + planning.
        "timeout-minutes": 40,
        outputs,
        steps: [
          { ...clone(checkout), with: { ...checkout.with, "fetch-depth": 1 } },
          clone(bun), clone(install),
          { name: "Refuse a stale, ready, closed or foreign head; yield to ready confirmation", id: "admit", env: request, run: "bun scripts/heavy-feedback.ts admit" },
          { ...clone(checkout), with: { ...checkout.with, "fetch-depth": 0, ref: HEAD } },
          clone(install),
          { name: "Plan the PR's affected selection with feedback-heavy cadence", id: "plan",
            env: { BASE_SHA: "${{ steps.admit.outputs.base_sha }}", HEAD_SHA: HEAD, FEEDBACK_PR: "${{ inputs.pr }}" }, run: "bun scripts/ci-plan.ts" },
          { name: "Select fresh browser and layout execution", id: "reuse", run: "bun scripts/proof-reuse.ts" },
        ],
      },
      ...Object.fromEntries(CATEGORY_JOBS.map(name => [name, categoryJob(ci.jobs[name]!)])),
      aggregate: {
        name: FEEDBACK_AGGREGATE,
        needs: ["changeset", ...CATEGORY_JOBS],
        if: `\${{ always() && !cancelled() && ${DISPATCH} }}`,
        "runs-on": "ubuntu-24.04", "timeout-minutes": 3,
        steps: [clone(checkout), clone(bun), clone(install),
          { name: "Report every selected category; this is feedback, never proof",
            env: { ...request, PROOF_NEEDS: "${{ toJSON(needs) }}" }, run: "bun scripts/heavy-feedback.ts aggregate" }],
      },
    },
  };
  return "# Generated by scripts/heavy-feedback-workflow.ts from ci.yml; do not edit.\n" +
    "# Draft heavy feedback (#3272) runs a draft PR's affected heavy categories with\n" +
    "# the same jobs and pins as confirmation. It is never `proof`; request it with\n" +
    "# `bun scripts/request-heavy-feedback.ts <pr>`.\n" + Bun.YAML.stringify(workflow, null, 2);
}

/** Freshness compares parsed structure: Bun's YAML stringifier whitespace differs
 * between versions (1.4.2 leaves a space after each mapping key), and hosted CI
 * pins an older Bun than a developer may run. Any job, pin or timeout change still differs. */
export function sameWorkflow(text: string, rendered: string): boolean {
  try { return Bun.deepEquals(Bun.YAML.parse(text), Bun.YAML.parse(rendered), true); } catch { return false; }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const target = join(root, ".github/workflows/heavy-feedback.yml");
  const rendered = renderHeavyFeedbackWorkflow(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
  if (process.argv.includes("--check")) {
    let current = "";
    try { current = readFileSync(target, "utf8"); } catch {}
    if (!sameWorkflow(current, rendered)) { console.error("heavy-feedback.yml is stale: run bun scripts/heavy-feedback-workflow.ts"); process.exit(1); }
  } else writeFileSync(target, rendered);
}
