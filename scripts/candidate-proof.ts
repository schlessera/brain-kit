/** Exact merge-candidate validation; feedback never authorizes merging. */
import { planFromEnvironment, proofCadence, proofSelections } from "./ci-plan";
import { checkout, type Checkout } from "./proof-inputs";
import { GitHubProofAPI, type API } from "./proof-reuse";

export async function validateCandidate(root: string, event: any, env: NodeJS.ProcessEnv,
  api?: API, actual: Checkout = checkout(root)): Promise<void> {
  const cadence = proofCadence(env, event);
  if (cadence === "feedback") throw new Error("Candidate confirmation required: convert this PR to draft, then mark ready for review after the final push.");
  if (cadence !== "confirmation") return;
  const pr = event.pull_request;
  if (!Number.isSafeInteger(pr?.number) || pr.number < 1 || !pr.base?.ref || !pr.head?.sha || !pr.base?.sha ||
      actual.sha !== env.GITHUB_SHA || JSON.stringify(actual.parents) !== JSON.stringify([pr.base.sha, pr.head.sha])) {
    throw new Error("Candidate checkout does not match the requested head/base merge identity");
  }
  if (!api) throw new Error("Candidate confirmation requires live read-only GitHub identity verification");
  const live = await api.json(`pulls/${pr.number}`);
  const base = await api.json(`git/ref/heads/${encodeURIComponent(pr.base.ref)}`);
  const commit = await api.json(`git/commits/${actual.sha}`);
  if (live.state !== "open" || live.draft !== false || live.head?.sha !== pr.head.sha ||
      live.base?.ref !== pr.base.ref || live.base?.repo?.full_name !== env.GITHUB_REPOSITORY || base.object?.sha !== pr.base.sha) {
    throw new Error("Candidate became stale: the live PR head, readiness or base changed; request confirmation again");
  }
  if (commit.sha !== actual.sha || commit.tree?.sha !== actual.tree ||
      JSON.stringify(commit.parents?.map((parent: any) => parent.sha)) !== JSON.stringify(actual.parents)) {
    throw new Error("Candidate checkout differs from immutable GitHub commit evidence");
  }
  console.log(`BRAIN_CANDIDATE_RECEIPT ${JSON.stringify({ event: event.action, head: pr.head.sha, base: pr.base.sha, checkout: actual })}`);
}

export function validateSelections(root: string, event: any, env: NodeJS.ProcessEnv, outputs: Record<string, string> | undefined): void {
  const cadence = proofCadence(env, event);
  if (outputs?.cadence !== cadence) throw new Error("Candidate selection cadence is missing or inconsistent");
  const plan = planFromEnvironment(root, { ...env, BASE_SHA: event.pull_request?.base?.sha,
    BEFORE_SHA: event.before, HEAD_SHA: event.pull_request?.head?.sha ?? env.GITHUB_SHA });
  plan.cadence = cadence;
  for (const [category, selected] of Object.entries(proofSelections(plan))) {
    if (outputs?.[category] !== String(selected)) throw new Error(`${category}: required candidate selection differs from actual inputs`);
  }
}

export async function requireCandidate(root: string, event: any, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.GITHUB_ACTIONS !== "true") return; // Local aggregate fixtures have no hosted identity.
  const api = env.GH_TOKEN && env.GITHUB_REPOSITORY ? new GitHubProofAPI(env.GITHUB_REPOSITORY, env.GH_TOKEN) : undefined;
  await validateCandidate(root, event, env, api);
}
