import { expect, test } from "bun:test";
import { refreshBrowserCosts } from "../scripts/refresh-browser-costs";
import type { API } from "../scripts/proof-reuse";

const sha = "a".repeat(40), parent = "b".repeat(40), tree = "c".repeat(40);
const image = "mcr.microsoft.com/playwright:v1.63.0-noble";
const stamp = "2026-07-12T00:00:00Z ";
function fixture(domain: "browser" | "layout" = "layout") {
  const project = domain === "layout" ? "ui-react-layout" : "visual";
  const logs = [1, 2].map(shard => [
    `${stamp}[command]/usr/bin/git log -1 --format=%H`, `${stamp}${sha}`,
    `${stamp}Status: Downloaded newer image for ${image}`,
    `${stamp}Measured browser shard ${shard}/2: 1/2 specs; 0 recorded weights, 2 positive defaults`,
    `${stamp}✓ ${project} (chromium) ../ui-react/tests/browser/odysseus-${shard}.layout.tsx (1 test) ${shard * 1000}ms`,
    `${stamp}Test Files 1 passed (1)`,
  ].join("\n"));
  const run = { id: 42, run_attempt: 1, status: "completed", conclusion: "success", event: "push", path: ".github/workflows/ci.yml",
    head_sha: sha, repository: { full_name: "schlessera/brain-kit" } };
  const jobs = [1, 2].map(shard => ({ id: shard, run_id: 42, head_sha: sha, name: `${domain} (${shard})`, status: "completed", conclusion: "success",
    steps: [{ name: `Complete ${domain} proof`, status: "completed", conclusion: "success" }] }));
  const commit = { sha, tree: { sha: tree }, parents: [{ sha: parent }] };
  const source = { encoding: "base64", content: Buffer.from(`const IMAGE = "${image}";`).toString("base64") };
  const page = { total_count: 2, jobs };
  const api: API = {
    async json(path) {
      if (path === "actions/runs/42/attempts/1") return run;
      if (path === "actions/runs/42/attempts/1/jobs?per_page=100") return page;
      if (path === `git/commits/${sha}`) return commit;
      if (path === `contents/scripts/visual.mjs?ref=${sha}`) return source;
      throw Error(`Unexpected evidence request: ${path}`);
    },
    async log(job) { return logs[job - 1]!; },
  };
  const previous = { measurement: { run: 12, jobs: [3, 4] }, seconds: { "visual::packages/ui-kit/tests/visual/odysseus.visual.tsx": 5 } };
  return { run, jobs, page, logs, commit, source, previous, refresh: () => refreshBrowserCosts(domain, 42, 1, previous, image, api), api };
}

test("attributed layout refresh preserves browser costs and provenance, then browser refresh preserves layout", async () => {
  const f = fixture();
  const layout = await f.refresh();
  expect(layout.seconds).toEqual({ ...f.previous.seconds,
    "ui-react-layout::packages/ui-react/tests/browser/odysseus-1.layout.tsx": 1,
    "ui-react-layout::packages/ui-react/tests/browser/odysseus-2.layout.tsx": 2 });
  expect(layout.measurements?.browser).toEqual(f.previous.measurement);
  expect(layout.measurements?.layout).toMatchObject({ run: 42, attempt: 1, jobs: [1, 2], checkout: sha, tree, parents: [parent], image });
  const browser = fixture("browser");
  const refreshed = await refreshBrowserCosts("browser", 42, 1, layout, image, browser.api);
  expect(refreshed.seconds["ui-react-layout::packages/ui-react/tests/browser/odysseus-1.layout.tsx"]).toBe(1);
  expect(refreshed.measurements?.layout).toEqual(layout.measurements?.layout);
  expect(refreshed.seconds["visual::packages/ui-kit/tests/visual/odysseus.visual.tsx"]).toBeUndefined();
});

test("cancelled layout job cannot supply admitted measurements despite passing file logs", async () => {
  const f = fixture(); f.jobs[1]!.conclusion = "cancelled";
  await expect(f.refresh()).rejects.toThrow("successful domain jobs");
});

for (const [name, corrupt] of [
  ["wrong run", (f: ReturnType<typeof fixture>) => { f.run.id = 41; }],
  ["wrong attempt", f => { f.run.run_attempt = 2; }],
  ["failed run", f => { f.run.conclusion = "failure"; }],
  ["unfinished run", f => { f.run.status = "in_progress"; }],
  ["incomplete job page", f => { f.page.total_count = 3; }],
  ["wrong job run", f => { f.jobs[0]!.run_id = 43; }],
  ["wrong job head", f => { f.jobs[0]!.head_sha = parent; }],
  ["missing shard", f => { f.jobs[1]!.name = "browser (2)"; }],
  ["duplicate job", f => { f.jobs[1]!.id = 1; }],
  ["skipped execution", f => { f.jobs[0]!.steps[0]!.conclusion = "skipped"; }],
  ["different checkout", f => { f.logs[1] = f.logs[1]!.replace(sha, parent); }],
  ["wrong tree", f => { f.commit.tree.sha = "invalid"; }],
  ["wrong commit", f => { f.commit.sha = parent; }],
  ["wrong source image", f => { f.source.content = Buffer.from('const IMAGE = "other";').toString("base64"); }],
  ["wrong logged image", f => { f.logs[1] = f.logs[1]!.replace(image, "other"); }],
  ["missing summary", f => { f.logs[1] = f.logs[1]!.replace("Test Files 1 passed (1)", "unfinished"); }],
  ["missing timing", f => { f.logs[1] = f.logs[1]!.replace("✓", "x"); }],
  ["wrong domain", f => { f.logs[1] = f.logs[1]!.replace("✓ ui-react-layout", "✓ visual"); }],
  ["duplicate spec", f => { f.logs[1] = f.logs[1]!.replace("odysseus-2", "odysseus-1"); }],
  ["wrong shard", f => { f.logs[1] = f.logs[1]!.replace("shard 2/2", "shard 1/2"); }],
  ["incomplete inventory", f => { f.logs[1] = f.logs[1]!.replace("1/2 specs", "1/3 specs"); }],
] satisfies [string, (f: ReturnType<typeof fixture>) => void][]) test(`refresh refuses ${name} attribution`, async () => {
  const f = fixture(); corrupt(f);
  await expect(f.refresh()).rejects.toThrow();
});

test("PR measurements must bind the immutable merge parent to the run head", async () => {
  const f = fixture(); f.run.event = "pull_request";
  await expect(f.refresh()).rejects.toThrow("parent attribution");
  f.commit.parents.push({ sha });
  expect((await f.refresh()).seconds["ui-react-layout::packages/ui-react/tests/browser/odysseus-1.layout.tsx"]).toBe(1);
});

test("separate endurance proof never becomes a browser timing weight", async () => {
  const f = fixture("browser");
  f.logs[0] = f.logs[0]!.replace("✓ visual", "✓ ui-react-endurance");
  await expect(f.refresh()).rejects.toThrow("Wrong domain");
});
