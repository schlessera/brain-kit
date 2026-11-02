/** Draft heavy feedback (#3272): exact live draft head, bounded yielding, never proof. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { admit, FEEDBACK_AGGREGATE, feedbackProblems, feedbackRequest, requireLiveDraftHead, yieldReason } from "../scripts/heavy-feedback";
import { FEEDBACK_GROUP, renderHeavyFeedbackWorkflow, sameWorkflow } from "../scripts/heavy-feedback-workflow";
import { heavyFeedbackWorkflowProblems } from "../scripts/check-ci-workflows";
import { requestHeavyFeedback, type GH } from "../scripts/request-heavy-feedback";
import { verifyIntegrationProof } from "../scripts/integration-proof";
import { MAX_MS } from "../scripts/integration-reservation";
import type { API } from "../scripts/proof-reuse";

const ROOT = resolve(import.meta.dir, "..");
const REPO = "odysseus/brain-kit";
const HEAD = "a".repeat(40), BASE = "b".repeat(40);
const request = { repository: REPO, pr: 7, head: HEAD };
const draft = { state: "open", draft: true, head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: BASE, repo: { full_name: REPO } } };

function fake(replies: Record<string, unknown>, paths: string[] = []): API {
  return {
    async json(path) {
      paths.push(path);
      if (!(path in replies)) throw new Error(`Unexpected request ${path}`);
      const reply = replies[path];
      if (reply instanceof Error) throw reply;
      return typeof reply === "function" ? reply() : reply;
    },
    async log() { throw new Error("UNEXPECTED_LOG_READ"); },
  };
}
const RESERVATION = "contents/reservation.json?ref=brain-integration-reservation";
const runs = (ids: number[]) => ({ workflow_runs: ids.map(id => ({ id })) });
const idle = (pull: unknown = draft, others: number[] = []) => ({
  "pulls/7": pull, [RESERVATION]: new Error("Proof API refused 404"),
  "actions/workflows/heavy-feedback.yml/runs?event=workflow_dispatch&status=in_progress&per_page=100": runs([41, ...others]),
  "actions/workflows/heavy-feedback.yml/runs?event=workflow_dispatch&status=queued&per_page=100": runs([]),
});

test("the live-head check admits only an open same-repository draft at the requested head", async () => {
  expect(await requireLiveDraftHead(fake({ "pulls/7": draft }), request)).toEqual({ base: BASE, head: HEAD });
  for (const [label, pull, message] of [
    ["MISMATCHED_SHA", { ...draft, head: { ...draft.head, sha: "c".repeat(40) } }, "differs from the requested"],
    ["READY_PR", { ...draft, draft: false }, "is ready"],
    ["CLOSED_PR", { ...draft, state: "closed" }, "is not open"],
    ["FOREIGN_HEAD", { ...draft, head: { ...draft.head, repo: { full_name: "suitor/brain-kit" } } }, "is not a branch of"],
  ] as const) {
    await expect(requireLiveDraftHead(fake({ "pulls/7": pull }), request), label).rejects.toThrow(message);
  }
});

test("workflow inputs must be a positive PR number and an exact SHA", () => {
  const env = { FEEDBACK_PR: "7", FEEDBACK_HEAD_SHA: HEAD, GITHUB_REPOSITORY: REPO };
  expect(feedbackRequest(env)).toEqual(request);
  expect(() => feedbackRequest({ ...env, FEEDBACK_PR: "7; true" })).toThrow("positive PR number");
  expect(() => feedbackRequest({ ...env, FEEDBACK_HEAD_SHA: "main" })).toThrow("exact 40-character head SHA");
});

test("admission yields to a live ready-confirmation lease and to the repository-wide feedback slot", async () => {
  const now = 1_000_000;
  const lease = { id: "f".repeat(32), actor: 3, candidate: { repository: "https://github.com/odysseus/brain-kit", pr: 9, head: HEAD, base: BASE },
    acquired: now - 1000, expires: now + 60_000, cap: now - 1000 + MAX_MS };
  const state = { version: 1, updated: now - 1000, active: lease, last: { action: "acquire", actor: 3, at: now - 1000, previous: null } };
  const content = { encoding: "base64", content: Buffer.from(JSON.stringify(state)).toString("base64") };
  expect(await yieldReason(fake({ ...idle(), [RESERVATION]: content }), 41, now), "YIELDS_TO_CONFIRMATION").toContain("PR #9");
  expect(await yieldReason(fake({ ...idle(), [RESERVATION]: content }), 41, lease.expires), "EXPIRED_LEASE_ADMITS").toBeUndefined();
  expect(await yieldReason(fake(idle(draft, [52])), 41, now), "ONE_OTHER_RUN_FILLS_THE_SLOTS").toContain("52");
  expect(await yieldReason(fake(idle()), 41, now), "OWN_RUN_DOES_NOT_COUNT").toBeUndefined();
});

test("a waiting admission rechecks the live head and stays bounded", async () => {
  let clock = 0; const waits: string[] = [];
  const options = { ownRun: 41, clock: () => clock, sleep: async (ms: number) => { clock += ms; }, log: (line: string) => waits.push(line), waitMs: 90_000, pollMs: 30_000 };
  await expect(admit(() => fake(idle(draft, [52])), request, options), "BOUNDED_WAIT").rejects.toThrow("yielded for the whole admission window");
  expect(waits).toHaveLength(3);
  clock = 0; let polls = 0;
  const pushedWhileWaiting = () => (++polls > 1 ? { ...draft, head: { ...draft.head, sha: "c".repeat(40) } } : draft);
  await expect(admit(() => fake(idle(pushedWhileWaiting, [52])), request, options), "PUSH_REFUSES_WAITING_RUN").rejects.toThrow("differs from the requested");
  expect(await admit(() => fake(idle()), request, options)).toEqual({ base: BASE, head: HEAD });
});

test("the request script reads the live head, dispatches it from the default branch and returns the run identity", async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const gh = (pull: unknown): GH => async (args, input) => {
    calls.push({ args, input });
    if (args.join(" ") === `api repos/${REPO}/pulls/7`) return JSON.stringify(pull);
    if (args.join(" ") === `api repos/${REPO}`) return JSON.stringify({ default_branch: "main" });
    if (args.join(" ") === `api --method POST repos/${REPO}/actions/workflows/heavy-feedback.yml/dispatches --input -`)
      return JSON.stringify({ workflow_run_id: 99, run_url: `https://api.github.com/repos/${REPO}/actions/runs/99`, html_url: `https://github.com/${REPO}/actions/runs/99` });
    throw new Error(`Unexpected gh ${args.join(" ")}`);
  };
  expect(await requestHeavyFeedback(gh(draft), REPO, 7)).toEqual({ pr: 7, head: HEAD, base: BASE, workflow: "heavy-feedback.yml",
    run: 99, url: `https://github.com/${REPO}/actions/runs/99`, api: `https://api.github.com/repos/${REPO}/actions/runs/99` });
  expect(JSON.parse(calls.at(-1)!.input!)).toEqual({ ref: "main", inputs: { pr: "7", head_sha: HEAD } });
  calls.length = 0;
  await expect(requestHeavyFeedback(gh({ ...draft, draft: false }), REPO, 7), "READY_REQUEST_REFUSED").rejects.toThrow("is ready");
  expect(calls.some(call => call.args.includes("POST")), "NO_DISPATCH_AFTER_REFUSAL").toBe(false);
});

test("the feedback aggregate requires its own cadence and every selected category", () => {
  const outputs = { cadence: "feedback-heavy", verify: "true", pack: "false", unit: "true", browser: "false", layout: "false", captures: "false", runtime: "false", runtime_host: "false", endurance: "false" };
  const needs: Record<string, { result: string; outputs?: Record<string, string> }> = { changeset: { result: "success", outputs },
    verify: { result: "success" }, unit: { result: "success" }, ...Object.fromEntries(["pack", "browser", "layout", "captures", "runtime", "runtime_host", "endurance"].map(name => [name, { result: "skipped" }])) };
  expect(feedbackProblems(needs)).toEqual([]);
  expect(feedbackProblems({ ...needs, unit: { result: "failure" } })).toEqual(["unit: selected proof did not pass (failure)"]);
  expect(feedbackProblems({ ...needs, changeset: { result: "success", outputs: { ...outputs, cadence: "confirmation" } } })).toEqual(["admission did not plan a feedback-heavy selection"]);
});

test("the workflow is ci.yml's category jobs with per-PR cancellation and an aggregate never named proof", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const text = readFileSync(join(ROOT, ".github/workflows/heavy-feedback.yml"), "utf8");
  expect(sameWorkflow(text, renderHeavyFeedbackWorkflow(ci)), "GENERATED_FROM_CI").toBe(true);
  expect(heavyFeedbackWorkflowProblems(text, ci)).toEqual([]);
  // Hosted CI pins Bun 1.4.2, whose stringifier leaves a space after each mapping key.
  expect(heavyFeedbackWorkflowProblems(text.replace(/^(\s*[A-Za-z_"-]+:)$/gm, "$1 "), ci), "STRINGIFIER_WHITESPACE_IS_NOT_DRIFT").toEqual([]);
  const workflow = Bun.YAML.parse(text) as any, source = Bun.YAML.parse(ci) as any;
  expect(workflow.concurrency).toEqual({ group: "heavy-feedback-${{ github.event.pull_request.number || inputs.pr }}", "cancel-in-progress": true });
  expect(FEEDBACK_GROUP).toBe(workflow.concurrency.group);
  expect(workflow.jobs.aggregate.name).toBe(FEEDBACK_AGGREGATE);
  expect(Object.entries(workflow.jobs).map(([id, job]: [string, any]) => job.name ?? id)).not.toContain("proof");
  expect(workflow.on.pull_request.types, "PUSH_CANCELS_FEEDBACK").toContain("synchronize");
  for (const name of ["unit", "runtime_host", "browser"]) {
    const pins = (job: any) => job.steps.filter((step: any) => step.uses).map((step: any) => `${step.uses} ${JSON.stringify({ ...step.with, ref: undefined })}`);
    expect(pins(workflow.jobs[name]), `${name}_SAME_PINS`).toEqual(pins(source.jobs[name]));
    expect(workflow.jobs[name].steps.map((step: any) => step.run ?? step.uses)).toEqual(source.jobs[name].steps.map((step: any) => step.run ?? step.uses));
    expect(workflow.jobs[name]["timeout-minutes"]).toBe(source.jobs[name]["timeout-minutes"]);
  }
  for (const [label, mutated, problem] of [
    ["NO_CANCELLATION", text.replace("cancel-in-progress: true", "cancel-in-progress: false"), "at most one draft heavy run per PR"],
    ["GLOBAL_GROUP", text.replace(FEEDBACK_GROUP, "heavy-feedback"), "at most one draft heavy run per PR"],
    ["NAMED_PROOF", text.replace(`name: ${FEEDBACK_AGGREGATE}`, "name: proof"), "never be named proof"],
    ["STALE_COPY", text.replace("timeout-minutes: 45", "timeout-minutes: 44"), "stale copy"],
  ] as const) expect(heavyFeedbackWorkflowProblems(mutated, ci).join("\n"), label).toContain(problem);
});

test("the merge gate refuses a PR whose only heavy evidence is a draft heavy feedback run", async () => {
  const candidate = { repository: `https://github.com/${REPO}`, pr: 7, head: HEAD, base: BASE };
  const run = (id: number, extra: Record<string, unknown> = {}) => ({ id, run_attempt: 1, event: "pull_request", head_sha: HEAD, status: "completed", conclusion: "success",
    repository: { html_url: candidate.repository }, head_repository: { html_url: candidate.repository }, pull_requests: [{ number: 7 }], ...extra });
  const job = (name: string, conclusion = "success") => ({ id: name.length, name, status: "completed", conclusion, run_id: 17, head_sha: HEAD });
  const paths: string[] = [];
  const api = fake({
    // The draft ci.yml run passed its cheap gates and skipped every heavy category.
    [`actions/workflows/ci.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=10`]: { workflow_runs: [run(17)] },
    [`actions/workflows/contract.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=10`]: { workflow_runs: [run(18)] },
    "actions/runs/17/attempts/1/jobs?per_page=100": { total_count: 3, jobs: [job("changeset"), job("draft gates"), job("unit", "skipped")] },
    // The feedback run ran the heavy categories, but the gate never reads it.
    [`actions/workflows/heavy-feedback.yml/runs?event=workflow_dispatch&head_sha=${HEAD}&per_page=10`]: { workflow_runs: [run(21, { event: "workflow_dispatch", pull_requests: [] })] },
  }, paths);
  await expect(verifyIntegrationProof("unused", REPO, candidate, api, () => { throw new Error("UNEXPECTED_CHECKOUT_FETCH"); }), "FEEDBACK_IS_NOT_MERGE_EVIDENCE")
    .rejects.toThrow("Missing complete candidate aggregate");
  expect(paths.some(path => path.includes("heavy-feedback"))).toBe(false);
});
