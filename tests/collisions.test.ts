import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { collisions, parseArgs, type OpenPr } from "../scripts/collisions";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A bare `origin` holds every PR head only under refs/pull/<n>/head, as GitHub
 * does; the clone under test starts with `main` alone, so the command must
 * fetch objects without writing a ref.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "collisions-")); scratch.push(dir);
  const seed = join(dir, "seed"), origin = join(dir, "origin.git"), root = join(dir, "clone");
  mkdirSync(seed);
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(seed, file)), { recursive: true }); writeFileSync(join(seed, file), text);
  };
  run(seed, "init", "-q", "-b", "main");
  write("packages/ithaca/package.json", JSON.stringify({ name: "@schlessera/brain-ithaca", files: ["src"] }));
  write("packages/ithaca/src/oars.ts", "export const oars = 12;\n");
  write("packages/ithaca/src/sails.ts", "export const sails = 1;\n");
  write("packages/ithaca/tests/ship.test.ts",
    'import { test } from "bun:test";\nimport { oars } from "../src/oars";\nimport { sails } from "../src/sails";\ntest("ship", () => { void oars; void sails; });\n');
  write("docs/voyage.md", "# Voyage\n");
  run(seed, "add", "-A"); run(seed, "commit", "-qm", "main");
  const base = run(seed, "rev-parse", "HEAD");
  const branch = (number: number, files: Record<string, string>): OpenPr => {
    run(seed, "switch", "-q", "-c", `pr-${number}`, base);
    for (const [file, text] of Object.entries(files)) write(file, text);
    run(seed, "add", "-A"); run(seed, "commit", "-qm", `pr ${number}`);
    return { number, head: run(seed, "rev-parse", "HEAD"), base, baseRef: "main", draft: number % 2 === 0 };
  };
  const prs = {
    rowers: branch(101, { "packages/ithaca/src/oars.ts": "export const oars = 24;\n" }),
    suitors: branch(102, { "packages/ithaca/src/oars.ts": "export const oars = 108;\n" }),
    chart: branch(103, { "docs/sea-chart.md": "# Sea chart\n" }),
    sails: branch(104, { "packages/ithaca/src/sails.ts": "export const sails = 2;\n" }),
  };
  run(dir, "init", "-q", "--bare", "-b", "main", origin);
  run(seed, "push", "-q", origin, "main:refs/heads/main",
    ...Object.values(prs).map(pr => `${pr.head}:refs/pull/${pr.number}/head`));
  // --no-local: a local clone would copy every object, hiding the fetch path.
  run(dir, "clone", "-q", "--no-local", origin, root);
  return { root, prs, seed, origin };
}

/** Everything the command must not touch: refs, HEAD, the index, the working tree and FETCH_HEAD. */
function state(root: string) {
  const gitDir = join(root, ".git");
  const hash = (path: string) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
  return {
    refs: run(root, "for-each-ref", "--format=%(refname) %(objectname)"),
    head: readFileSync(join(gitDir, "HEAD"), "utf8"),
    packedRefs: hash(join(gitDir, "packed-refs")),
    index: hash(join(gitDir, "index")),
    fetchHead: hash(join(gitDir, "FETCH_HEAD")),
    tree: run(root, "ls-files", "-s", "-o", "--exclude-standard"),
    status: run(root, "status", "--porcelain=v2", "--untracked-files=all"),
  };
}

const list = (...prs: OpenPr[]) => () => prs;
const pair = (c: { prs: { number: number }[] }) => c.prs.map(pr => pr.number);

test("reports exactly the one textual pair, nothing for the disjoint branch, and writes nothing", async () => {
  const { root, prs } = fixture();
  expect(existsSync(join(root, ".git", "FETCH_HEAD"))).toBe(false);
  expect(spawnSync("git", ["cat-file", "-e", `${prs.rowers.head}^{commit}`], { cwd: root }).status, "HEAD_FETCHED_BY_COMMAND").not.toBe(0);
  const before = state(root);
  const report = await collisions({ root, listPrs: list(prs.rowers, prs.suitors, prs.chart), fetch: true });
  expect(state(root), "COLLISIONS_READ_ONLY").toEqual(before);
  expect(report.graph.status).toBe("built");
  expect(report.collisions.map(c => ({ kind: c.kind, prs: c.prs, paths: c.paths })), "ONE_TEXTUAL_PAIR").toEqual([{
    kind: "textual", paths: ["packages/ithaca/src/oars.ts"],
    prs: [{ number: 101, head: prs.rowers.head }, { number: 102, head: prs.suitors.head }],
  }]);
});

test("different files in the same closure are closure, not textual", async () => {
  const { root, prs } = fixture();
  const report = await collisions({ root, listPrs: list(prs.rowers, prs.sails, prs.chart), fetch: true });
  expect(report.collisions, "SAME_CLOSURE_IS_CLOSURE").toEqual([expect.objectContaining({
    kind: "closure", prs: [{ number: 101, head: prs.rowers.head }, { number: 104, head: prs.sails.head }],
    paths: ["packages/ithaca/tests/ship.test.ts"], workspaces: ["ithaca"],
  })]);
  expect(report.collisions[0]!.categories).toContain("unit");
});

test("an unbuildable selection graph is unknown, never disjoint", async () => {
  const { root, prs } = fixture();
  const before = state(root);
  const report = await collisions({ root, listPrs: list(prs.rowers, prs.suitors, prs.chart, prs.sails), fetch: true,
    buildGraph: () => { throw new Error("graph refused"); } });
  expect(state(root)).toEqual(before);
  expect(report.graph).toEqual(expect.objectContaining({ status: "unknown" }));
  // Textual evidence needs no graph; every other pair is unknown, including the disjoint branch.
  const kinds = Object.fromEntries(report.collisions.map(c => [pair(c).join("x"), c.kind]));
  expect(kinds, "UNKNOWN_GRAPH_NEVER_DISJOINT").toEqual({
    "101x102": "textual", "101x103": "unknown", "101x104": "unknown",
    "102x103": "unknown", "102x104": "unknown", "103x104": "unknown",
  });
  expect(report.collisions.find(c => c.kind === "unknown")!.reason).toContain("graph refused");
});

test("a PR head that cannot be read is unknown, not disjoint", async () => {
  const { root, prs } = fixture();
  const missing = { ...prs.chart, head: "0".repeat(39) + "1" };
  const report = await collisions({ root, listPrs: list(prs.rowers, missing), fetch: false });
  expect(report.collisions.map(c => c.kind)).toEqual(["unknown"]);
});

test("conflicts that come only from base drift are not textual pairs", async () => {
  const { root, prs, seed, origin } = fixture();
  // Main moves on after #101 branched, rewriting the same line; #105 starts from that newer main.
  run(seed, "switch", "-q", "main");
  writeFileSync(join(seed, "packages/ithaca/src/oars.ts"), "export const oars = 50;\n");
  run(seed, "commit", "-qam", "main moves");
  run(seed, "switch", "-q", "-c", "pr-105");
  writeFileSync(join(seed, "docs/sea-chart.md"), "# Later chart\n");
  run(seed, "add", "-A"); run(seed, "commit", "-qm", "pr 105");
  const later: OpenPr = { number: 105, head: run(seed, "rev-parse", "HEAD"), base: run(seed, "rev-parse", "main"), baseRef: "main", draft: false };
  run(seed, "push", "-q", origin, "main:refs/heads/main", `${later.head}:refs/pull/105/head`);
  run(root, "fetch", "-q", "origin");
  const report = await collisions({ root, listPrs: list(prs.rowers, later), fetch: true });
  expect(report.collisions, "BASE_DRIFT_IS_NOT_TEXTUAL").toEqual([]);
});

test("--pr reports only collisions involving that PR", async () => {
  const { root, prs } = fixture();
  const all = list(prs.rowers, prs.suitors, prs.chart, prs.sails);
  const report = await collisions({ root, listPrs: all, pr: 104, fetch: true });
  expect(report.collisions.map(c => [c.kind, ...pair(c)])).toEqual([["closure", 101, 104], ["closure", 102, 104]]);
  await expect(collisions({ root, listPrs: all, pr: 999, fetch: false })).rejects.toThrow("not an open PR");
});

test("--paths reports which open PRs touch or share the closure of an area", async () => {
  const { root, prs } = fixture();
  const before = state(root);
  const report = await collisions({ root, listPrs: list(prs.rowers, prs.chart, prs.sails), paths: ["packages/ithaca/src/sails.ts"], fetch: true });
  expect(state(root)).toEqual(before);
  expect(report.collisions.map(c => [c.kind, ...pair(c)])).toEqual([["closure", 101], ["path", 104]]);
  const docs = await collisions({ root, listPrs: list(prs.rowers, prs.chart, prs.sails), paths: ["docs/**"], fetch: false });
  expect(docs.collisions.map(c => [c.kind, ...pair(c)])).toEqual([["path", 103]]);
});

test("arguments", () => {
  expect(parseArgs(["--json", "--pr", "7"])).toEqual({ json: true, fetch: true, pr: 7 });
  expect(parseArgs(["--paths", "a/**", "b.ts", "--no-fetch"])).toEqual({ json: false, fetch: false, paths: ["a/**", "b.ts"] });
  for (const bad of [["--pr"], ["--pr", "x"], ["--paths"], ["--pr", "1", "--paths", "a"], ["--merge"]])
    expect(() => parseArgs(bad)).toThrow("Usage");
});
