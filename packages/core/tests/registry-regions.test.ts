/**
 * Generated regions and `_index.md` registry tables (#403).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { readGeneratedRegion, replaceGeneratedRegion } from "../src/lib/generated-regions";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const roots: string[] = [];
afterAll(() => roots.forEach(cleanup));

describe("replaceGeneratedRegion / readGeneratedRegion", () => {
  const OPEN = "<!-- brain:generated:t -->";
  const CLOSE = "<!-- /brain:generated:t -->";

  test("keeps every byte outside the markers, and reads back what it wrote", () => {
    const before = "Intro  \r\nwith odd spacing\n\n";
    const after = "\n\nTrailing *prose*\n";
    const body = `${before}${OPEN}\n\nold\n\n${CLOSE}${after}`;
    const next = replaceGeneratedRegion(body, "t", "| a |\n| - |");
    expect(next).toBe(`${before}${OPEN}\n\n| a |\n| - |\n\n${CLOSE}${after}`);
    expect(readGeneratedRegion(next, "t")).toBe("| a |\n| - |");
  });

  test("is a no-op, the very same string, when the content is unchanged", () => {
    const body = `x\n\n${OPEN}\n\nsame\n\n${CLOSE}\n`;
    expect(replaceGeneratedRegion(body, "t", "same")).toBe(body);
  });

  test("appends the region to a body that has none", () => {
    expect(replaceGeneratedRegion("Prose.\n\n", "t", "c")).toBe(`Prose.\n\n${OPEN}\n\nc\n\n${CLOSE}\n`);
    expect(readGeneratedRegion("Prose.", "t")).toBeNull();
  });
});

/** The fixture brain with a `projects/_index.md` that opts in. */
function brain(): { root: string; index: string; prose: string } {
  const root = makeTempBrain();
  roots.push(root);
  const index = join(root, "projects/_index.md");
  const prose = [
    "---",
    "type: index",
    "title: Projects",
    'created: "2026-01-01"',
    "updated: 2026-01-02",
    "registry: { columns: [link, status, updated] }",
    "---",
    "",
    "# Projects",
    "",
    "Hand-written  purpose blurb, kept byte for byte.",
    "",
  ].join("\n");
  writeFileSync(index, prose);
  return { root, index, prose };
}

async function json(root: string, args: string[]): Promise<{ code: number; out: any }> {
  const r = await runCli(root, [...args, "--json"]);
  return { code: r.code, out: JSON.parse(r.stdout) };
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=Alex Example", "-c", "user.email=alex@example.test", "-c", "commit.gpgsign=false", ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

describe("brain registry", () => {
  test("writes a table of the children and keeps the prose around it", async () => {
    const { root, index, prose } = brain();
    const { code, out } = await json(root, ["registry"]);
    expect(code).toBe(0);
    expect(out.written).toEqual(["projects/_index.md"]);

    const text = readFileSync(index, "utf8");
    const bodyBefore = prose.slice(prose.indexOf("---\n", 4) + 4);
    const bodyAfter = text.slice(text.indexOf("---\n", 4) + 4);
    expect(bodyAfter.startsWith(bodyBefore.trimEnd())).toBe(true);
    const table = readGeneratedRegion(text, "registry")!;
    expect(table.split("\n").slice(0, 2)).toEqual(["| link | status | updated |", "| --- | --- | --- |"]);
    expect(table).toContain("| [[projects/active/bookshelf/status]] |");
    expect(table).toContain("| [[projects/active/trail-signage/status]] |");
    expect(text).toMatch(/^updated: \d{4}-\d{2}-\d{2}$/m);
    expect(text).not.toContain("updated: 2026-01-02");
  }, 60_000);

  test("a second run writes nothing and does not bump updated", async () => {
    const { root, index } = brain();
    await json(root, ["registry"]);
    const first = readFileSync(index, "utf8");
    writeFileSync(index, first.replace(/^updated: .*$/m, "updated: 2026-01-03"));
    const pinned = readFileSync(index, "utf8");

    const { out } = await json(root, ["registry"]);
    expect(out).toMatchObject({ indexes: 1, written: [], stale: [], invalid: [] });
    expect(readFileSync(index, "utf8")).toBe(pinned);
  }, 60_000);

  test("brain maintain has a registry step and writes the same file", async () => {
    const a = brain();
    const b = brain();
    await json(a.root, ["registry"]);
    const { out } = await json(b.root, ["maintain", "--no-git"]);
    const step = (out as Array<{ step: string; result: string }>).find((s) => s.step === "registry");
    expect(step?.result).toBe("ok — 1 of 1 table(s) rewritten");
    expect(readFileSync(b.index, "utf8")).toBe(readFileSync(a.index, "utf8"));
  }, 120_000);

  test("a child's changed status makes the index index-stale, not index-lag", async () => {
    const { root, index } = brain();
    await json(root, ["registry"]);
    // Far ahead of the index's updated, so plain index-lag would fire.
    const child = join(root, "projects/active/trail-signage/status.md");
    writeFileSync(
      child,
      readFileSync(child, "utf8").replace(/^status: .*$/m, "status: paused").replace(/^updated: .*$/m, "updated: 2027-01-01")
    );
    await runCli(root, ["index", "--json"]);
    const { out } = await json(root, ["audit"]);
    const onIndex = (out.issues as Array<{ path: string; category: string }>).filter((i) => i.path === "projects/_index.md");
    expect(onIndex.map((i) => i.category)).toContain("index-stale");
    expect(onIndex.map((i) => i.category)).not.toContain("index-lag");
    expect(readFileSync(index, "utf8")).toContain("<!-- brain:generated:registry -->");
  }, 120_000);

  test("--check exits 1 on a stale index and writes nothing", async () => {
    const { root } = brain();
    await json(root, ["registry"]);
    const child = join(root, "projects/active/trail-signage/status.md");
    writeFileSync(child, readFileSync(child, "utf8").replace(/^status: .*$/m, "status: paused"));
    git(root, "init", "-q");
    git(root, "add", "-A", "--", ".", ":!node_modules");
    git(root, "commit", "-qm", "fixture");

    const { code, out } = await json(root, ["registry", "--check"]);
    expect(code).toBe(1);
    expect(out.stale).toEqual(["projects/_index.md"]);
    expect(git(root, "status", "--porcelain", "--", ".", ":!node_modules")).toBe("");
  }, 120_000);
});
