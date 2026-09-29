/**
 * The sidecar caches and the stats history union-merge in a plain git merge, not only in
 * `brain sync pull` (#414): the template ships the attribute, and
 * `brain doctor` checks for it and `--fix` adds it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { parseHistory } from "../src/lib/stats-history";

const TEMPLATE_ATTRIBUTES = resolve(import.meta.dir, "../../../template/.gitattributes");
const CACHE = ".context-cache.jsonl";
const HISTORY = ".stats-history.jsonl";

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

describe("the stats history (#581)", () => {
  /** Two clones that each recorded a different day, and a third day both rewrote. */
  function divergedHistory(attributes: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "brain-history-merge-"));
    dirs.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Alex Example");
    git(root, "config", "user.email", "alex@example.test");
    git(root, "config", "commit.gpgsign", "false");
    if (attributes !== null) writeFileSync(join(root, ".gitattributes"), attributes);
    const day = (date: string, at: string, documents: number) => JSON.stringify({ date, at, documents });
    const base = day("2026-09-27", "2026-09-27T03:00:00Z", 10);
    writeFileSync(join(root, HISTORY), `${base}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "base");
    git(root, "checkout", "-qb", "other");
    writeFileSync(join(root, HISTORY), `${base}\n${day("2026-09-28", "2026-09-28T05:00:00Z", 12)}\n`);
    git(root, "commit", "-qam", "other clone recorded");
    git(root, "checkout", "-q", "main");
    writeFileSync(join(root, HISTORY), `${base}\n${day("2026-09-28", "2026-09-28T03:00:00Z", 11)}\n`);
    git(root, "commit", "-qam", "this clone recorded");
    return root;
  }

  test("a plain git merge keeps both clones' lines, and the later recording of a day wins", () => {
    const root = divergedHistory(readFileSync(TEMPLATE_ATTRIBUTES, "utf8"));
    const merge = git(root, "merge", "--no-edit", "other");
    expect(merge.code, merge.out).toBe(0);
    const text = readFileSync(join(root, HISTORY), "utf8");
    expect(text).not.toContain("<<<<<<<");
    expect(text.split("\n").filter(Boolean)).toHaveLength(3);
    const history = parseHistory(text);
    expect(history.map((s) => [s.date, s.documents])).toEqual([["2026-09-27", 10], ["2026-09-28", 12]]);
  });

  test("without the attribute the same merge conflicts", () => {
    const root = divergedHistory(null);
    const merge = git(root, "merge", "--no-edit", "other");
    expect(merge.code).not.toBe(0);
    expect(merge.out).toContain(`CONFLICT (content): Merge conflict in ${HISTORY}`);
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
        expect(cacheMerge(before)?.detail).toContain(".context-cache.jsonl, .asset-cache.jsonl and .stats-history.jsonl");

        const fixed = JSON.parse((await runCli(root, ["doctor", "--fix", "--json"])).stdout) as DoctorOut;
        expect(fixed.fixesApplied).toContain("cache-merge");
        expect(cacheMerge(fixed)?.status).toBe("pass");
        const attributes = readFileSync(join(root, ".gitattributes"), "utf8");
        expect(attributes).toContain(".context-cache.jsonl merge=union\n");
        expect(attributes).toContain(".asset-cache.jsonl merge=union\n");
        expect(attributes).toContain(".stats-history.jsonl merge=union\n");

        // A second --fix changes nothing.
        await runCli(root, ["doctor", "--fix", "--json"]);
        expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe(attributes);
      } finally {
        cleanup(root);
      }
    }, 120_000);
  }

  test("a rule in info/attributes that overrides the committed one is reported, and --fix appends nothing", async () => {
    const root = makeTempBrain();
    try {
      git(root, "init", "-q");
      const committed = readFileSync(TEMPLATE_ATTRIBUTES, "utf8");
      writeFileSync(join(root, ".gitattributes"), committed);
      writeFileSync(join(root, ".git", "info", "attributes"), ".context-cache.jsonl -merge\n");

      const before = JSON.parse((await runCli(root, ["doctor", "--json"])).stdout) as DoctorOut;
      expect(cacheMerge(before)?.status).toBe("warn");
      expect(cacheMerge(before)?.detail).toContain("a rule local to this clone");

      for (let run = 0; run < 2; run++) {
        const fixed = JSON.parse((await runCli(root, ["doctor", "--fix", "--json"])).stdout) as DoctorOut;
        expect(fixed.fixesApplied).not.toContain("cache-merge");
        expect(cacheMerge(fixed)?.detail).toContain("a rule local to this clone");
      }
      expect(readFileSync(join(root, ".gitattributes"), "utf8")).toBe(committed);
    } finally {
      cleanup(root);
    }
  }, 120_000);

  test("a local core.attributesFile does not stand in for the committed rule", async () => {
    const root = makeTempBrain();
    try {
      git(root, "init", "-q");
      const local = join(root, ".git", "local-attributes");
      writeFileSync(local, ".context-cache.jsonl merge=union\n.asset-cache.jsonl merge=union\n.stats-history.jsonl merge=union\n");
      git(root, "config", "core.attributesFile", local);
      expect(git(root, "check-attr", "merge", "--", ".context-cache.jsonl").out).toContain("merge: union");

      const before = JSON.parse((await runCli(root, ["doctor", "--json"])).stdout) as DoctorOut;
      expect(cacheMerge(before)?.status).toBe("warn");
      expect(cacheMerge(before)?.detail).toContain(".gitattributes gives .context-cache.jsonl, .asset-cache.jsonl and .stats-history.jsonl no merge=union");

      const fixed = JSON.parse((await runCli(root, ["doctor", "--fix", "--json"])).stdout) as DoctorOut;
      expect(cacheMerge(fixed)?.status).toBe("pass");
      expect(readFileSync(join(root, ".gitattributes"), "utf8")).toContain(".context-cache.jsonl merge=union");
    } finally {
      cleanup(root);
    }
  }, 120_000);

  test("--fix keeps a CRLF .gitattributes CRLF", async () => {
    const root = makeTempBrain();
    try {
      writeFileSync(join(root, ".gitattributes"), "*.txt text\r\n");
      await runCli(root, ["doctor", "--fix", "--json"]);
      const text = readFileSync(join(root, ".gitattributes"), "utf8");
      expect(text).toContain(".asset-cache.jsonl merge=union\r\n");
      expect(text.replaceAll("\r\n", "")).not.toContain("\n");
    } finally {
      cleanup(root);
    }
  }, 120_000);

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
