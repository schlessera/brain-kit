import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONTRACT_END, CONTRACT_START } from "../src/lib/skills/emitters/contract-block";
import { cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(cleanup));

const instructions = [
  "GEMINI.md", "notes/GEMINI.md", "notes/voyage/crew/GEMINI.md",
  "CLAUDE.md", "AGENTS.md", "notes/CLAUDE.md", "notes/AGENTS.md",
];
const notes = ["notes/voyage.md", "notes/gemini.md", "notes/Gemini.md", "notes/GEMINI.MD", "notes/GEMINI-extra.md"];
const rootNotes = ["gemini.md", "Gemini.md", "GEMINI.MD", "GEMINI-extra.md"];
const paths = [...instructions, ...notes, ...rootNotes];

function save(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function gitResult(root: string, ...args: string[]) {
  return Bun.spawnSync(["git", "-C", root, ...args], {
    env: { ...keylessEnv(root), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0" },
  });
}

function git(root: string, ...args: string[]): string {
  const result = gitResult(root, ...args);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

function fixture(): string {
  const root = makeTempBrain();
  roots.push(root);
  const config = readFileSync(join(root, "brain.config.ts"), "utf8");
  expect(config).toContain("  taxonomy: {");
  save(root, "brain.config.ts", config.replace("  taxonomy: {", '  sync: { judge: "off" },\n  taxonomy: {'));
  save(root, ".gitignore", "node_modules\nbrain.db\nbrain.db-*\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Odysseus");
  git(root, "config", "user.email", "odysseus@example.test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", "/dev/null");
  return root;
}

function body(side: string): string {
  return `---\ntitle: Sync instructions fixture\n---\n\nUser prefix from ${side}.\n\n${CONTRACT_START}\nRead the ${side} fixture instructions before the voyage.\n${CONTRACT_END}\n\nUser suffix from ${side}.\n`;
}

async function sync(root: string, verb: string) {
  const result = await runCli(root, ["sync", verb, "--json"]);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function diverge(root: string, changes: (side: string) => void): void {
  changes("base");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base instructions");
  git(root, "switch", "-q", "-c", "other");
  changes("theirs");
  git(root, "commit", "-qam", "other instructions");
  git(root, "switch", "-q", "main");
  changes("ours");
  git(root, "commit", "-qam", "local instructions");
}

describe("instruction filenames in real Git and sync CLI", () => {
  test("assess and group classify root Gemini as config while nested and filename controls keep their classification", async () => {
    const root = fixture();
    for (const path of paths) save(root, path, body("base"));
    const assessed = await sync(root, "assess");
    expect(assessed.files.length).toBeGreaterThan(0);
    for (const path of paths) expect(assessed.files).toContainEqual({ path, class: path.endsWith(".MD") ? "UNKNOWN" : "TRACK", status: "?" });
    const grouped = await sync(root, "group");
    expect(grouped.groups.length).toBeGreaterThan(0);
    expect(grouped.groups).toContainEqual({ path: "GEMINI.md", domain: "config", status: "?" });
    for (const path of paths.filter(p => p !== "GEMINI.md")) {
      if (path.endsWith(".MD")) {
        expect(grouped.groups.some((g: { path: string }) => g.path === path)).toBe(false);
        continue;
      }
      const domain = path === "CLAUDE.md" || path === "AGENTS.md" ? "config" : "note";
      expect(grouped.groups).toContainEqual({ path, domain, status: "?" });
    }
  });

  test("resolve preserves root and nested instruction conflict bytes and stages; ordinary filename controls still resolve", async () => {
    const root = fixture();
    diverge(root, side => paths.forEach(path => save(root, path, body(side))));
    expect(gitResult(root, "merge", "other", "--no-edit").exitCode).toBe(1);
    expect(git(root, "diff", "--name-only", "--diff-filter=U").split("\n").sort()).toEqual([...paths].sort());
    // Every side has both managed instructions and surrounding user prose.
    for (const path of paths) {
      for (const [stage, side] of [[1, "base"], [2, "ours"], [3, "theirs"]] as const) {
        const text = git(root, "show", `:${stage}:${path}`);
        expect(text.length).toBeGreaterThan(0);
        expect(text).toContain(CONTRACT_START);
        expect(text).toContain(CONTRACT_END);
        expect(text).toContain(`Read the ${side} fixture instructions`);
        expect(text).toContain(`User prefix from ${side}.`);
        expect(text).toContain(`User suffix from ${side}.`);
      }
    }
    const snapshots = instructions.map(path => ({
      path, text: readFileSync(join(root, path), "utf8"), stages: git(root, "ls-files", "-u", "--", path),
    }));
    for (const snapshot of snapshots) {
      expect(snapshot.text).toContain("<<<<<<<");
      expect(snapshot.stages.split("\n")).toHaveLength(3);
    }
    const head = git(root, "rev-parse", "HEAD");
    const mergeHead = git(root, "rev-parse", "MERGE_HEAD");
    const resolved = await sync(root, "resolve");
    // Preservation is checked before summary fields, so a dispatch mutation
    // must fail on the actual destructive write it would allow.
    for (const { path, text, stages } of snapshots) {
      expect(readFileSync(join(root, path), "utf8"), path).toBe(text);
      expect(git(root, "ls-files", "-u", "--", path), path).toBe(stages);
      expect(existsSync(join(root, path.replace(/\.md$/, "-remote.md"))), path).toBe(false);
    }
    expect(resolved.status).toBe("needs-judgment");
    expect(resolved.unresolved.map((r: { path: string }) => r.path).sort()).toEqual([...instructions].sort());
    for (const path of instructions) expect(resolved.unresolved).toContainEqual({ path, strategy: "code-merge", reason: expect.stringContaining("code-merge") });
    for (const path of notes) {
      expect(resolved.resolved.find((r: { path: string }) => r.path === path).strategy).toBe("keep-both");
      expect(readFileSync(join(root, path), "utf8")).toBe(body("ours"));
      expect(readFileSync(join(root, path.replace(/(\.[^.]+)$/, "-remote$1")), "utf8")).toBe(body("theirs"));
    }
    for (const path of rootNotes) {
      expect(resolved.resolved.find((r: { path: string }) => r.path === path).strategy).toBe("synthesize");
      const text = readFileSync(join(root, path), "utf8");
      expect(text).toContain("Read the ours fixture instructions");
      expect(text).toContain("Read the theirs fixture instructions");
      expect(text).not.toContain("<<<<<<<");
    }
    expect(resolved.judge.calls).toBe(0);
    expect(git(root, "diff", "--name-only", "--diff-filter=U").split("\n").sort()).toEqual([...instructions].sort());
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "rev-parse", "MERGE_HEAD")).toBe(mergeHead);
  });

  test("clean Git line merges retain independent user and managed-region edits for exact instruction filenames", () => {
    const root = fixture();
    const base = ["User prefix from base.", ...Array.from({ length: 20 }, (_, n) => `Stable guidance ${n}.`), CONTRACT_START, "Managed fixture instructions from base.", CONTRACT_END, "User suffix from base.", ""].join("\n");
    diverge(root, side => {
      const text = side === "ours" ? base.replace("User prefix from base.", "User prefix from ours.") : side === "theirs" ? base.replace("Managed fixture instructions from base.", "Managed fixture instructions from theirs.") : base;
      instructions.forEach(path => save(root, path, text));
    });
    expect(gitResult(root, "merge", "other", "--no-edit").exitCode).toBe(0);
    expect(git(root, "ls-files", "-u")).toBe("");
    for (const path of instructions) {
      const text = readFileSync(join(root, path), "utf8");
      expect(text).toContain("User prefix from ours.");
      expect(text).toContain("Managed fixture instructions from theirs.");
      expect(text).toContain("User suffix from base.");
      expect(text).not.toContain("<<<<<<<");
    }
  });

  test("real indexing keeps root instructions excluded and nested exact filenames in content", async () => {
    const root = fixture();
    const text = body("base").replace("title: Sync instructions fixture", "title: Sync instructions fixture\ntype: note\ntags: [voyage]\ncreated: 2026-07-12\nupdated: 2026-07-12");
    const content = [...instructions.filter(path => path.includes("/")), ...notes.filter(path => path.endsWith(".md"))];
    for (const path of [...instructions, ...content]) save(root, path, text);
    const indexed = await runCli(root, ["index", "--force", "--json"]);
    expect(indexed.code, indexed.stderr).toBe(0);
    expect(JSON.parse(indexed.stdout).total).toBeGreaterThan(0);
    const listed = await runCli(root, ["list", "--limit", "100", "--json"]);
    expect(listed.code, listed.stderr).toBe(0);
    const indexedPaths = (JSON.parse(listed.stdout) as { path: string }[]).map(row => row.path);
    expect(indexedPaths.length).toBeGreaterThan(0);
    for (const path of content) expect(indexedPaths, path).toContain(path);
    for (const path of ["GEMINI.md", "CLAUDE.md", "AGENTS.md"]) expect(indexedPaths, path).not.toContain(path);
  });
});
