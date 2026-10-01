import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });

function fixture(): string {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  mkdirSync(join(root, "modules/catalog"), { recursive: true });
  writeFileSync(join(root, "modules/catalog/module.ts"), `
import { z } from "zod";
export default {
  name: "catalog",
  configSchema: z.object({ limit: z.number().int().positive("Limit must be positive"), nested: z.object({ a: z.number().default(1), b: z.number().default(2) }).default({ a: 1, b: 2 }) }).strict(),
  setup: () => ({}),
};
`);
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ modules: { "./modules/catalog": { limit: 3, nested: { a: 5 } } } }));
  mkdirSync(join(root, "settings"));
  return root;
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { env: keylessEnv(root) });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return new TextDecoder().decode(result.stdout).trim();
}

function initializeGit(root: string): void {
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Alex Example"]);
  git(root, ["config", "user.email", "alex@example.com"]);
  git(root, ["add", "brain.config.json", "modules"]);
  git(root, ["commit", "-m", "fixture"]);
}

async function settings(root: string, extra: string[] = []) {
  const result = await runCli(root, ["module", "settings", "catalog", ...extra, "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  return JSON.parse(result.stdout);
}

async function saveBody(root: string, values: unknown, revision: string, preview = false) {
  const proc = Bun.spawn([process.execPath, BRAIN_BIN, "module", "settings", "catalog", "--stdin", "--revision", revision, ...(preview ? ["--preview"] : []), "--json"], { env: keylessEnv(root), stdin: new TextEncoder().encode(JSON.stringify(values)), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr, body: JSON.parse(stdout) };
}

test("module JSON overrides apply per key before the original schema and defaults", async () => {
  const root = fixture();
  writeFileSync(join(root, "settings/catalog.json"), '{"limit":7,"nested":{"b":9}}\n');
  const result = await runCli(root, ["config", "get", "modules", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)["./modules/catalog"]).toMatchObject({ limit: 7, nested: { a: 5, b: 9 } });
});

test("hand-edited invalid settings fail real brain validate with the module schema message", async () => {
  const root = fixture();
  const path = join(root, "settings/catalog.json");
  writeFileSync(path, '{"limit":-1}\n');
  const result = await runCli(root, ["validate", "--json"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr + result.stdout).toContain("Limit must be positive");
  expect(readFileSync(path, "utf8")).toBe('{"limit":-1}\n');
});

test("GET derives fields/defaults from the actual Zod schema, with per-field provenance", async () => {
  const root = fixture();
  const result = await settings(root);
  expect(result.schema.properties).toHaveProperty("limit");
  expect(result.schema.properties.nested.properties.b.default).toBe(2);
  expect(result.values.nested).toEqual({ a: 5, b: 2 });
  expect(result.provenance["nested.a"]).toBe("brain-config");
  expect(result.provenance["nested.b"]).toBe("default");
  expect(result.overrides).toEqual({});
});

test("save changes only module JSON, makes exactly one commit and retains unrelated staged work", async () => {
  const root = fixture();
  initializeGit(root);
  const before = readFileSync(join(root, "brain.config.json"), "utf8");
  writeFileSync(join(root, "other.md"), "Unrelated work\n");
  git(root, ["add", "other.md"]);
  const saved = await settings(root, ["--set", "limit=7"]);
  expect(saved.changed).toBe(true);
  expect(saved.values.limit).toBe(7);
  expect(git(root, ["rev-list", "--count", "HEAD"])).toBe("2");
  expect(git(root, ["show", "--pretty=", "--name-only", "HEAD"])).toBe("settings/catalog.json");
  expect(git(root, ["diff", "--cached", "--name-only"])).toBe("other.md");
  expect(readFileSync(join(root, "brain.config.json"), "utf8")).toBe(before);
  const unchanged = await settings(root, ["--set", "limit=7"]);
  expect(unchanged.changed).toBe(false);
  expect(git(root, ["rev-list", "--count", "HEAD"])).toBe("2");
});

test("schema rejection and stale revision do not write or commit", async () => {
  const root = fixture();
  initializeGit(root);
  const original = await settings(root);
  const invalid = await runCli(root, ["module", "settings", "catalog", "--set", "limit=-1", "--json"]);
  expect(invalid.code).toBe(1);
  expect(JSON.parse(invalid.stdout).errors).toEqual([{ path: "limit", message: "Limit must be positive" }]);
  expect(existsSync(join(root, "settings/catalog.json"))).toBe(false);
  await settings(root, ["--set", "limit=7"]);
  const before = readFileSync(join(root, "settings/catalog.json"), "utf8");
  const stale = await runCli(root, ["module", "settings", "catalog", "--set", "limit=9", "--revision", original.revision, "--json"]);
  expect(JSON.parse(stale.stdout).status).toBe(409);
  expect(readFileSync(join(root, "settings/catalog.json"), "utf8")).toBe(before);
  expect(git(root, ["rev-list", "--count", "HEAD"])).toBe("2");
});

test("commit failure rolls back saved bytes and only the target index entries", async () => {
  const root = fixture();
  initializeGit(root);
  const hook = join(root, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  writeFileSync(join(root, "other.md"), "Unrelated work\n");
  git(root, ["add", "other.md"]);
  const result = await runCli(root, ["module", "settings", "catalog", "--set", "limit=7", "--json"]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).status).toBe(500);
  expect(existsSync(join(root, "settings/catalog.json"))).toBe(false);
  expect(git(root, ["rev-list", "--count", "HEAD"])).toBe("1");
  expect(git(root, ["diff", "--cached", "--name-only"])).toBe("other.md");
});

test("unavailable modules remain rows while valid neighboring settings can still be read and saved", async () => {
  const root = fixture();
  mkdirSync(join(root, "modules/broken"));
  writeFileSync(join(root, "modules/broken/module.ts"), 'import {z} from "zod"; export default {name:"broken",configSchema:z.object({limit:z.number()}),setup:()=>({})};');
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ modules: { "./modules/catalog": { limit: 3 }, "./modules/broken": { limit: "invalid" } } }));
  initializeGit(root);
  const list = await runCli(root, ["module", "list", "--json"]);
  expect(JSON.parse(list.stdout).enabled).toMatchObject([{ name: "catalog", state: "active", settings: true }, { name: "broken", state: "unavailable", settings: false }]);
  expect((await settings(root)).values.limit).toBe(3);
  expect((await settings(root, ["--set", "limit=8"])).values.limit).toBe(8);
});

test("partial recovery keeps duplicate module names unavailable without sharing a settings writer", async () => {
  const root = fixture();
  for (const key of ["first", "second"]) {
    mkdirSync(join(root, "modules", key));
    writeFileSync(join(root, "modules", key, "module.ts"), 'import {z} from "zod"; export default {name:"duplicate",configSchema:z.object({limit:z.number()}),setup:()=>({})};');
  }
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ modules: { "./modules/catalog": { limit: 3 }, "./modules/first": { limit: 1 }, "./modules/second": { limit: 2 } } }));
  initializeGit(root);
  const list = await runCli(root, ["module", "list", "--json"]);
  const rows = JSON.parse(list.stdout).enabled;
  expect(rows).toHaveLength(3);
  expect(rows.filter((row: { name: string }) => row.name === "duplicate")).toHaveLength(2);
  expect(rows.filter((row: { name: string }) => row.name === "duplicate").map((row: { state: string }) => row.state)).toEqual(["unavailable", "unavailable"]);
  const denied = await runCli(root, ["module", "settings", "duplicate", "--set", "limit=9", "--json"]);
  expect(denied.code).toBe(1);
  expect(existsSync(join(root, "settings/duplicate.json"))).toBe(false);
  expect(git(root, ["rev-list", "--count", "HEAD"])).toBe("1");
  expect((await settings(root, ["--set", "limit=8"])).values.limit).toBe(8);
});

test("whole-form no-ops and unrelated edits preserve complete unsupported JSON subtrees byte for byte", async () => {
  const root = fixture();
  const mod = join(root, "modules/catalog/module.ts");
  writeFileSync(mod, readFileSync(mod, "utf8").replace("}).strict()", "}).passthrough()"));
  const source = '{ "future": { "large": 1e+20, "escaped": "\\u0041", "nested": [null, {"odd": true}] }, "limit": 7 }\n';
  writeFileSync(join(root, "settings/catalog.json"), source);
  initializeGit(root); git(root, ["add", "settings/catalog.json"]); git(root, ["commit", "-m", "existing overrides"]);
  const snapshot = await settings(root);
  expect(snapshot.overrides.future.nested).toHaveLength(2);
  const noOp = await saveBody(root, structuredClone(snapshot.overrides), snapshot.revision);
  expect(noOp.body.changed).toBe(false);
  expect(readFileSync(join(root, "settings/catalog.json"), "utf8")).toBe(source);
  const preview = await saveBody(root, { ...snapshot.overrides, limit: 9 }, snapshot.revision, true);
  expect(preview.body.values.limit).toBe(9);
  expect(readFileSync(join(root, "settings/catalog.json"), "utf8")).toBe(source);
  expect(git(root, ["rev-list", "--count", "HEAD"])).toBe("2");
  const saved = await saveBody(root, { ...snapshot.overrides, limit: 9 }, snapshot.revision);
  expect(saved.body.changed).toBe(true);
  expect(readFileSync(join(root, "settings/catalog.json"), "utf8")).toContain('{ "large": 1e+20, "escaped": "\\u0041", "nested": [null, {"odd": true}] }');
});

test("simultaneous revision-guarded saves admit exactly one commit", async () => {
  const root = fixture(); initializeGit(root);
  const snapshot = await settings(root);
  const results = await Promise.all([saveBody(root, { limit: 7 }, snapshot.revision), saveBody(root, { limit: 9 }, snapshot.revision)]);
  expect(results.map((r) => r.code).sort()).toEqual([0, 1]);
  expect(results.find((r) => r.code === 1)!.body.status).toBe(409);
  const winner = results.find((r) => r.code === 0)!.body;
  expect(JSON.parse(readFileSync(join(root, "settings/catalog.json"), "utf8")).limit).toBe(winner.values.limit);
  expect(git(root, ["rev-list", "--count", "HEAD"])).toBe("2");
});

test("settings refuse aliases but a symlinked brain root still commits its own settings path", async () => {
  const root = fixture(); initializeGit(root);
  writeFileSync(join(root, "other.json"), '{"limit":8}\n');
  symlinkSync(join(root, "other.json"), join(root, "settings/catalog.json"));
  const denied = await runCli(root, ["module", "settings", "catalog", "--set", "limit=9", "--json"]);
  expect(denied.code).toBe(1);
  const list = await runCli(root, ["module", "list", "--json"]);
  expect(JSON.parse(list.stdout).enabled[0].error).toContain("without symlink aliases");
  expect(readFileSync(join(root, "other.json"), "utf8")).toBe('{"limit":8}\n');
  const real = fixture(); initializeGit(real);
  const alias = real + "-alias"; symlinkSync(real, alias); roots.push(alias);
  expect((await settings(alias, ["--set", "limit=9"])).changed).toBe(true);
  expect(git(real, ["show", "--pretty=", "--name-only", "HEAD"])).toBe("settings/catalog.json");
});

test("new schema fields are generated automatically and optional nested defaults remain absent", async () => {
  const root = fixture();
  const path = join(root, "modules/catalog/module.ts");
  writeFileSync(path, readFileSync(path, "utf8").replace("limit: z.number()", 'addedLater: z.string().default("Discovered"), optionalRecord: z.object({ on: z.boolean().default(true) }).optional(), limit: z.number()'));
  const snapshot = await settings(root);
  expect(snapshot.schema.properties.addedLater).toMatchObject({ type: "string", default: "Discovered" });
  expect(snapshot.values.addedLater).toBe("Discovered");
  expect(snapshot.inherited.optionalRecord).toBeUndefined();
  expect(snapshot.overrides).toEqual({});
});

test("malformed settings metadata fails loading without hiding the diagnostic", async () => {
  const root = fixture();
  const path = join(root, "modules/catalog/module.ts");
  writeFileSync(path, readFileSync(path, "utf8").replace('name: "catalog",', 'name: "catalog", settings: {fields: [{key:"limit",label:"Limit",kind:"invented"}]},'));
  const invalid = await runCli(root, ["validate", "--json"]);
  expect(invalid.code).toBe(1);
  expect(invalid.stderr + invalid.stdout).toContain("Invalid settings description");
});


test("a held transaction lock refuses a save before files or commits change", async () => {
  const root = fixture(); initializeGit(root);
  const lock = join(root, ".git/brain-module-settings.lock");
  mkdirSync(lock);
  try {
    const result = await runCli(root, ["module", "settings", "catalog", "--set", "limit=7", "--json"]);
    expect(JSON.parse(result.stdout).status).toBe(409);
    expect(existsSync(join(root, "settings/catalog.json"))).toBe(false);
    expect(git(root, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(existsSync(lock)).toBe(true);
  } finally { rmSync(lock, { recursive: true }); }
});

test("an initialized repository without an initial commit refuses saving before writes", async () => {
  const root = fixture();
  git(root, ["init", "--initial-branch=main"]);
  const result = await runCli(root, ["module", "settings", "catalog", "--set", "limit=7", "--json"]);
  expect(JSON.parse(result.stdout).status).toBe(422);
  expect(JSON.parse(result.stdout).error).toContain("initial brain");
  expect(existsSync(join(root, "settings/catalog.json"))).toBe(false);
  expect(git(root, ["status", "--porcelain"])).not.toContain("settings/catalog.json");
});
