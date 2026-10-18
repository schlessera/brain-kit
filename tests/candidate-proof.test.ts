import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planFromEnvironment, proofCadence, planChecks, proofSelections } from "../scripts/ci-plan";
import { PROOF_JOBS } from "../scripts/ci-proof";
import { git } from "../scripts/proof-inputs";
import { requireCandidate, validateCandidate } from "../scripts/candidate-proof";
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
  expect(proofSelections(plan)).toEqual({ verify: true, pack: false, unit: false, browser: false, layout: false, captures: false, runtime: false, runtime_host: false, endurance: false });
  plan.cadence = "confirmation";
  expect(proofSelections(plan).endurance).toBe(true);
});

test("intermediate green feedback cannot satisfy final candidate confirmation", async () => {
  await expect(validateCandidate("", { ...event, action: "synchronize" }, env, api(), actual)).rejects.toThrow("Candidate confirmation required");
  await validateCandidate("", event, env, api(), actual);
});

test("a draft-mode run cannot pass once the live PR is ready, even when queued after the ready event", async () => {
  const draft = { ...event, action: "synchronize", pull_request: { ...event.pull_request, draft: true } };
  const live = { state: "open", draft: true, head: event.pull_request.head };
  for (const action of ["opened", "reopened", "synchronize", "converted_to_draft"]) {
    await validateCandidate("", { ...draft, action }, env, api({ "pulls/7": live }), actual);
    await expect(validateCandidate("", { ...draft, action }, env, api(), actual)).rejects.toThrow("Draft proof is stale");
  }
  await expect(validateCandidate("", draft, env, api(), actual)).rejects.toThrow("Candidate confirmation required");
  for (const change of [{ head: { sha: "e".repeat(40) } }, { state: "closed" }, { state: undefined }, { state: "merged" }, { draft: undefined }])
    await expect(validateCandidate("", draft, env, api({ "pulls/7": { ...live, ...change } }), actual)).rejects.toThrow("Draft proof is stale");
  const unreadable: API = { async json() { throw new Error("Proof API refused 503"); }, async log() { throw new Error("Unexpected log"); } };
  await expect(validateCandidate("", draft, env, unreadable, actual)).rejects.toThrow("Proof API refused 503");
  await expect(validateCandidate("", draft, env, undefined, actual)).rejects.toThrow("live read-only GitHub readiness");
  await expect(validateCandidate("", { ...draft, pull_request: { ...draft.pull_request, number: 0 } }, env, api({ "pulls/7": live }), actual)).rejects.toThrow("missing its PR identity");
  await expect(validateCandidate("", { ...draft, pull_request: { ...draft.pull_request, head: {} } }, env, api({ "pulls/7": live }), actual)).rejects.toThrow("missing its PR identity");
  // The hosted aggregate's entry point reaches the same live check; without a token it cannot pass.
  await expect(requireCandidate("", draft, { ...env, GITHUB_ACTIONS: "true", GH_TOKEN: "" })).rejects.toThrow("live read-only GitHub readiness");
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

test("the hosted entry point reads live readiness through its own API client", async () => {
  const draft = { ...event, action: "synchronize", pull_request: { ...event.pull_request, draft: true } };
  const hosted = { ...env, GITHUB_ACTIONS: "true", GH_TOKEN: "fixture-token" };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
  const reads: string[] = [];
  let live: unknown = { state: "open", draft: true, head: event.pull_request.head };
  Object.defineProperty(globalThis, "fetch", { ...descriptor, value: async (url: string) => {
    reads.push(url);
    return new Response(JSON.stringify(live), { status: 200 });
  } });
  try {
    await requireCandidate("", draft, hosted);
    live = { state: "open", draft: false, head: event.pull_request.head };
    await expect(requireCandidate("", draft, hosted)).rejects.toThrow("Draft proof is stale");
  } finally {
    Object.defineProperty(globalThis, "fetch", descriptor);
  }
  expect(reads).toEqual(Array(2).fill(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/pulls/7`));
});

test("the emitted hosted aggregate refuses a draft run it cannot verify as still draft", async () => {
  const root = resolve(import.meta.dir, "..");
  const head = git(root, "rev-parse", "HEAD").trim();
  const draft = { action: "synchronize", pull_request: { number: 7, draft: true, head: { sha: head }, base: { sha: head, ref: "main" } } };
  const plan = planFromEnvironment(root, { GITHUB_EVENT_NAME: "pull_request", BASE_SHA: head, HEAD_SHA: head });
  plan.cadence = "draft";
  const selections = proofSelections(plan);
  const needs = { changeset: { result: "success", outputs: { cadence: "draft", ...Object.fromEntries(Object.entries(selections).map(([name, on]) => [name, String(on)])) } },
    ...Object.fromEntries(PROOF_JOBS.map(name => [name, { result: selections[name] ? "success" : "skipped" }])) };
  const directory = mkdtempSync(join(tmpdir(), "draft-proof-event-"));
  try {
    writeFileSync(join(directory, "event.json"), JSON.stringify(draft));
    const child = Bun.spawn([process.execPath, "scripts/ci-proof.ts", "aggregate"], { cwd: root,
      env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: join(directory, "event.json"),
        GITHUB_REPOSITORY: env.GITHUB_REPOSITORY, GITHUB_SHA: head, GH_TOKEN: "", PROOF_NEEDS: JSON.stringify(needs) }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, err).toBe(1);
    expect(err).toContain("Draft proof requires live read-only GitHub readiness verification");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
