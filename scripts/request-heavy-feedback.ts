/** Request draft heavy feedback for a PR's live head (#3272). Feedback is never proof.
 *
 *   bun scripts/request-heavy-feedback.ts <pr> [--json]
 *
 * Reads the live head, dispatches `.github/workflows/heavy-feedback.yml` from
 * the default branch with that PR number and head SHA, and prints the run URL.
 * `--json` prints the run identity. A newer request or push for the same PR
 * cancels the earlier run. Policy: docs/decisions/ci-utility.md, "Hosted heavy
 * feedback on draft heads".
 */
import { FEEDBACK_WORKFLOW, requireLiveDraftHead } from "./heavy-feedback";
import type { API } from "./proof-api";
import { gh as ghCommand, resolveRepository } from "./lib/gh";

const FEEDBACK_GH = { trim: true, error: (_args: readonly string[], code: number, stderr: string) => stderr.trim() || `gh exited ${code}` };

/** One `gh` invocation: argv plus optional stdin, resolving stdout. */
export type GH = (args: string[], input?: string) => Promise<string>;

interface FeedbackRun { pr: number; head: string; base: string; workflow: string; run: number; url: string; api: string; }

export async function requestHeavyFeedback(gh: GH, repository: string, pr: number): Promise<FeedbackRun> {
  if (!Number.isSafeInteger(pr) || pr < 1) throw new Error("Usage: bun scripts/request-heavy-feedback.ts <pr> [--json]");
  const api: API = { async json(path) { return JSON.parse(await gh(["api", `repos/${repository}/${path}`])); },
    async log() { throw new Error("Draft heavy feedback requests read no logs"); } };
  const head = (await api.json(`pulls/${pr}`))?.head?.sha;
  if (!/^[a-f0-9]{40}$/.test(head ?? "")) throw new Error(`PR #${pr} has no readable head`);
  // Refuse locally what the workflow would refuse, before spending a dispatch.
  const live = await requireLiveDraftHead(api, { repository, pr, head });
  const branch = JSON.parse(await gh(["api", `repos/${repository}`]))?.default_branch;
  if (typeof branch !== "string" || !branch) throw new Error("Default branch unavailable");
  // Only with return_run_details does the dispatch endpoint answer 200 with
  // workflow_run_id, run_url and html_url; without it the body is empty.
  const body = await gh(["api", "--method", "POST", `repos/${repository}/actions/workflows/${FEEDBACK_WORKFLOW}/dispatches`, "--input", "-"],
    JSON.stringify({ ref: branch, inputs: { pr: String(pr), head_sha: live.head }, return_run_details: true }));
  const response = body ? JSON.parse(body) : undefined;
  if (!Number.isSafeInteger(response?.workflow_run_id) || typeof response.html_url !== "string" || typeof response.run_url !== "string") throw new Error("GitHub accepted the dispatch without returning its run identity");
  return { pr, head: live.head, base: live.base, workflow: FEEDBACK_WORKFLOW, run: response.workflow_run_id, url: response.html_url, api: response.run_url };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2), json = args.includes("--json");
    const rest = args.filter(arg => arg !== "--json");
    if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]!)) throw new Error("Usage: bun scripts/request-heavy-feedback.ts <pr> [--json]");
    const repository = resolveRepository();
    const run = await requestHeavyFeedback((args, input) => ghCommand(args, { ...FEEDBACK_GH, input }), repository, Number(rest[0]));
    console.log(json ? JSON.stringify(run, null, 2) : run.url);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
