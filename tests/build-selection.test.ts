import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listPublishablePackages, selectBuildPackages } from "../scripts/publishable-packages";

const repo = resolve(import.meta.dir, ".."), temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function dryRun(...args: string[]) {
  const child = Bun.spawnSync([process.execPath, "scripts/build.ts", "--dry-run", ...args], { cwd: repo });
  return { code: child.exitCode, out: child.stdout.toString(), error: child.stderr.toString() };
}

test("--for ui-react prints exactly its forward closure in unchanged publish order", () => {
  const result = dryRun("--for", "ui-react");
  expect(result.code, result.error).toBe(0);
  expect(result.out.trim().split("\n")).toEqual([
    "common", "geo", "render-template", "ui-kit", "ui-sdk", "ui-react",
  ].map(dir => `Would build packages/${dir}`));
  expect(dryRun().out.trim().split("\n")).toEqual(listPublishablePackages(repo).map(pkg => `Would build packages/${pkg.dir}`));
  expect(dryRun("--jobs=2", "--for", "ui-react").out).toBe(result.out);
  expect(dryRun("--jobs=1").out).toBe(dryRun().out);
  expect(selectBuildPackages(repo, ["ui-react", "ui-server", "core"]).map(pkg => pkg.dir)).toEqual([
    "common", "geo", "render-template", "core", "ui-kit", "ui-render-puppeteer", "ui-sdk",
    "ui-backend-claude", "ui-backend-pi", "ui-react", "ui-server",
  ]);
});

test("forward selection includes all four dependency fields, transitive edges and peer/dev cycles", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-build-selection-")); temporary.push(root);
  const definitions: Record<string, object> = {
    app: { dependencies: { "@fixture/hard": "workspace:*" }, devDependencies: { "@fixture/dev": "workspace:*" },
      peerDependencies: { "@fixture/peer": "*" }, optionalDependencies: { "@fixture/optional": "workspace:*" } },
    hard: { dependencies: { "@fixture/transitive": "workspace:*" } },
    dev: { peerDependencies: { "@fixture/app": "*" } }, peer: {}, optional: {}, transitive: {}, unrelated: {},
  };
  for (const [dir, edges] of Object.entries(definitions)) {
    mkdirSync(join(root, "packages", dir), { recursive: true });
    writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify({ name: `@fixture/${dir}`, version: "1.0.0", ...edges }));
  }
  const selected = selectBuildPackages(root, ["app", "app"]);
  expect(selected.map(pkg => pkg.dir)).toEqual(listPublishablePackages(root).filter(pkg => pkg.dir !== "unrelated").map(pkg => pkg.dir));
  expect(selected).toHaveLength(6);
  const result = dryRun(root, "--for", "app");
  expect(result.code, result.error).toBe(0);
  expect(result.out.trim().split("\n")).toEqual(selected.map(pkg => `Would build packages/${pkg.dir}`));
});

test("unknown, missing, empty and duplicate selections fail before building", () => {
  for (const args of [["--for", "missing"], ["--for"], ["--for", "ui-react,"], ["--for", "ui-react", "--for", "core"], ["--unknown"], ["--jobs=0"], ["--jobs=3"], ["--jobs=2", "--jobs=2"]]) {
    const result = dryRun(...args);
    expect(result.code, JSON.stringify(args)).not.toBe(0);
    expect(result.error).toContain("Build failed:");
    expect(result.out).not.toContain("Would build");
  }
});
