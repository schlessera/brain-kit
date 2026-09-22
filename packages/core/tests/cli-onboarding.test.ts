/**
 * Onboarding CLI tests: init --check / --default, doctor, import --stamp,
 * skills lint (with a broken fixture skill), and config check.
 */

import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { installGitHooks } from "../src/cli/hooks-util";

const temps: string[] = [];
function tempBrain(opts: { empty?: boolean } = {}): string {
  const dir = makeTempBrain(opts);
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

test("JSON indexing preserves its stats envelope and reports skipped files on stderr", async () => {
  const root = tempBrain();
  writeFileSync(join(root, "notes", "broken.md"), '---\ntitle: "Unclosed\ntype: note\n---\nbody\n');
  const { stdout, stderr, code } = await runCli(root, ["index", "--json"]);
  expect(code).toBe(0);
  const stats = JSON.parse(stdout);
  expect(Object.keys(stats).sort()).toEqual([
    "added", "assets", "chunks", "deleted", "embeddings", "graphMs", "graphNodes", "total", "unchanged", "updated",
  ]);
  expect(stats.added).toBeGreaterThan(0);
  expect(stderr).toContain("notes/broken.md");
  expect(stderr).toContain("invalid frontmatter");
  expect(stdout).not.toContain("SKIP");
});

test("init --check emits the preflight shape", async () => {
  const root = tempBrain();
  const { stdout, code } = await runCli(root, ["init", "--check", "--json"]);
  expect(code).toBe(0);
  const p = JSON.parse(stdout);
  expect(typeof p.bun.ok).toBe("boolean");
  expect(typeof p.git.repo).toBe("boolean");
  expect(p.hooksPath).toHaveProperty("set");
  expect(p.config).toHaveProperty("exists");
  expect(p.config.valid).toBe(true); // fixture corpus has a valid config
  expect(Array.isArray(p.contentDirs.present)).toBe(true);
  // Keys are reported as booleans and never leak values.
  expect(typeof p.keys.GEMINI_API_KEY).toBe("boolean");
  expect(typeof p.keys.ANTHROPIC_API_KEY).toBe("boolean");
});

test("init --default in an empty dir, then doctor mostly-passes", async () => {
  const root = tempBrain({ empty: true });

  const init = await runCli(root, ["init", "--default", "--json"]);
  expect(init.code).toBe(0);
  const initOut = JSON.parse(init.stdout);
  expect(initOut.created).toContain("brain.config.json");
  expect(initOut.created).toContain("_index.md");
  expect(initOut.indexed.total).toBeGreaterThanOrEqual(1);
  expect(initOut.validation.errors).toBe(0);

  const doc = await runCli(root, ["doctor", "--json"]);
  expect(doc.code).toBe(0);
  const checks: Array<{ id: string; status: string }> = JSON.parse(doc.stdout).checks;
  const byId = Object.fromEntries(checks.map((c) => [c.id, c.status]));
  // The checks that init --default makes true must pass.
  expect(byId.config).toBe("pass");
  expect(byId.db).toBe("pass");
  // No check should be a hard fail after a clean default init.
  expect(checks.filter((c) => c.status === "fail")).toHaveLength(0);
});

test("init --default is idempotent (re-run creates nothing)", async () => {
  const root = tempBrain({ empty: true });
  await runCli(root, ["init", "--default", "--json"]);
  const again = await runCli(root, ["init", "--default", "--json"]);
  expect(again.code).toBe(0);
  expect(JSON.parse(again.stdout).created).toHaveLength(0);
});

test("import --stamp adds frontmatter to bare markdown", async () => {
  const root = tempBrain();
  const importDir = join(root, "import", "vault");
  mkdirSync(importDir, { recursive: true });
  writeFileSync(join(importDir, "note.md"), "# My Imported Note\n\nsome text\n");
  writeFileSync(join(importDir, "already.md"), "---\ntype: note\ntitle: Already\n---\nbody\n");

  const { stdout, code } = await runCli(root, ["import", "--stamp", "import/vault", "--json"]);
  expect(code).toBe(0);
  const out = JSON.parse(stdout);
  expect(out.stamped).toContain("note.md");
  expect(out.skipped).toContain("already.md");

  const stamped = readFileSync(join(importDir, "note.md"), "utf-8");
  expect(stamped.startsWith("---")).toBe(true);
  expect(stamped).toContain("title: My Imported Note");
  expect(stamped).toContain("status: draft");
});

test("skills lint fails on a broken fixture skill", async () => {
  const root = tempBrain();
  const skillDir = join(root, ".agents", "skills", "broken-skill");
  mkdirSync(skillDir, { recursive: true });
  // Unquoted colon-space in a value → invalid YAML frontmatter.
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: broken-skill\ndescription: Do a thing: with an unquoted colon\n---\nbody\n"
  );

  const { stdout, code } = await runCli(root, ["skills", "lint", "--json"]);
  expect(code).toBe(1);
  const out = JSON.parse(stdout);
  expect(out.errors).toBeGreaterThan(0);
  expect(out.findings.some((f: { severity: string }) => f.severity === "error")).toBe(true);
});

test("config check reports valid config + effective taxonomy", async () => {
  const root = tempBrain();
  const { stdout, code } = await runCli(root, ["config", "check", "--json"]);
  expect(code).toBe(0);
  const out = JSON.parse(stdout);
  expect(out.valid).toBe(true);
  expect(out.taxonomy.types).toHaveProperty("identity");
  expect(out.taxonomy.types).toHaveProperty("health"); // fixture-specific type
  expect(out.taxonomy.inbox).toBe("note");
});

test("mutating commands refuse to run without a brain.config", async () => {
  const root = tempBrain({ empty: true });

  for (const cmd of [["index"], ["add", "some text"], ["sync"]]) {
    const { code, stderr } = await runCli(root, cmd);
    expect(code).toBe(1);
    expect(stderr).toContain("refusing to modify an uninitialized directory");
  }
  // No brain.db side effect from the refused index.
  expect(existsSync(join(root, "brain.db"))).toBe(false);

  // Read-only and onboarding commands still run.
  const doctor = await runCli(root, ["doctor", "--json"]);
  expect(doctor.code).toBe(0);
});

test("graph compute refuses without a brain.config; its readers behave like other readers", async () => {
  const root = tempBrain({ empty: true });

  // compute opens the database writable, so it is gated like `index`.
  const compute = await runCli(root, ["graph", "compute"]);
  expect(compute.code).toBe(1);
  expect(compute.stderr).toContain("refusing to modify an uninitialized directory");

  // export/stats only read, so they fail the way `list`/`stats` do.
  for (const cmd of [["graph", "stats"], ["graph", "export", "--mode", "clusters"]]) {
    const { code, stderr } = await runCli(root, cmd);
    expect(code).toBe(1);
    expect(stderr).toContain("Database not found");
  }

  // Nothing wrote a database into the uninitialized directory.
  expect(existsSync(join(root, "brain.db"))).toBe(false);
});

test("skills sync and setup also refuse to run without a brain.config", async () => {
  const root = tempBrain({ empty: true });
  for (const cmd of [["skills", "sync"], ["setup"]]) {
    const { code, stderr } = await runCli(root, cmd);
    expect(code).toBe(1);
    expect(stderr).toContain("refusing to modify an uninitialized directory");
  }
  // No side-effect directories were created by the refused commands.
  expect(existsSync(join(root, ".agents"))).toBe(false);
  expect(existsSync(join(root, ".claude"))).toBe(false);
});

test("setup hook installation throws before setting hooksPath when packaged hooks are missing", () => {
  const root = tempBrain();
  expect(Bun.spawnSync(["git", "init", "--quiet"], { cwd: root }).exitCode).toBe(0);

  const missingHooks = join(root, "missing-packaged-hooks");
  expect(() => installGitHooks(root, missingHooks)).toThrow(
    `Packaged hooks directory does not exist: ${missingHooks}`
  );

  const configured = Bun.spawnSync(
    ["git", "-C", root, "config", "--get", "core.hooksPath"]
  );
  expect(configured.exitCode).not.toBe(0);
  expect(existsSync(join(root, ".githooks"))).toBe(false);
});

test("doctor requires a real hook file under core.hooksPath", async () => {
  const root = tempBrain();
  expect(Bun.spawnSync(["git", "init", "--quiet"], { cwd: root }).exitCode).toBe(0);
  // Satisfy the MCP check via project config so doctor never falls through to
  // probing a host `claude` CLI (slow or absent depending on the machine).
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } })
  );
  const installed = installGitHooks(root);
  expect(installed.hooks.length).toBeGreaterThan(0);

  const healthy = await runCli(root, ["doctor", "--json"]);
  const healthyCheck = JSON.parse(healthy.stdout).checks.find(
    (check: { id: string }) => check.id === "git-hooks"
  );
  expect(healthyCheck.status).toBe("pass");

  for (const hook of readdirSync(join(root, ".githooks"))) {
    rmSync(join(root, ".githooks", hook));
  }
  const wiped = await runCli(root, ["doctor", "--json"]);
  const wipedCheck = JSON.parse(wiped.stdout).checks.find(
    (check: { id: string }) => check.id === "git-hooks"
  );
  expect(wipedCheck.status).toBe("fail");
  expect(wipedCheck.detail).toContain("contains no hook files");
});

test("doctor reports a dead MCP source-file registration", async () => {
  const root = tempBrain();
  const deadPath = "defunct-node-modules/old-scope/core/src/mcp-server.ts";
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        brain: { command: "bun", args: [deadPath] },
      },
    })
  );

  const result = await runCli(root, ["doctor", "--json"]);
  const mcp = JSON.parse(result.stdout).checks.find(
    (check: { id: string }) => check.id === "mcp"
  );
  expect(mcp.status).toBe("fail");
  expect(mcp.detail).toContain(deadPath);

  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] },
      },
    })
  );
  const current = await runCli(root, ["doctor", "--json"]);
  const currentMcp = JSON.parse(current.stdout).checks.find(
    (check: { id: string }) => check.id === "mcp"
  );
  expect(currentMcp.status).toBe("pass");
});

/**
 * `brain init --check`'s `config.initialized` is what /brain-init branches on.
 * It has to distinguish the template's starter config — a teaching file with
 * every field commented out, which parses to `{}` — from a brain somebody has
 * actually configured. Testing the file's existence instead sent every new
 * user into amend mode (#74).
 */
test("init --check reports the template's empty starter config as not initialized", async () => {
  const root = tempBrain({ empty: true });
  // Byte-for-byte what template/brain.config.ts amounts to once parsed.
  writeFileSync(
    join(root, "brain.config.ts"),
    'import { defineConfig } from "@schlessera/brain";\n\nexport default defineConfig({\n  // profile: { name: "Your Name" },\n});\n'
  );
  const { stdout, code } = await runCli(root, ["init", "--check", "--json"]);
  expect(code).toBe(0);
  const p = JSON.parse(stdout);
  expect(p.config.exists).toBe(true);
  expect(p.config.valid).toBe(true);
  expect(p.config.initialized).toBe(false);
});

test("init --check reports a configured brain as initialized", async () => {
  // The fixture corpus is a fully personalized brain: profile, custom types.
  const { stdout, code } = await runCli(tempBrain(), ["init", "--check", "--json"]);
  expect(code).toBe(0);
  const p = JSON.parse(stdout);
  expect(p.config.exists).toBe(true);
  expect(p.config.initialized).toBe(true);
});

test("init --check reports one declared key as enough to be initialized", async () => {
  // Not a list of fields that count: anything the user declared counts, so the
  // next field added to the schema needs no change here.
  const root = tempBrain({ empty: true });
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ profile: { name: "A" } }));
  const p = JSON.parse((await runCli(root, ["init", "--check", "--json"])).stdout);
  expect(p.config.initialized).toBe(true);
});

test("init --check reports no config at all as neither existing nor initialized", async () => {
  const root = tempBrain({ empty: true });
  const p = JSON.parse((await runCli(root, ["init", "--check", "--json"])).stdout);
  expect(p.config.exists).toBe(false);
  expect(p.config.initialized).toBe(false);
});

test("init --check reports a broken config as existing, invalid and not initialized", async () => {
  const root = tempBrain({ empty: true });
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ taxonomy: { types: 7 } }));
  const p = JSON.parse((await runCli(root, ["init", "--check", "--json"])).stdout);
  expect(p.config.exists).toBe(true);
  expect(p.config.valid).toBe(false);
  expect(p.config.initialized).toBe(false);
  expect(typeof p.config.error).toBe("string");
});

test("the brain-init skill branches on initialized, not on the config file existing", () => {
  // The skill is the only consumer of this field, and the bug was one word in
  // it. Prose drifts; this does not.
  const skill = readFileSync(
    join(import.meta.dir, "../skills/brain-init/SKILL.md"),
    "utf8"
  );
  expect(skill).toContain("config.initialized");
  expect(skill).toContain("never on `config.exists`");
});
