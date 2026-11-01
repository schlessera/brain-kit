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
