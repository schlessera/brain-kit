import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MAX_FILE_BYTES, publishBatch, readArchive, compactArtifacts, GitArchiveStore, MonthFile, parseMonthFile, type ArchiveAPI } from "../scripts/ci-archive";
import { archiveInputs } from "../scripts/ci-timings";
import { evidenceReport } from "../scripts/ci-evidence-report";
import { archiveWorkflowProblems } from "../scripts/check-ci-workflows";

const repository = "odysseus/chronicle", ref = "refs/heads/brain-ci-metrics";
const sha = "a".repeat(40), merge = "d".repeat(40), tree = "c".repeat(40);
const at = (minute: number) => new Date(Date.parse("2026-07-12T10:00:00Z") + minute * 60000).toISOString();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(root: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode, new TextDecoder().decode(p.stderr)).toBe(0);
  return new TextDecoder().decode(p.stdout).trim();
}

function run(id: number, event: "pull_request" | "push", start: number, collected: number) {
  return { version: 1, repository, collectedAt: at(collected), run: { id, attempt: 1, workflow: "CI", path: ".github/workflows/ci.yml", event,
    head: event === "push" ? merge : sha, prs: [42], attribution: "run payload", createdAt: at(start), startedAt: at(start), status: "completed", conclusion: "success" },
    jobs: [{ id: id * 10, name: "proof", category: "proof", conclusion: "success", labels: [], execution: "observed",
      startedAt: at(start), completedAt: at(start + 4), seconds: 240, steps: [], resource: null, resourceProblem: null }], problems: [] };
}
const pull = (collected: number, extra: object = {}) => ({ version: 1, repository, number: 42, collectedAt: at(collected), createdAt: at(-60),
  mergedAt: at(10), closedAt: at(10), head: sha, merge, baseBranch: "main", changedFiles: 2, additions: 5, deletions: 5,
  timeline: [{ event: "ready_for_review", at: at(3) }], problems: [], mergeObject: { sha: merge, tree, parents: [sha] }, ...extra });
const lease = (n: number, acquired: number) => ({ id: String(n).repeat(32).slice(0, 32), pr: 42, head: sha, base: merge, acquired: Date.parse(at(acquired)),
  expires: Date.parse(at(acquired + 20)), cap: Date.parse(at(acquired + 60)), endedAt: null, ending: "expiry-inferred", sources: [sha] });
const collection = (id: string, collected: number, expected: { run: number; attempts: number }[]) => ({ version: 1, id, repository,
  collectedAt: at(collected), status: "completed", since: at(-120), until: at(collected), requestedRun: null, expected, resourcesRequested: false, errors: [],
  requestBudget: { limit: 200, reserve: 500, requests: 4, remaining: 900, stopped: null }, seed: null });
const reservations = (collected: number, leases: object[]) => ({ version: 1, repository, collectedAt: at(collected),
  sourceRef: "refs/heads/brain-integration-reservation", sourceHead: sha, leases });
const work = (id: string, minute: number) => ({ version: 1, id, repository, kind: "work-started", at: at(minute), worker: "worker-1", task: "ithaca-42" });

/** One hourly artifact as the collector uploads it: flat records plus the per-collection manifest copy. */
function hour(collected: number, extra: Record<string, object> = {}): Record<string, object> {
  const manifest = collection(`collection-${collected}`, collected, [{ run: 1, attempts: 1 }, { run: 2, attempts: 1 }]);
  return { "run-1-attempt-1.json": run(1, "pull_request", 4, collected), "run-2-attempt-1.json": run(2, "push", 11, collected),
    "pull-42.json": pull(collected), "collection.json": manifest, [`collections/${manifest.id}/collection.json`]: manifest,
    "reservations.json": reservations(collected, [lease(1, 5), ...(collected > 60 ? [lease(2, 50)] : [])]),
    "enrichment.json": { version: 1, repository, collectedAt: at(collected), expectedPRs: [42], errors: [] },
    "summary.json": { version: 2, note: "derived, never archived" }, ...extra };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-archive-")); dirs.push(root);
  const remote = join(root, "remote.git"); git(root, "init", "-q", "--bare", remote);
  const clone = (name: string) => { const dir = join(root, name); mkdirSync(dir); git(dir, "init", "-q"); git(dir, "remote", "add", "origin", remote); return dir; };
  const artifacts: { artifact: number; run: number; created: string; zip: string; trusted: boolean }[] = [];
  const add = (artifact: number, created: string, files: Record<string, object>, trusted = true) => {
    const source = join(root, `artifact-${artifact}`);
    for (const [name, value] of Object.entries(files)) { mkdirSync(dirname(join(source, name)), { recursive: true }); writeFileSync(join(source, name), JSON.stringify(value, null, 2)); }
    const zip = join(root, `${artifact}.zip`);
    const child = Bun.spawnSync([Bun.which("zip")!, "-q", "-r", zip, "."], { cwd: source, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    artifacts.push({ artifact, run: artifact + 1000, created, zip, trusted });
  };
  const config = join(root, "api.json");
  const api = (): ArchiveAPI & { calls: string[] } => {
    writeFileSync(config, JSON.stringify(artifacts));
    return fakeAPI(artifacts);
  };
  return { root, remote, clone, add, api, config };
}

function fakeAPI(artifacts: { artifact: number; run: number; created: string; zip: string; trusted: boolean }[]): ArchiveAPI & { calls: string[] } {
  const calls: string[] = [];
  return { calls,
    async json(path: string) {
      calls.push(path);
      if (path.startsWith("actions/workflows/ci-timings.yml/runs?")) return { workflow_runs: artifacts.map(a => ({ id: a.run, path: ".github/workflows/ci-timings.yml",
        head_branch: "main", event: a.trusted ? "schedule" : "pull_request", head_repository: { full_name: repository } })) };
      if (path.startsWith("actions/artifacts?")) return { artifacts: [...artifacts].reverse().map(a => ({ id: a.artifact, name: "ci-timings", expired: false, created_at: a.created, workflow_run: { id: a.run } })) };
      throw new Error(`unexpected ${path}`);
    },
    async bytes(path: string) {
      calls.push(path);
      const artifact = artifacts.find(a => path === `actions/artifacts/${a.artifact}/zip`);
      if (!artifact) throw new Error(`unexpected ${path}`);
      return readFileSync(artifact.zip);
    } };
}
const month = (remote: string, path: string) => parseMonthFile(path, git(remote, "show", `${ref}:${path}`) + "\n", repository).rows;

test("backfilling the same artifacts twice adds no commit and downloads nothing the second time", async () => {
  const f = setup(), one = f.clone("one");
  f.add(1, at(60), hour(60)); f.add(2, at(120), hour(120)); f.add(3, at(90), hour(90), false);
  const api = f.api(), store = new GitArchiveStore(one);
  const first = await compactArtifacts({ store, api, repository, branch: "main" });
  expect(first, "FIRST_BACKFILL_COMMITS").toMatchObject({ commits: 1, sources: 2, pending: 0, refused: [] });
  expect(api.calls.filter(p => p.endsWith("/zip")), "UNTRUSTED_ARTIFACT_NOT_DOWNLOADED").toEqual(["actions/artifacts/1/zip", "actions/artifacts/2/zip"]);
  expect(git(f.remote, "ls-tree", "-r", "--name-only", ref).split("\n")).toEqual(["2026-07/collection.json", "2026-07/enrichment.json",
    "2026-07/pull.json", "2026-07/reservations.json", "2026-07/run/12.json", "2026-07/source.json"]);
  const head = git(f.remote, "rev-parse", ref);
  const again = f.api(), second = await compactArtifacts({ store, api: again, repository, branch: "main" });
  expect(second, "SECOND_BACKFILL_IDEMPOTENT").toMatchObject({ commits: 0, sources: 0, pending: 0, head });
  expect(again.calls.filter(p => p.endsWith("/zip"))).toEqual([]);
  expect(git(f.remote, "rev-parse", ref)).toBe(head);
  expect(git(f.remote, "rev-list", "--count", ref)).toBe("1");
});

test("compaction keeps the newest observation per identity and stores a repeated window entry once", async () => {
  const f = setup(), one = f.clone("one");
  f.add(1, at(60), hour(60, { "event-w1.json": work("w1", 2) }));
  f.add(2, at(120), hour(120, { "pull-42.json": pull(120, { changedFiles: 3 }) }));
  f.add(3, "2026-08-01T00:30:00Z", { "run-9-attempt-1.json": { ...run(9, "push", 0, 0), run: { ...run(9, "push", 0, 0).run, createdAt: "2026-08-01T00:10:00Z" } } });
  await compactArtifacts({ store: new GitArchiveStore(one), api: f.api(), repository, branch: "main" });
  expect(month(f.remote, "2026-07/run/12.json").map(r => [r.run.id, r.collectedAt])).toEqual([[1, at(120)], [2, at(120)]]);
  expect(month(f.remote, "2026-08/run/01.json").map(r => r.run.id), "MONTH_PARTITION").toEqual([9]);
  expect(month(f.remote, "2026-07/pull.json").map(r => r.changedFiles)).toEqual([3]);
  expect(month(f.remote, "2026-07/event.json").map(r => r.id)).toEqual(["w1"]);
  const manifests = month(f.remote, "2026-07/collection.json");
  expect(manifests.map(c => [c.id, c.expected.length]), "REPEATED_EXPECTED_STORED_ONCE").toEqual([["collection-60", 2], ["collection-120", 0]]);
  const archives = month(f.remote, "2026-07/reservations.json");
  expect(archives.map(a => a.leases.map((l: { id: string }) => l.id[0])), "REPEATED_LEASE_STORED_ONCE").toEqual([["1"], ["2"]]);
  expect(month(f.remote, "2026-07/source.json").map(s => [s.artifact, s.records, s.refused])).toEqual([[1, 8, 0], [2, 7, 0]]);
});

test("a record that fails the leakage screen or carries an unknown version is refused before commit", async () => {
  const f = setup(), one = f.clone("one");
  const personal = "al" + "ain";
  f.add(1, at(60), hour(60, { "pull-43.json": { ...pull(60), number: 43, baseBranch: `feat/${personal}-notes` },
    "run-7-attempt-1.json": { ...run(7, "push", 30, 60), version: 9 } }));
  const result = await compactArtifacts({ store: new GitArchiveStore(one), api: f.api(), repository, branch: "main" });
  expect(result.refused.map(r => [r.kind, r.key, r.reason]).sort(), "PERSONAL_RECORD_REFUSED").toEqual([
    ["pull", "1:pull-43.json", "refused by leakage screen"], ["run", "1:run-7-attempt-1.json", "unknown run version 9"]]);
  expect(result.commits).toBe(1);
  const published = git(f.remote, "log", "-p", ref);
  expect(published.toLowerCase(), "NOTHING_PERSONAL_PUBLISHED").not.toContain(personal);
  expect(month(f.remote, "2026-07/pull.json").map(p => p.number)).toEqual([42]);
  expect(month(f.remote, "2026-07/run/12.json").map(r => r.run.id)).toEqual([1, 2]);
  expect(month(f.remote, "2026-07/source.json")[0]).toMatchObject({ artifact: 1, refused: 2 });
});

test("compaction preserves published events and unrelated paths, and a commit is parented by the inspected head", async () => {
  const f = setup(), one = f.clone("one");
  git(one, "config", "user.name", "Odysseus"); git(one, "config", "user.email", "odysseus@example.invalid");
  mkdirSync(join(one, "events")); writeFileSync(join(one, "events", "w9.json"), JSON.stringify(work("w9", 7)) + "\n");
  git(one, "add", "events/w9.json"); git(one, "commit", "-q", "-m", "events"); git(one, "push", "-q", "origin", `HEAD:${ref}`);
  const parent = git(one, "rev-parse", "HEAD"), index = git(one, "ls-files", "--stage");
  f.add(1, at(60), hour(60));
  const result = await compactArtifacts({ store: new GitArchiveStore(one), api: f.api(), repository, branch: "main" });
  expect(git(f.remote, "rev-parse", `${result.head}^`)).toBe(parent);
  expect(JSON.parse(git(f.remote, "show", `${ref}:events/w9.json`)).id).toBe("w9");
  expect(month(f.remote, "2026-07/event.json").map(e => e.id)).toEqual(["w9"]);
  expect(git(one, "ls-files", "--stage")).toBe(index);
  expect(git(one, "rev-parse", "HEAD")).toBe(parent);
});

test.each([{ shared: false, commits: 2 }, { shared: true, commits: 1 }])("two concurrent writers cannot both commit on one inspected head: %j", async ({ shared, commits }) => {
  const f = setup();
  f.add(1, at(60), hour(60)); f.add(2, at(120), hour(120));
  const config = (only: number[]) => JSON.stringify(JSON.parse((f.api(), readFileSync(f.config, "utf8"))).filter((a: { artifact: number }) => only.includes(a.artifact)));
  const script = join(f.root, "contender.ts"), source = resolve(import.meta.dir, "../scripts/ci-archive.ts");
  // Both writers inspect the same missing ref and wait for each other. Writer 2
  // then pushes only after writer 1's push has landed, so its stale lease, not
  // a ref-lock collision, is what must stop it.
  writeFileSync(script, `import {existsSync,readFileSync,writeFileSync} from "node:fs";
    import {compactArtifacts, GitArchiveStore} from ${JSON.stringify(source)};
    const [root,config,id,barrier]=process.argv.slice(2), artifacts=JSON.parse(readFileSync(config,"utf8"));
    const api={async json(p){ if(p.startsWith("actions/workflows/")) return {workflow_runs:artifacts.map(a=>({id:a.run,path:".github/workflows/ci-timings.yml",head_branch:"main",event:"schedule",head_repository:{full_name:${JSON.stringify(repository)}}}))};
      return {artifacts:artifacts.map(a=>({id:a.artifact,name:"ci-timings",expired:false,created_at:a.created,workflow_run:{id:a.run}}))}; },
      async bytes(p){ return readFileSync(artifacts.find(a=>p.includes("/"+a.artifact+"/")).zip); }};
    const store=new GitArchiveStore(root), commit=store.commit.bind(store); let first=true, lost=0;
    store.commit=async(...args)=>{ if(first){first=false;writeFileSync(barrier+id,"ready");
      const deadline=Date.now()+15000;while(!existsSync(barrier+"1")||!existsSync(barrier+"2")){if(Date.now()>deadline)throw Error("barrier timeout");await Bun.sleep(5);}
      while(id==="2"&&!existsSync(barrier+"pushed")){if(Date.now()>deadline)throw Error("push barrier timeout");await Bun.sleep(5);}
      const head=await commit(...args); if(id==="1")writeFileSync(barrier+"pushed","done"); if(!head) lost++; return head;}
      const head=await commit(...args); if(!head) lost++; return head; };
    const result=await compactArtifacts({store,api,repository:${JSON.stringify(repository)},branch:"main"});
    console.log(JSON.stringify({...result,lost}));`);
  // Overlapping inputs: the second writer finds its artifact already archived when it re-reads.
  const inputs = shared ? [[1, 2], [2]] : [[1], [2]];
  const children = inputs.map((only, i) => {
    const file = join(f.root, `config-${i + 1}.json`); writeFileSync(file, config(only));
    return Bun.spawn([process.execPath, script, f.clone(`writer-${i + 1}`), file, String(i + 1), join(f.root, "barrier-")], { stdout: "pipe", stderr: "pipe" });
  });
  const results = await Promise.all(children.map(async child => {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, err).toBe(0); return JSON.parse(out);
  }));
  expect(results.map(r => r.lost), "SECOND_PUSH_REFUSED_BY_LEASE").toEqual([0, 1]);
  expect(results.reduce((n, r) => n + r.commits, 0), "NO_LOST_OR_DUPLICATE_COMMIT").toBe(commits);
  expect(git(f.remote, "rev-list", "--count", ref)).toBe(String(commits));
  expect(month(f.remote, "2026-07/source.json").map(s => s.artifact)).toEqual([1, 2]);
});

test("a report from the archive matches the report from the artifacts it holds, and readers refuse unknown versions", async () => {
  const f = setup(), one = f.clone("one");
  const hours = { 1: hour(60, { "event-w1.json": work("w1", 2) }), 2: hour(120, { "pull-42.json": pull(120, { changedFiles: 3 }) }) };
  const raw = join(f.root, "raw");
  for (const [artifact, files] of Object.entries(hours)) {
    f.add(Number(artifact), at(Number(artifact) * 60), files);
    for (const [name, value] of Object.entries(files)) { const path = join(raw, artifact, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }
  }
  await compactArtifacts({ store: new GitArchiveStore(one), api: f.api(), repository, branch: "main" });
  const script = resolve(import.meta.dir, "../scripts/ci-timings.ts");
  const report = (out: string, ...args: string[]) => {
    const child = Bun.spawnSync([process.execPath, script, "report", "--repo", repository, "--since", at(0), "--until", at(60), "--out", out, ...args], { cwd: one, stdout: "pipe", stderr: "pipe" });
    return { code: child.exitCode, err: new TextDecoder().decode(child.stderr) };
  };
  expect(report(raw).code).toBe(0);
  const archived = join(f.root, "from-archive");
  expect(report(archived, "--from-archive", "origin")).toEqual({ code: 0, err: "" });
  // Directory listing order is not the report's to fix; compare acquisition scopes by time.
  const summary = (dir: string) => {
    const value = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    value.collectionCoverage.scopes.sort((a: { collectedAt: string }, b: { collectedAt: string }) => a.collectedAt.localeCompare(b.collectedAt));
    return value;
  };
  expect(summary(archived).throughput.velocity.firstPassGreen.denominator, "COHORT_PRESENT").toBe(1);
  expect(summary(archived), "ARCHIVE_REPORT_EQUALS_ARTIFACT_REPORT").toEqual(summary(raw));

  const bad = new MonthFile("pull"); bad.add({ ...pull(200), version: 3 });
  const store = new GitArchiveStore(one), parent = await store.read();
  await store.commit(parent, new Map([["2026-07/pull.json", bad.serialize()]]), "unknown version");
  const refused = report(join(f.root, "refused"), "--from-archive", "origin");
  expect(refused.code, "UNKNOWN_VERSION_REFUSED").toBe(1);
  expect(refused.err).toContain("Unknown pull version 3");
});

test("an explicit directory backfill is idempotent and the CLI names a refused record with a nonzero exit", () => {
  const f = setup(), one = f.clone("one"), dir = join(f.root, "baseline");
  for (const [name, value] of Object.entries(hour(60))) { mkdirSync(dirname(join(dir, "hourly", name)), { recursive: true }); writeFileSync(join(dir, "hourly", name), JSON.stringify(value)); }
  const script = resolve(import.meta.dir, "../scripts/ci-timings.ts");
  const archive = () => {
    const child = Bun.spawnSync([process.execPath, script, "archive", "--repo", repository, "--dir", dir], { cwd: one, stdout: "pipe", stderr: "pipe" });
    return { code: child.exitCode, result: JSON.parse(new TextDecoder().decode(child.stdout) || "null"), err: new TextDecoder().decode(child.stderr) };
  };
  const first = archive();
  expect(first.code, first.err).toBe(0);
  expect(first.result).toMatchObject({ commits: 1, refused: [] });
  const head = git(f.remote, "rev-parse", ref);
  expect(archive().result, "DIRECTORY_REPLAY_IDEMPOTENT").toMatchObject({ commits: 0, head });
  expect(git(f.remote, "rev-list", "--count", ref)).toBe("1");
  writeFileSync(join(dir, "pull-44.json"), JSON.stringify({ ...pull(90), number: 44, repository: "ithaca/other" }));
  const refused = archive();
  expect(refused.code, "REFUSAL_EXITS_NONZERO").toBe(1);
  expect(refused.result.refused).toEqual([{ kind: "pull", key: "pull-44.json", reason: "repository differs" }]);
  expect(git(f.remote, "rev-parse", ref)).toBe(head);
});

test("only the archive job holds write authority, and only for contents", () => {
  const workflow = readFileSync(resolve(import.meta.dir, "../.github/workflows/ci-evidence-archive.yml"), "utf8");
  expect(archiveWorkflowProblems(workflow)).toEqual([]);
  const problem = (text: string) => archiveWorkflowProblems(text);
  expect(problem(workflow.replace("permissions: {}", "permissions:\n  contents: write")), "WORKFLOW_SCOPE_WRITE_REFUSED")
    .toContain("ci-evidence-archive.yml: workflow token must grant nothing; write authority belongs to the archive job alone");
  expect(problem(workflow.replace("actions: read    #", "actions: write    #")), "JOB_SCOPE_NARROW")
    .toContain("ci-evidence-archive.yml: archive job may only write contents (the data ref) and read actions");
  expect(problem(workflow.replace("actions: read    #", "actions: read\n      issues: write    #")))
    .toContain("ci-evidence-archive.yml: archive job may only write contents (the data ref) and read actions");
  expect(problem(workflow.replace("  schedule:", "  pull_request:\n  schedule:")))
    .toContain("ci-evidence-archive.yml: archive must use scheduled/manual trusted execution only");
  expect(problem(workflow.replace("ref: ${{ github.event.repository.default_branch }}", "ref: ${{ github.sha }}")))
    .toContain("ci-evidence-archive.yml: archive must check out trusted default-branch code");
  expect(problem(workflow.replace("--reserve 500", "--reserve 0")))
    .toContain("ci-evidence-archive.yml: archive requires the default branch's artifacts, a hard budget and the shared quota reserve");
  expect(problem(workflow.replace('"17 2 * * *"', '"17 * * * *"'))).toContain("ci-evidence-archive.yml: archive compaction must run once a day");
  expect(problem(workflow.replace("mkdir -p tmp", "bun install --frozen-lockfile\n          mkdir -p tmp")))
    .toContain("ci-evidence-archive.yml: archive scripts must not interpolate events or install dependencies");
});

test("daily placement uses run creation UTC date across boundaries and late arrivals", async () => {
  const f = setup(), store = new GitArchiveStore(f.clone("one"));
  const dates = ["2026-07-12T23:59:59Z", "2026-07-13T00:00:00Z", "2026-08-01T00:30:00+01:00", "2026-08-01T00:00:00Z"];
  const records = dates.map((createdAt, i) => {
    const row = run(i + 10, "push", 0, 200);
    row.run.createdAt = createdAt;
    return { kind: "run" as const, row };
  });
  const batch = { records, refused: [], sources: [] };
  const first = await publishBatch(store, repository, batch);
  expect(first.files, "UTC_DAY_PARTITIONS").toEqual(["2026-07/run/12.json", "2026-07/run/13.json", "2026-07/run/31.json", "2026-08/run/01.json"]);
  expect((await publishBatch(store, repository, { ...batch, records: [...records].reverse() })).committed).toBe(false);
  expect(() => parseMonthFile("2026-07/run/13.json", JSON.stringify([records[0]!.row]), repository)).toThrow("outside its day partition");
});

test("mixed layouts preserve legacy blobs and both reports count attempts once", async () => {
  const f = setup(), one = f.clone("one"), store = new GitArchiveStore(one);
  const legacy = new MonthFile("run"); legacy.add(run(1, "push", 4, 120)); legacy.add(run(2, "push", 5, 60));
  const text = legacy.serialize();
  await store.commit(null, new Map([["2026-07/run.json", text]]), "legacy runs");
  await publishBatch(store, repository, { records: [{ kind: "run", row: run(1, "push", 4, 60) }], refused: [], sources: [] });
  expect(git(f.remote, "show", `${ref}:2026-07/run.json`) + "\n", "LEGACY_UNCHANGED").toBe(text);
  const loaded = await readArchive(store, repository);
  expect(loaded.rows.run.map(r => [r.run.id, r.collectedAt]), "MIXED_LAYOUT_JOIN").toEqual([[1, at(120)], [2, at(60)]]);
  const inputs = await archiveInputs("origin", repository, undefined, undefined, one);
  expect(inputs.snapshots).toEqual(loaded.rows.run);
  const options = { cadence: "daily" as const, until: "2026-07-13T00:00:00Z", now: "2026-07-13T00:00:00Z" };
  const mixed = evidenceReport(inputs, options);
  const single = evidenceReport({ ...inputs, snapshots: [run(1, "push", 4, 120), run(2, "push", 5, 60)] }, options);
  expect(mixed).toEqual(single);
  expect(mixed.activity.find(d => d.day === "2026-07-12")?.observedRunAttempts).toBe(2);
  const again = await publishBatch(store, repository, { records: [{ kind: "run", row: run(1, "push", 4, 60) }], refused: [], sources: [] });
  expect(again.committed).toBe(false);
});

test("daily output allows exactly 95 MiB and refuses one byte over before committing any file", async () => {
  let commits = 0;
  const store = { read: async () => null, files: async () => new Map(), commit: async () => { commits++; return sha; } } as unknown as GitArchiveStore;
  const row = { ...run(1, "push", 0, 60), padding: "" };
  const file = new MonthFile("run"); file.add(row);
  row.padding = "x".repeat(MAX_FILE_BYTES - Buffer.byteLength(file.serialize()));
  const batch = { records: [{ kind: "run" as const, row }, { kind: "pull" as const, row: pull(60) }], refused: [], sources: [] };
  expect((await publishBatch(store, repository, batch)).committed, "AT_CAP_ALLOWED").toBe(true);
  row.padding += "x";
  await expect(publishBatch(store, repository, batch)).rejects.toThrow("2026-07/run/12.json would exceed");
  expect(commits, "OVER_CAP_NO_PUBLICATION").toBe(1);
});

test("mixed layout joins are order independent and conflicting identities refuse", async () => {
  const f = setup(), store = new GitArchiveStore(f.clone("one"));
  const older = run(1, "push", 0, 60), newer = run(1, "push", 0, 120);
  const monthly = new MonthFile("run"), daily = new MonthFile("run"); monthly.add(older); daily.add(newer);
  await store.commit(null, new Map([["2026-07/run.json", monthly.serialize()], ["2026-07/run/12.json", daily.serialize()]]), "mixed layouts");
  const forward = await readArchive(store, repository);
  const files = store.files.bind(store);
  store.files = async oid => new Map([...(await files(oid))].reverse());
  expect((await readArchive(store, repository)).rows, "READER_ORDER_INDEPENDENT").toEqual(forward.rows);
  const bad = { ...older, run: { ...older.run, head: "b".repeat(40) } };
  const refused = await publishBatch(store, repository, { records: [{ kind: "run", row: bad }], sources: [], refused: [] });
  expect(refused.refused, "LEGACY_CONFLICT_REFUSED").toEqual([{ kind: "run", key: "1/1", reason: "Conflicting archive identity" }]);
  expect(refused.committed).toBe(false);
  const head = await store.read();
  await store.commit(head, new Map([["2026-07/run/12.json", JSON.stringify([bad])]]), "conflicting identity");
  await expect(readArchive(store, repository)).rejects.toThrow("Conflicting archive identity");
  expect(() => parseMonthFile("2026-07/run/12.json", JSON.stringify([{ ...older, version: 9 }]), repository)).toThrow("Unknown run version 9");
});
