import { expect, test } from "bun:test";
import { verifyIntegrationProof } from "../scripts/integration-proof";
import { scanText } from "../scripts/check-leakage";
import type { API } from "../scripts/proof-reuse";

const candidate = { repository: "https://github.com/odysseus/brain-kit", pr: 7, head: "a".repeat(40), base: "b".repeat(40) };
const job = { id: 19, name: "changeset", status: "completed", conclusion: "success", run_id: 17, head_sha: candidate.head };

async function refusal(inventory: unknown): Promise<string> {
  const paths: string[] = [];
  const api: API = {
    async json(path) {
      paths.push(path);
      if (path === "actions/runs/17/attempts/2/jobs?per_page=100") return inventory;
      expect(path).toMatch(/^actions\/workflows\/(ci|contract)\.yml\/runs\?event=pull_request&head_sha=a{40}&per_page=10$/);
      return { workflow_runs: [{ id: 17, run_attempt: 2, event: "pull_request", head_sha: candidate.head,
        repository: { html_url: candidate.repository }, head_repository: { html_url: candidate.repository },
        pull_requests: [{ number: candidate.pr }], status: "completed", conclusion: "success" }] };
    },
    async log() { throw new Error("UNEXPECTED_LOG_READ"); },
  };
  let message = "";
  try { await verifyIntegrationProof("unused", "odysseus/brain-kit", candidate, api, () => { throw new Error("UNEXPECTED_CHECKOUT_FETCH"); }); }
  catch (error) { message = (error as Error).message; }
  expect(paths).toHaveLength(3); // One inventory read; no retry, logs or checkout work.
  expect(scanText("refusal", message)).toEqual([]);
  return message;
}

for (const [predicate, inventory] of [
  ["jobs is not an array", { total_count: 1 }],
  ["total_count differs from jobs.length", { total_count: 2, jobs: [job] }],
  ["jobs.length is zero", { total_count: 0, jobs: [] }],
  ["jobs.length exceeds 30", { total_count: 31, jobs: Array.from({ length: 31 }, () => ({ ...job })) }],
] as const) test(`inventory refuses ${predicate} with count context`, async () => {
  const message = await refusal(inventory);
  expect(message).toContain("Incomplete or failed selected job inventory");
  expect(message).toContain(predicate);
  expect(message).toContain('"run_id":17,"attempt":2');
  expect(message).toContain('"total_count":' + inventory.total_count);
  expect(message).toContain('"page_length":' + ("jobs" in inventory ? inventory.jobs.length : '"unavailable"'));
});

for (const [predicate, change] of [
  ["job.id is not a safe integer", { id: 1.5 }],
  ["job.run_id differs from run.id", { run_id: 18 }],
  ["job.head_sha differs from candidate.head", { head_sha: "c".repeat(40) }],
  ["job.status is not completed", { status: "in_progress" }],
  ["job.conclusion is not success/skipped", { conclusion: "failure" }],
] as const) test(`inventory refuses ${predicate} with offending job metadata`, async () => {
  const offending = { ...job, ...change };
  const message = await refusal({ total_count: 2, jobs: [job, offending] });
  expect(message).toContain(predicate);
  expect(message).toContain('"run_id":17,"attempt":2,"total_count":2,"page_length":2');
  expect(message).toContain('"index":1');
  expect(message).not.toContain('"index":0');
  expect(message).toContain('"job":' + JSON.stringify(offending));
});

test("valid success/skipped inventory reaches the unchanged aggregate guard", async () => {
  expect(await refusal({ total_count: 2, jobs: [job, { ...job, id: 20, conclusion: "skipped" }] }))
    .toBe("Missing complete candidate aggregate");
});

test("diagnostics redact arbitrary strings and nested metadata without reading logs", async () => {
  const secret = "Bearer fictional-odysseus-secret\n" + "x".repeat(10_000);
  const message = await refusal({ total_count: secret, jobs: [{ id: secret, name: secret, status: secret,
    conclusion: secret, run_id: { secret }, head_sha: secret, raw_log: secret }] });
  expect(message).toContain("total_count differs from jobs.length");
  for (const predicate of ["job.id is not a safe integer", "job.run_id differs from run.id", "job.head_sha differs from candidate.head",
    "job.status is not completed", "job.conclusion is not success/skipped"]) expect(message).toContain(predicate);
  expect(message).not.toContain("Bearer");
  expect(message).not.toContain("fictional-odysseus-secret");
  expect(message).not.toContain("raw_log");
  expect(message).toContain('"name":"unrecognized"');
  expect(message.length).toBeLessThan(1800);
});

test("diagnostics bound oversized responses and retain safe shard identities", async () => {
  const message = await refusal({ total_count: 101, jobs: Array.from({ length: 101 }, () =>
    ({ ...job, name: "unit (2)", status: "queued" })) });
  const detail = JSON.parse(message.split("inventory: ")[1]!);
  expect(detail.offending).toHaveLength(100);
  expect(detail.omitted_jobs).toBe(1);
  expect(detail.offending[99].job.name).toBe("unit (2)");
});

test("count refusal diagnostics tolerate null jobs and invalid scalar fields", async () => {
  const message = await refusal({ total_count: 3, jobs: [null, {}] });
  expect(message).toContain("total_count differs from jobs.length");
  const detail = JSON.parse(message.split("inventory: ")[1]!);
  expect(detail.offending).toHaveLength(2);
  expect(detail.offending[0].job).toEqual({ id: "invalid", name: "unrecognized", status: "unrecognized",
    conclusion: "unrecognized", run_id: "invalid", head_sha: "invalid" });
});

for (const [label, inventory] of [
  ["null", null], ["missing", undefined], ["boolean", false], ["number", 17],
  ["string", "Bearer fictional-odysseus-secret"], ["array", []],
] as const) test(`inventory shape refusal diagnoses ${label} before dereferencing`, async () => {
  const message = await refusal(inventory);
  expect(message).toStartWith("Incomplete or failed selected job inventory: ");
  const detail = JSON.parse(message.split("inventory: ")[1]!);
  expect(detail.predicates).toContain("inventory is not an object");
  expect(detail).toMatchObject({ run_id: 17, attempt: 2, total_count: "invalid", page_length: "unavailable" });
  expect(message).not.toContain("Bearer");
  expect(message.length).toBeLessThan(1800);
});

for (const [label, malformed] of [
  ["null", null], ["missing", undefined], ["boolean", false], ["number", 19],
  ["string", "Bearer fictional-odysseus-secret"], ["array", []],
  ["array with valid job fields", Object.assign([], job)],
] as const) test(`matching-count job shape refusal diagnoses ${label} before dereferencing`, async () => {
  const message = await refusal({ total_count: 2, jobs: [job, malformed] });
  expect(message).toStartWith("Incomplete or failed selected job inventory: ");
  const detail = JSON.parse(message.split("inventory: ")[1]!);
  expect(detail).toMatchObject({ run_id: 17, attempt: 2, total_count: 2, page_length: 2, predicates: [] });
  expect(detail.offending).toHaveLength(1);
  expect(detail.offending[0]).toMatchObject({ index: 1, predicates: ["job is not an object",
    "job.id is not a safe integer", "job.run_id differs from run.id", "job.head_sha differs from candidate.head",
    "job.status is not completed", "job.conclusion is not success/skipped"],
    job: { id: "invalid", name: "unrecognized", status: "unrecognized", conclusion: "unrecognized", run_id: "invalid", head_sha: "invalid" } });
  expect(message).not.toContain("Bearer");
  expect(message.length).toBeLessThan(1800);
});

/** A ready confirmation as the merge path reads it: the aggregate's receipts plus the run's actual job inventory. */
async function confirmationOutcome(published: unknown, ran: readonly number[]): Promise<string> {
  const categories = ["verify", "pack", "unit", "browser", "layout", "captures", "runtime", "runtime_host", "endurance"];
  const fast = (name: string) => ["verify", "pack", "unit"].includes(name);
  const checkout = { sha: "d".repeat(40), tree: "e".repeat(40), parents: [candidate.base, candidate.head] };
  const selected = { selections: Object.fromEntries(categories.map(name => [name, String(fast(name))])),
    results: Object.fromEntries(categories.map(name => [name, fast(name) ? "success" : "skipped"])), retained: [],
    unitShards: typeof published === "string" || published === null ? published : JSON.stringify(published) };
  let id = 100;
  const entry = (name: string, conclusion = "success") => ({ ...job, id: id++, name, conclusion });
  const jobs = [entry("changeset"), entry("proof"), ...categories.flatMap(name => name === "unit" ? ran.map(shard => entry(`unit (${shard})`))
    : [entry(name, fast(name) ? "success" : "skipped")])];
  const actual = `[command]/usr/bin/git log -1 --format=%H\n2026-07-12T00:00:00Z ${checkout.sha}\n`;
  const proofLog = actual + `BRAIN_CANDIDATE_RECEIPT ${JSON.stringify({ event: "ready_for_review", head: candidate.head, base: candidate.base, checkout })}\n` +
    `BRAIN_SELECTED_PROOF_RECEIPT ${JSON.stringify(selected)}\nAll selected hosted proof passed; remaining skips are planner-intended.\n`;
  const api: API = {
    async json(path) {
      if (path === "actions/runs/17/attempts/2/jobs?per_page=100") return { total_count: jobs.length, jobs };
      return { workflow_runs: [{ id: 17, run_attempt: 2, event: "pull_request", head_sha: candidate.head,
        repository: { html_url: candidate.repository }, head_repository: { html_url: candidate.repository },
        pull_requests: [{ number: candidate.pr }], status: "completed", conclusion: "success" }] };
    },
    async log(jobId) { return jobId === jobs[1]!.id ? proofLog : actual; },
  };
  // Reaching the checkout fetch means the inventory, partition and per-job checkout guards all accepted the run.
  try { await verifyIntegrationProof("unused", "odysseus/brain-kit", candidate, api, sha => { throw new Error(`ACCEPTED_INVENTORY ${sha}`); }); }
  catch (error) { return (error as Error).message; }
  return "verified without fetching the checkout";
}

test("the merge path accepts a confirmation only with exactly its planned unit partitions (#4108)", async () => {
  const eight = [1, 2, 3, 4, 5, 6, 7, 8], accepted = `ACCEPTED_INVENTORY ${"d".repeat(40)}`;
  const differs = "Actual selected job inventory differs from the validated selection", identity = "Missing actual unit partition identity";
  expect(await confirmationOutcome(eight, eight), "EIGHT_PLANNED_EIGHT_RAN").toBe(accepted);
  // A narrow inventory plans fewer partitions; the same exactness holds.
  expect(await confirmationOutcome([1, 2, 3], [1, 2, 3]), "THREE_PLANNED_THREE_RAN").toBe(accepted);
  expect(await confirmationOutcome(eight, eight.slice(0, 7)), "DROPPED_LAST_PARTITION").toBe(differs);
  expect(await confirmationOutcome(eight, [1, 2, 3, 5, 6, 7, 8]), "DROPPED_MIDDLE_PARTITION").toBe(differs);
  expect(await confirmationOutcome(eight, [...eight, 8]), "DUPLICATE_PARTITION").toBe(differs);
  expect(await confirmationOutcome(eight.slice(0, 4), eight), "RAN_MORE_THAN_PLANNED").toBe(differs);
  expect(await confirmationOutcome([...eight, 9], [...eight, 9]), "ABOVE_CONFIRMATION_CAP").toBe(identity);
  expect(await confirmationOutcome([1, 2, 4, 3, 5, 6, 7, 8], eight), "REORDERED_PLAN").toBe(identity);
  expect(await confirmationOutcome([2, 3, 4, 5, 6, 7, 8], [2, 3, 4, 5, 6, 7, 8]), "PLAN_WITHOUT_FIRST").toBe(identity);
  expect(await confirmationOutcome([], []), "EMPTY_PLAN").toBe(identity);
  expect(await confirmationOutcome(null, eight), "MISSING_PLAN").toBe(identity);
});

test("refusal diagnostics name every partition a confirmation can plan", async () => {
  const message = await refusal({ total_count: 2, jobs: [job, { ...job, id: 20, name: "unit (8)", status: "queued" }] });
  expect(JSON.parse(message.split("inventory: ")[1]!).offending[0].job.name).toBe("unit (8)");
});
