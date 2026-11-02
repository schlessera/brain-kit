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
import type { API } from "./proof-reuse";

/** One `gh` invocation: argv plus optional stdin, resolving stdout. */
export type GH = (args: string[], input?: string) => Promise<string>;

export interface FeedbackRun { pr: number; head: string; base: string; workflow: string; run: number; url: string; api: string; }

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
  // The dispatch endpoint answers 200 with workflow_run_id, run_url and html_url.
  const body = await gh(["api", "--method", "POST", `repos/${repository}/actions/workflows/${FEEDBACK_WORKFLOW}/dispatches`, "--input", "-"],
    JSON.stringify({ ref: branch, inputs: { pr: String(pr), head_sha: live.head } }));
  const response = body ? JSON.parse(body) : undefined;
  if (!Number.isSafeInteger(response?.workflow_run_id) || typeof response.html_url !== "string" || typeof response.run_url !== "string") throw new Error("GitHub accepted the dispatch without returning its run identity");
  return { pr, head: live.head, base: live.base, workflow: FEEDBACK_WORKFLOW, run: response.workflow_run_id, url: response.html_url, api: response.run_url };
}

async function gh(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(["gh", ...args], { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(err.trim() || `gh exited ${code}`);
  return out.trim();
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2), json = args.includes("--json");
    const rest = args.filter(arg => arg !== "--json");
    if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]!)) throw new Error("Usage: bun scripts/request-heavy-feedback.ts <pr> [--json]");
    const repository = process.env.BRAIN_KIT_REPOSITORY ?? "schlessera/brain-kit";
    const run = await requestHeavyFeedback(gh, repository, Number(rest[0]));
    console.log(json ? JSON.stringify(run, null, 2) : run.url);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
