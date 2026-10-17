import { expect, test } from "bun:test";
import { assertWeightedLongFiles, refreshUnitCosts, type UnitEvidenceAPI } from "../scripts/refresh-unit-costs";
const sha = "a".repeat(40), tree = "b".repeat(40), parent = "c".repeat(40), digest = `sha256:${"d".repeat(64)}`;
function fixture() {
  const run = { id: 42, run_attempt: 1, status: "completed", conclusion: "success", path: ".github/workflows/ci.yml", event: "push", head_sha: sha, repository: { full_name: "schlessera/brain-kit" } };
  const jobs = [1, 2, 3, 4].map(id => ({ id, run_id: 42, head_sha: sha, name: `unit (${id})`, started_at: "2026-07-12T00:00:00Z", completed_at: "2026-07-12T00:03:00Z", status: "completed", conclusion: "success", steps: [{ name: "Complete unit proof", status: "completed", conclusion: "success", started_at: "2026-07-12T00:00:00Z", completed_at: "2026-07-12T00:02:00Z" }] }));
  const artifacts = jobs.map(j => ({ id: j.id, name: `unit-proof-${j.id}`, expired: false, created_at: "2026-07-12T00:02:01Z", digest, workflow_run: { id: 42, head_sha: sha } }));
  const files = jobs.map(j => `tests/odysseus-${j.id}.test.ts`);
  const archives = jobs.map((j, i) => ({ digest, files: {
    "proof-checkout.json": JSON.stringify({ category: "unit", shard: `${j.id}/4`, checkout: { sha, tree, parents: [parent] }, plan: { global: true, local: { fullTests: true } }, files: [files[i]] }),
    "unit-timings.json": JSON.stringify({ version: 1, files: { [files[i]!]: j.id * 1000 } }),
    "unit-report.xml": `<testsuites failures="0"><testsuite file="${files[i]}" failures="0"></testsuite></testsuites>`,
  } }));
  const logs = jobs.map(() => `2026-07-12T00:00:00Z [command]/usr/bin/git log -1 --format=%H\n2026-07-12T00:00:00Z ${sha}\n`);
  const commit = { sha, tree: { sha: tree }, parents: [{ sha: parent }] };
  const source = { sha: tree, truncated: false, tree: files.map(path => ({ path, type: "blob" })) };
  const api: UnitEvidenceAPI = { json: async path => {
    if (path === "actions/runs/42/attempts/1") return run;
    if (path === "actions/runs/42/attempts/1/jobs?per_page=100") return { jobs, total_count: jobs.length };
    if (path === "actions/runs/42/artifacts?per_page=100") return { artifacts, total_count: artifacts.length };
    if (path === `git/commits/${sha}`) return commit;
    if (path === `git/trees/${tree}?recursive=1`) return source;
    throw Error(`Unexpected request ${path}`);
  }, log: async id => logs[id - 1]!, archive: async id => archives[id - 1]! };
  return { run, jobs, artifacts, files, archives, logs, commit, source, refresh: () => refreshUnitCosts(42, 1, api) };
}
test("complete immutable hosted observations refresh every measured file with explicit provenance", async () => {
  const f = fixture(), result = await f.refresh();
  expect(result.seconds).toEqual(Object.fromEntries(f.files.map((file, i) => [file, i + 1])));
  expect(result.measurement).toMatchObject({ run: 42, attempt: 1, head: sha, sha, tree, parents: [parent] });
  expect(result.measurement.jobs.map(j => j.elapsedSeconds)).toEqual([120, 120, 120, 120]);
});
for (const [name, corrupt] of [
  ["failed run", (f: ReturnType<typeof fixture>) => { f.run.conclusion = "failure"; }],
  ["cancelled run", f => { f.run.conclusion = "cancelled"; }],
  ["artifact from another attempt", f => { f.artifacts[0]!.created_at = "2026-07-11T00:00:00Z"; }],
  ["duplicate job identity", f => { f.jobs[1]!.id = 1; }],
  ["wrong attempt", f => { f.run.run_attempt = 2; }],
  ["failed job", f => { f.jobs[0]!.conclusion = "failure"; }],
  ["cancelled job", f => { f.jobs[0]!.conclusion = "cancelled"; }],
  ["missing shard", f => { f.jobs.pop(); }],
  ["wrong job head", f => { f.jobs[0]!.head_sha = parent; }],
  ["skipped execution", f => { f.jobs[0]!.steps[0]!.conclusion = "skipped"; }],
  ["wrong artifact run", f => { f.artifacts[0]!.workflow_run.id = 43; }],
  ["expired artifact", f => { f.artifacts[0]!.expired = true; }],
  ["archive digest mismatch", f => { f.archives[0]!.digest = `sha256:${"e".repeat(64)}`; }],
  ["wrong actual checkout", f => { f.logs[0] = f.logs[0]!.replace(sha, parent); }],
  ["missing file observation", f => { f.archives[0]!.files["unit-timings.json"] = '{"version":1,"files":{}}'; }],
  ["failed file", f => { f.archives[0]!.files["unit-report.xml"] = f.archives[0]!.files["unit-report.xml"].replace('failures="0"', 'failures="1"'); }],
  ["unfinished XML", f => { f.archives[0]!.files["unit-report.xml"] = f.archives[0]!.files["unit-report.xml"].replace("</testsuites>", ""); }],
  ["wrong immutable tree", f => { f.commit.tree.sha = parent; }],
  ["wrong immutable parent", f => { f.commit.parents[0]!.sha = sha; }],
  ["incomplete source discovery", f => { f.source.tree.push({ path: "tests/odysseus-extra.test.ts", type: "blob" }); }],
  ["truncated source tree", f => { f.source.truncated = true; }],
] satisfies [string, (f: ReturnType<typeof fixture>) => void][]) test(`unit refresh rejects ${name}`, async () => {
  const f = fixture(); corrupt(f); await expect(f.refresh()).rejects.toThrow();
});
test("missing-weight guard names the unweighted 120 second file and passes after weighting", () => {
  const file = "tests/odysseus-long.test.ts", observations = { [file]: 120000 };
  expect(() => assertWeightedLongFiles(observations, {})).toThrow(`Missing unit weight above 30s: ${file}`);
  expect(() => assertWeightedLongFiles(observations, { [file]: 120 })).not.toThrow();
});
