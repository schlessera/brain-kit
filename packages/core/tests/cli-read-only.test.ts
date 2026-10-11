import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../src/internal.js";
import { readOnlyBrainError } from "../src/cli/read-only.js";
let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

test("only EROFS receives the hosted read-only error envelope", () => {
  expect(readOnlyBrainError("add", { code: "EACCES" })).toBeNull();
  expect(readOnlyBrainError("add", { code: "EROFS" })).toMatchObject({ schema_version: 1, ok: false, error: { code: "read_only_brain", tool: "brain_add" } });
  expect(readOnlyBrainError("archive", { code: "EROFS" })?.error.tool).toBe("brain_archive");
});

test("read-only bind refuses capture visibly and leaves search usable", async () => {
  root = mkdtempSync(join(tmpdir(), "brain-read-only-"));
  cpSync(resolve("packages/core/fixtures/corpus"), root, { recursive: true });
  const config = join(root, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
  const run = async (readOnly: boolean, ...args: string[]) => {
    const prefix = readOnly ? ["bwrap", "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--ro-bind", root!, root!] : [];
    const child = Bun.spawn([...prefix, process.execPath, resolve("packages/core/src/cli/brain.ts"), ...args], { cwd: process.cwd(), env: { ...process.env, BRAIN_ROOT: root!, GEMINI_API_KEY: "", GOOGLE_API_KEY: "", TYPESAFE_API_KEY: "", ANTHROPIC_API_KEY: "" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  };
  // Index in a fresh actual CLI process as well: setup must not inherit any
  // parent suite's module/context caches or globals.
  const indexed = await run(false, "index", "--force", "--json");
  expect(indexed.exit, indexed.stderr).toBe(0);
  const db = openDatabase(join(root, "brain.db"));
  try {
    expect((db.query("SELECT count(*) AS n FROM documents_fts WHERE documents_fts MATCH 'raft'").get() as { n: number }).n).toBeGreaterThan(0);
  } finally { db.close(); }
  const before = readdirSync(join(root, "notes"));
  const add = await run(true, "add", "Odysseus needs a stronger mast", "--json");
  expect(add.exit).toBe(2);
  expect(add.stdout).toContain('"read_only_brain"');
  expect(JSON.parse(add.stdout)).toMatchObject({ schema_version: 1, ok: false, error: { code: "read_only_brain", tool: "brain_add" } });
  expect(JSON.parse(add.stdout).error.message).toContain("read-only here");
  expect(JSON.parse(add.stdout).error.message).toContain("mcp__brain-ui__brain_add");
  expect(readdirSync(join(root, "notes"))).toEqual(before);
  const registry = await run(true, "registry", "--json");
  expect(registry.exit).toBe(2);
  expect(registry.stdout).toContain('"read_only_brain"');
  expect(JSON.parse(registry.stdout).error.tool).toBe("apply_staged_changes");
  const search = await run(true, "search", "raft", "--json");
  expect(search.exit).toBe(0);
  expect(JSON.parse(search.stdout).results.length, JSON.stringify(search)).toBeGreaterThan(0);
});

test("a hosted scratch mount keeps render --scratch and scratch prune working; brain writes name the scratch route", async () => {
  // Outside /tmp, which the worker sees as its own fresh tmpfs.
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(join(resolve("tmp"), "brain-read-only-scratch-"));
  cpSync(resolve("packages/core/fixtures/corpus"), root, { recursive: true });
  const config = join(root, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
  writeFileSync(join(root, ".gitignore"), ".brain/scratch/\n");
  const scratch = join(root, ".brain/scratch");
  mkdirSync(scratch, { recursive: true });
  // The worker's layout (#1626): the brain read-only, its scratch area bound writable on top.
  const run = async (bindScratch: boolean, ...args: string[]) => {
    const prefix = ["bwrap", "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/tmp", "--ro-bind", root!, root!, ...(bindScratch ? ["--bind", scratch, scratch] : [])];
    const child = Bun.spawn([...prefix, process.execPath, resolve("packages/core/src/cli/brain.ts"), ...args], { cwd: process.cwd(),
      env: { ...process.env, BRAIN_ROOT: root!, GEMINI_API_KEY: "", GOOGLE_API_KEY: "", TYPESAFE_API_KEY: "", ANTHROPIC_API_KEY: "" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  };
  const prune = await run(true, "scratch", "prune", "--json");
  expect(prune.exit, prune.stderr + prune.stdout).toBe(0);
  const rendered = await run(true, "render", "notes/loose-idea.md", "--format", "html", "--scratch", "--json");
  expect(rendered.exit, rendered.stderr + rendered.stdout).toBe(0);
  expect(readdirSync(scratch).filter(name => name.endsWith(".html"))).toHaveLength(1);
  const before = readdirSync(join(root, "notes"));
  const inBrain = await run(true, "render", "notes/loose-idea.md", "--format", "html", "--json");
  expect(inBrain.exit, "RENDER_REFUSAL").toBe(2);
  expect(JSON.parse(inBrain.stdout).error).toMatchObject({ code: "read_only_brain" });
  expect(JSON.parse(inBrain.stdout).error.message, "RENDER_REFUSAL").toContain("Write the output with --scratch");
  expect(readdirSync(join(root, "notes"))).toEqual(before);
  const unbound = await run(false, "scratch", "prune", "--json");
  expect(unbound.exit).toBe(2);
  expect(JSON.parse(unbound.stdout).error.message).toContain(".brain/scratch/ is read-only here");
  const noScratch = await run(false, "render", "notes/loose-idea.md", "--format", "html", "--scratch", "--json");
  expect(noScratch.exit).toBe(2);
  expect(JSON.parse(noScratch.stdout).error.message).toContain("read-only in this turn as well");
  // A scratch directory missing from the read-only brain is no route either; the refusal must not suggest it.
  rmSync(scratch, { recursive: true, force: true });
  const missing = await run(false, "render", "notes/loose-idea.md", "--format", "html", "--scratch", "--json");
  expect(missing.exit).toBe(2);
  expect(JSON.parse(missing.stdout).error.message, "MISSING_SCRATCH").toContain("read-only in this turn as well");
  expect(JSON.parse(missing.stdout).error.message).not.toContain("Write the output with --scratch");
});
