import { expect, test } from "bun:test";
import { proofCadence, planChecks, proofSelections } from "../scripts/ci-plan";
import { validateCandidate } from "../scripts/candidate-proof";
import type { API } from "../scripts/proof-reuse";

const actual = { sha: "a".repeat(40), tree: "b".repeat(40), parents: ["c".repeat(40), "d".repeat(40)] };
const event = { action: "ready_for_review", pull_request: { number: 7, draft: false,
  head: { sha: actual.parents[1] }, base: { sha: actual.parents[0], ref: "main" } } };
const env = { GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: actual.sha, GITHUB_REPOSITORY: "fixture/brain-kit" };
function api(change: Record<string, unknown> = {}): API {
  const replies: Record<string, unknown> = {
    "pulls/7": { state: "open", draft: false, head: event.pull_request.head, base: { ref: "main", repo: { full_name: env.GITHUB_REPOSITORY } } },
    "git/ref/heads/main": { object: { sha: actual.parents[0] } },
    [`git/commits/${actual.sha}`]: { sha: actual.sha, tree: { sha: actual.tree }, parents: actual.parents.map(sha => ({ sha })) },
    ...change,
  };
  return { async json(path) { if (!(path in replies)) throw new Error(`Unexpected request ${path}`); return replies[path]; }, async log() { throw new Error("Unexpected log"); } };
}

test("events distinguish cheap drafts, fast pushes, explicit final requests and fresh integrated/exhaustive proof", () => {
  for (const action of ["opened", "reopened", "ready_for_review"]) expect(proofCadence(env, { ...event, action })).toBe("confirmation");
  for (const action of ["synchronize", "edited", "unknown", undefined]) expect(proofCadence(env, { ...event, action })).toBe("feedback");
  expect(proofCadence(env, { ...event, pull_request: { ...event.pull_request, draft: true } })).toBe("draft");
  expect(proofCadence({ GITHUB_EVENT_NAME: "push" }, {})).toBe("integrated");
  for (const name of ["schedule", "workflow_dispatch"]) expect(proofCadence({ GITHUB_EVENT_NAME: name }, {})).toBe("exhaustive");
  expect(() => proofCadence({ GITHUB_EVENT_NAME: "unknown" }, {})).toThrow("Unknown proof event");
  const plan = planChecks(["package.json"], [{ dir: "ui-react", name: "@fixture/ui-react", dependencies: [], files: ["src"] }]);
  plan.cadence = "feedback";
  expect(proofSelections(plan)).toEqual({ verify: true, pack: false, unit: false, browser: false, layout: false, captures: false, runtime: false, endurance: false });
  plan.cadence = "confirmation";
  expect(proofSelections(plan).endurance).toBe(true);
});

test("intermediate green feedback cannot satisfy final candidate confirmation", async () => {
  await expect(validateCandidate("", { ...event, action: "synchronize" }, env, api(), actual)).rejects.toThrow("Candidate confirmation required");
  await validateCandidate("", event, env, api(), actual);
});

test("candidate gate rejects changed head, base, readiness, immutable tree and missing evidence", async () => {
  for (const live of [
    { state: "open", draft: false, head: { sha: "e".repeat(40) } },
    { state: "closed", draft: false, head: event.pull_request.head },
    { state: "open", draft: true, head: event.pull_request.head },
  ]) await expect(validateCandidate("", event, env, api({ "pulls/7": live }), actual)).rejects.toThrow("Candidate became stale");
  await expect(validateCandidate("", event, env, api({ "git/ref/heads/main": { object: { sha: "e".repeat(40) } } }), actual)).rejects.toThrow("Candidate became stale");
  await expect(validateCandidate("", event, env, api({ [`git/commits/${actual.sha}`]: {} }), actual)).rejects.toThrow("immutable GitHub");
  await expect(validateCandidate("", event, env, undefined, actual)).rejects.toThrow("live read-only");
  await expect(validateCandidate("", event, env, api(), { ...actual, parents: [...actual.parents].reverse() })).rejects.toThrow("checkout does not match");
  await expect(validateCandidate("", event, { ...env, GITHUB_SHA: "e".repeat(40) }, api(), actual)).rejects.toThrow("checkout does not match");
});
