/**
 * The sidecar caches union-merge in a plain git merge, not only in
 * `brain sync pull` (#414): the template ships the attribute, and
 * `brain doctor` checks for it and `--fix` adds it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const TEMPLATE_ATTRIBUTES = resolve(import.meta.dir, "../../../template/.gitattributes");
const CACHE = ".context-cache.jsonl";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

/**
 * A repository whose cache holds one line, then two branches that each append
 * a different line. With `attributes` written first, when given.
 */
function divergedRepo(attributes: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "brain-cache-merge-"));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Alex Example");
  git(root, "config", "user.email", "alex@example.test");
  git(root, "config", "commit.gpgsign", "false");
  if (attributes !== null) writeFileSync(join(root, ".gitattributes"), attributes);
  writeFileSync(join(root, CACHE), '{"k":"a","v":"base"}\n');
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "other");
  writeFileSync(join(root, CACHE), '{"k":"a","v":"base"}\n{"k":"c","v":"from other"}\n');
  git(root, "commit", "-qam", "other clone's context");
  git(root, "checkout", "-q", "main");
  writeFileSync(join(root, CACHE), '{"k":"a","v":"base"}\n{"k":"b","v":"from main"}\n');
  git(root, "commit", "-qam", "this clone's context");
  return root;
}

describe("the template's .gitattributes", () => {
  test("a plain git merge keeps both clones' cache lines, with no conflict", () => {
    const root = divergedRepo(readFileSync(TEMPLATE_ATTRIBUTES, "utf8"));
    const merge = git(root, "merge", "--no-edit", "other");
    expect(merge.code).toBe(0);
    const lines = readFileSync(join(root, CACHE), "utf8").split("\n").filter(Boolean).sort();
    expect(lines).toEqual(['{"k":"a","v":"base"}', '{"k":"b","v":"from main"}', '{"k":"c","v":"from other"}']);
  });

  test("without the attribute the same merge conflicts", () => {
    const root = divergedRepo(null);
    const merge = git(root, "merge", "--no-edit", "other");
    expect(merge.code).not.toBe(0);
    expect(merge.out).toContain(`CONFLICT (content): Merge conflict in ${CACHE}`);
  });
});

describe("brain doctor cache-merge", () => {
  interface DoctorOut {
    checks: Array<{ id: string; status: string; detail: string }>;
    fixesApplied?: string[];
  }
  const cacheMerge = (out: DoctorOut) => out.checks.find((c) => c.id === "cache-merge");

  for (const repo of [false, true]) {
    test(`warns without the attribute and passes after --fix (${repo ? "a git work tree" : "not a repository"})`, async () => {
      const root = makeTempBrain();
      try {
        if (repo) git(root, "init", "-q");
        const before = JSON.parse((await runCli(root, ["doctor", "--json"])).stdout) as DoctorOut;
        expect(cacheMerge(before)?.status).toBe("warn");
        expect(cacheMerge(before)?.detail).toContain(".context-cache.jsonl and .asset-cache.jsonl");

        const fixed = JSON.parse((await runCli(root, ["doctor", "--fix", "--json"])).stdout) as DoctorOut;
        expect(fixed.fixesApplied).toContain("cache-merge");
        expect(cacheMerge(fixed)?.status).toBe("pass");
        const attributes = readFileSync(join(root, ".gitattributes"), "utf8");
        expect(attributes).toContain(".context-cache.jsonl merge=union\n");
        expect(attributes).toContain(".asset-cache.jsonl merge=union\n");

        // A second --fix changes nothing.
        await runCli(root, ["doctor", "--fix", "--json"]);
        expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe(attributes);
      } finally {
        cleanup(root);
      }
    }, 120_000);
  }

  test("an attribute git already applies is a pass, whatever file sets it", async () => {
    const root = makeTempBrain();
    try {
      writeFileSync(join(root, ".gitattributes"), "*.jsonl merge=union\n");
      const out = JSON.parse((await runCli(root, ["doctor", "--json"])).stdout) as DoctorOut;
      expect(cacheMerge(out)?.status).toBe("pass");
    } finally {
      cleanup(root);
    }
  }, 60_000);
});
