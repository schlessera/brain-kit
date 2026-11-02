/** Draft heavy feedback: affected heavy categories on a draft head, never proof (#3272).
 *
 * `admit` runs first in `.github/workflows/heavy-feedback.yml`. It reads the
 * live PR and refuses unless it is open, a draft, from this repository and at
 * exactly the requested head. It then yields to ready confirmation: it waits
 * while the exact-candidate integration reservation holds a live lease, and
 * while another feedback run already occupies the repository-wide slot.
 * `aggregate` reports the selected categories under the `draft heavy
 * feedback` check. It prints no candidate receipt, and the merge gate never
 * reads this workflow. Policy: docs/decisions/ci-utility.md, "Hosted heavy
 * feedback on draft heads".
 */
import { appendFileSync } from "node:fs";
import { proofProblems } from "./ci-proof";
import { liveLease, parseReservation, RESERVATION_REF } from "./integration-reservation";
import { GitHubProofAPI, type API } from "./proof-reuse";

export const FEEDBACK_WORKFLOW = "heavy-feedback.yml";
export const FEEDBACK_AGGREGATE = "draft heavy feedback";
/** Feedback runs allowed in flight repository-wide, counting the admitted run. */
export const FEEDBACK_SLOTS = 2;
export const ADMISSION_WAIT_MS = 30 * 60_000, ADMISSION_POLL_MS = 30_000;

export interface FeedbackRequest { repository: string; pr: number; head: string; }
export interface LiveDraft { base: string; head: string; }

/** Parses workflow inputs; strings arrive from `workflow_dispatch`, never trusted as shell text. */
export function feedbackRequest(env: NodeJS.ProcessEnv): FeedbackRequest {
  const pr = Number(env.FEEDBACK_PR), head = env.FEEDBACK_HEAD_SHA ?? "", repository = env.GITHUB_REPOSITORY ?? "";
  if (!/^[1-9]\d{0,9}$/.test(env.FEEDBACK_PR ?? "") || !Number.isSafeInteger(pr)) throw new Error("Draft heavy feedback requires a positive PR number");
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Draft heavy feedback requires the exact 40-character head SHA");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Draft heavy feedback requires GITHUB_REPOSITORY");
  return { repository, pr, head };
}

/** The live PR must be an open same-repository draft at exactly the requested head. */
export async function requireLiveDraftHead(api: API, request: FeedbackRequest): Promise<LiveDraft> {
  const live = await api.json(`pulls/${request.pr}`);
  if (live?.state !== "open") throw new Error(`Draft heavy feedback refused: PR #${request.pr} is not open`);
  if (live.draft !== true) throw new Error(`Draft heavy feedback refused: PR #${request.pr} is ready; ready PRs get proof through candidate confirmation`);
  if (live.head?.repo?.full_name !== request.repository || live.base?.repo?.full_name !== request.repository) throw new Error(`Draft heavy feedback refused: PR #${request.pr} is not a branch of ${request.repository}`);
  if (live.head?.sha !== request.head) throw new Error(`Draft heavy feedback refused: the live head ${String(live.head?.sha)} differs from the requested ${request.head}`);
  if (!/^[a-f0-9]{40}$/.test(live.base?.sha ?? "")) throw new Error("Draft heavy feedback refused: the live PR base is unavailable");
  return { base: live.base.sha, head: live.head.sha };
}

/** Why this run must wait for ready confirmation or another feedback run, or undefined when admitted. */
export async function yieldReason(api: API, ownRun: number, now: number): Promise<string | undefined> {
  let reservation: any;
  try { reservation = await api.json(`contents/reservation.json?ref=${encodeURIComponent(RESERVATION_REF.replace("refs/heads/", ""))}`); }
  catch (error) { if (!/\b404\b/.test(String(error))) throw error; }
  if (reservation) {
    if (reservation.encoding !== "base64" || typeof reservation.content !== "string") throw new Error("Unreadable integration reservation state");
    const state = parseReservation(Buffer.from(reservation.content, "base64").toString("utf8"));
    if (liveLease(state.active, now)) return `ready confirmation holds the integration reservation for PR #${state.active.candidate.pr}`;
  }
  const others: number[] = [];
  for (const status of ["in_progress", "queued"]) {
    const result = await api.json(`actions/workflows/${FEEDBACK_WORKFLOW}/runs?event=workflow_dispatch&status=${status}&per_page=100`);
    if (!Array.isArray(result?.workflow_runs)) throw new Error("Missing draft heavy feedback run inventory");
    for (const run of result.workflow_runs) if (Number.isSafeInteger(run?.id) && run.id !== ownRun && !others.includes(run.id)) others.push(run.id);
  }
  if (others.length >= FEEDBACK_SLOTS - 1) return `${others.length} other draft heavy feedback run(s) in flight (${others.join(", ")}); at most ${FEEDBACK_SLOTS} run at once`;
  return undefined;
}

export interface AdmitOptions { ownRun: number; clock?: () => number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void; waitMs?: number; pollMs?: number; }

/** Bounded admission: the head is rechecked on every poll, so a push refuses a waiting run.
 * Each poll gets a fresh client, because one proof API client has a short request budget. */
export async function admit(client: () => API, request: FeedbackRequest, options: AdmitOptions): Promise<LiveDraft> {
  const clock = options.clock ?? Date.now, sleep = options.sleep ?? Bun.sleep, log = options.log ?? console.log;
  const deadline = clock() + (options.waitMs ?? ADMISSION_WAIT_MS);
  for (;;) {
    const api = client();
    const live = await requireLiveDraftHead(api, request);
    const reason = await yieldReason(api, options.ownRun, clock());
    if (!reason) return live;
    if (clock() >= deadline) throw new Error(`Draft heavy feedback yielded for the whole admission window: ${reason}. Request it again later.`);
    log(`Waiting: ${reason}.`);
    await sleep(options.pollMs ?? ADMISSION_POLL_MS);
  }
}

/** Same category policy as the proof aggregate, without its candidate identity: this is feedback. */
export function feedbackProblems(needs: Parameters<typeof proofProblems>[0]): string[] {
  if (needs?.changeset?.outputs?.cadence !== "feedback-heavy") return ["admission did not plan a feedback-heavy selection"];
  return proofProblems(needs);
}

if (import.meta.main) {
  try {
    const command = process.argv[2];
    const request = feedbackRequest(process.env);
    if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("Draft heavy feedback runs only from its dispatch");
    if (!process.env.GH_TOKEN) throw new Error("Draft heavy feedback requires a read-only GitHub token");
    const token = process.env.GH_TOKEN;
    if (command === "admit") {
      const live = await admit(() => new GitHubProofAPI(request.repository, token), request, { ownRun: Number(process.env.GITHUB_RUN_ID) });
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `base_sha=${live.base}\n`);
      console.log(`BRAIN_FEEDBACK_ADMISSION ${JSON.stringify({ pr: request.pr, head: live.head, base: live.base })}`);
    } else if (command === "aggregate") {
      const problems = feedbackProblems(JSON.parse(process.env.PROOF_NEEDS ?? "null"));
      if (problems.length) throw new Error(problems.join("\n"));
      console.log(`Draft heavy feedback passed for PR #${request.pr} at ${request.head}. This is feedback, not proof: request candidate confirmation after the final push.`);
    } else throw new Error("Usage: bun scripts/heavy-feedback.ts admit|aggregate");
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
}
