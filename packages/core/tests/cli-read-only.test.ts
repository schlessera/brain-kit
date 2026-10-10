import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
