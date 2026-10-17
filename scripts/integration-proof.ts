/** The shared merge command consumes actual proof, never a green summary alone. */
import { validateCandidate } from "./candidate-proof";
import { checkout, type Checkout } from "./proof-inputs";
import type { Candidate } from "./integration-reservation";
import type { API } from "./proof-reuse";
import { PROOF_JOBS, proofProblems } from "./ci-proof";

export function checkoutFromJob(log: string): string {
  const lines = log.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const index = lines.findIndex(line => line.includes("git log -1 --format=%H"));
  const value = index < 0 ? undefined : /\b([a-f0-9]{40})\s*$/.exec(lines[index + 1] ?? "")?.[1];
  if (!value) throw new Error("Actual selected job checkout is missing or ambiguous");
  return value;
}

export async function latestIntegrationRun(api: API, workflow: string, candidate: Candidate): Promise<any | undefined> {
  const result = await api.json(`actions/workflows/${workflow}/runs?event=pull_request&head_sha=${candidate.head}&per_page=10`);
  if (!Array.isArray(result.workflow_runs)) throw new Error("Missing canonical workflow run inventory");
  const runs: any[] = result.workflow_runs;
  return runs.filter(run => run.event === "pull_request" && run.head_sha === candidate.head &&
    run.repository?.html_url === candidate.repository && run.head_repository?.html_url === candidate.repository &&
    run.pull_requests?.some((pr: { number: number }) => pr.number === candidate.pr)).sort((a, b) => b.id - a.id)[0];
}

export async function verifyIntegrationProof(root: string, repository: string, candidate: Candidate, api: API,
  fetchCheckout: (sha: string) => void): Promise<{ run: number; checkout: Checkout }> {
  const run = await latestIntegrationRun(api, "ci.yml", candidate);
  const contract = await latestIntegrationRun(api, "contract.yml", candidate);
  if (run?.status !== "completed" || run.conclusion !== "success" || contract?.status !== "completed" || contract.conclusion !== "success") throw new Error("Complete current-candidate CI and contract proof required");
  const inventory = await api.json(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  const jobs: Array<{ id: number; name: string; status: string; conclusion: string; run_id: number; head_sha: string }> = inventory.jobs;
  if (!Array.isArray(jobs) || inventory.total_count !== jobs.length || !jobs.length || jobs.length > 30 ||
      jobs.some(job => !Number.isSafeInteger(job.id) || job.run_id !== run.id || job.head_sha !== candidate.head || job.status !== "completed" || !["success", "skipped"].includes(job.conclusion))) throw new Error("Incomplete or failed selected job inventory");
  const proofs = jobs.filter(job => job.name === "proof" && job.conclusion === "success");
  if (proofs.length !== 1) throw new Error("Missing complete candidate aggregate");
  const proofLog = await api.log(proofs[0].id);
  const receipts = proofLog.split("\n").filter(line => line.includes("BRAIN_CANDIDATE_RECEIPT "));
  if (receipts.length !== 1 || !proofLog.includes("All selected hosted proof passed; remaining skips are planner-intended.")) throw new Error("Missing source-bound selected-proof receipt");
  const selectedLines = proofLog.split("\n").filter(line => line.includes("BRAIN_SELECTED_PROOF_RECEIPT "));
  if (selectedLines.length !== 1) throw new Error("Fresh structured selected-proof receipt required");
  const selected = JSON.parse(selectedLines[0]!.split("BRAIN_SELECTED_PROOF_RECEIPT ")[1]!) as {
    selections: Record<string, string>; results: Record<string, string>; retained: string[]; unitShards: string | null;
  };
  if (!Array.isArray(selected.retained) || selected.retained.some(name => !["browser", "layout"].includes(name))) throw new Error("Unsupported retained proof identity");
  const needs = { changeset: { result: "success", outputs: selected.selections }, ...Object.fromEntries(PROOF_JOBS.map(name => [name, { result: selected.results[name] }])) };
  if (proofProblems(needs, new Set(selected.retained)).length) throw new Error("Selected proof did not satisfy the aggregate policy");
  const expected = ["changeset:success", "proof:success"];
  for (const name of PROOF_JOBS) {
    const fresh = selected.selections[name] === "true" && !selected.retained.includes(name);
    if (fresh && ["browser", "layout"].includes(name)) expected.push(`${name} (1):success`, `${name} (2):success`);
    else if (fresh && name === "unit") {
      const shards: unknown = JSON.parse(selected.unitShards ?? "null");
      if (!Array.isArray(shards) || !shards.length || shards.length > 4 || shards.some((value, index) => value !== index + 1)) throw new Error("Missing actual unit partition identity");
      expected.push(...shards.map(index => `unit (${index}):success`));
    } else expected.push(`${name}:${fresh ? "success" : "skipped"}`);
  }
  if (JSON.stringify(jobs.map(job => `${job.name}:${job.conclusion}`).sort()) !== JSON.stringify(expected.sort())) throw new Error("Actual selected job inventory differs from the validated selection");
  const receipt = JSON.parse(receipts[0]!.split("BRAIN_CANDIDATE_RECEIPT ")[1]!) as { event: string; head: string; base: string; checkout: Checkout };
  if (!["opened", "reopened", "ready_for_review"].includes(receipt.event) || receipt.head !== candidate.head || receipt.base !== candidate.base) throw new Error("Proof does not bind this requested candidate");
  for (const job of jobs.filter(job => job.conclusion === "success")) {
    if (checkoutFromJob(job.id === proofs[0].id ? proofLog : await api.log(job.id)) !== receipt.checkout.sha) throw new Error("Selected job ran a different checkout");
  }
  fetchCheckout(receipt.checkout.sha);
  if (JSON.stringify(checkout(root, receipt.checkout.sha)) !== JSON.stringify(receipt.checkout)) throw new Error("Local immutable checkout differs from job evidence");
  await validateCandidate(root, { action: receipt.event, pull_request: { number: candidate.pr, draft: false,
    head: { sha: candidate.head }, base: { ref: "main", sha: candidate.base } } },
  { GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: receipt.checkout.sha, GITHUB_REPOSITORY: repository }, api, receipt.checkout);
  return { run: run.id, checkout: receipt.checkout };
}
