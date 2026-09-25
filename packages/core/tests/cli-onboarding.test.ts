/**
 * Onboarding CLI tests: init --check / --default, doctor, import --stamp,
 * skills lint (with a broken fixture skill), and config check.
 */

import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";
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

/** A git brain with the packaged hooks installed and the MCP check satisfied from project config. */
function hookedBrain(): string {
  const root = tempBrain();
  expect(Bun.spawnSync(["git", "init", "--quiet"], { cwd: root }).exitCode).toBe(0);
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } })
  );
  expect(installGitHooks(root).hooks.length).toBeGreaterThan(0);
  return root;
}

async function gitHooksCheck(root: string, args: string[] = []) {
  const { stdout, code } = await runCli(root, ["doctor", "--json", ...args]);
  expect(code).toBe(0);
  const out = JSON.parse(stdout);
  return { check: out.checks.find((c: { id: string }) => c.id === "git-hooks"), fixesApplied: out.fixesApplied };
}

test("doctor warns when an installed hook is an older copy, and --fix replaces it", async () => {
  const root = hookedBrain();
  const hook = join(root, ".githooks", "post-commit");
  const current = readFileSync(hook, "utf8");
  writeFileSync(hook, current.replace(/\n$/, "") + "\n# an older release's post-commit\n");

  const stale = await gitHooksCheck(root);
  expect(stale.check.status).toBe("warn");
  expect(stale.check.detail).toBe("hooks in .githooks differ from the packaged ones: post-commit");
  expect(stale.check.fix).toContain("brain doctor --fix");

  const fixed = await gitHooksCheck(root, ["--fix"]);
  expect(fixed.fixesApplied).toContain("git-hooks");
  expect(fixed.check.status).toBe("pass");
  expect(readFileSync(hook, "utf8")).toBe(current);
});

test("doctor names a packaged hook the install lacks", async () => {
  const root = hookedBrain();
  rmSync(join(root, ".githooks", "post-merge"));
  const { check } = await gitHooksCheck(root);
  expect(check).toMatchObject({ status: "warn", detail: "hooks in .githooks missing: post-merge" });
});

test("an up-to-date hook install passes", async () => {
  const { check } = await gitHooksCheck(hookedBrain());
  expect(check.status).toBe("pass");
  expect(check.detail).toContain("matching the packaged ones");
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
 * /brain-init Stage 5 registers the MCP server only when `brain doctor
 * --json`'s `mcp` check (`checkMcp`, `packages/core/src/cli/commands/doctor.ts:410-449`)
 * does not pass. The template's `.mcp.json` already declares the server, so an
 * unconditional `claude mcp add` gave every new brain a second, local-scope
 * `brain` server beside the project one (#337).
 */
function mcpCheck(stdout: string): { status: string; detail: string } {
  return JSON.parse(stdout).checks.find((check: { id: string }) => check.id === "mcp");
}

test("doctor's mcp check does not pass when nothing registers the server", async () => {
  const root = tempBrain();
  // No project .mcp.json, an empty home (no ~/.claude.json), and a `claude`
  // on PATH whose `mcp list` names no server: every source checkMcp reads is
  // present and says no.
  const home = join(root, ".home");
  const shimDir = join(root, ".shim");
  mkdirSync(home, { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const proc = Bun.spawn(["bun", BRAIN_BIN, "doctor", "--json"], {
    env: { ...keylessEnv(root), HOME: home, PATH: `${shimDir}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  expect(existsSync(join(root, ".mcp.json"))).toBe(false);
  expect(mcpCheck(stdout).status).not.toBe("pass");
});

/** Stage 5's MCP step of the brain-init skill, split into what an agent acts on. */
function brainInitMcpStep() {
  const skill = readFileSync(join(import.meta.dir, "../skills/brain-init/SKILL.md"), "utf8");
  const stage5 = skill.slice(skill.indexOf("## Stage 5"), skill.indexOf("## Stage 6"));
  const step = stage5.slice(stage5.search(/^5\. /m));
  const lines = step.split("\n");
  // Top-level bullets of the step, each running until the next line at the
  // step's own indent: another bullet or a paragraph.
  const bullets: string[] = [];
  lines.forEach((line, i) => {
    if (!/^ {3}- /.test(line)) return;
    let j = i + 1;
    while (j < lines.length && !/^ {3}\S/.test(lines[j])) j++;
    bullets.push(lines.slice(i, j).join("\n"));
  });
  return { step, bullets };
}

/** Commands inside fenced code blocks: what an agent runs, not what prose names. */
function fencedCommands(text: string): string[] {
  return [...text.matchAll(/```\w*\n([\s\S]*?)```/g)].flatMap((m) =>
    m[1].split("\n").map((l) => l.trim()).filter(Boolean)
  );
}

test("the brain-init skill decides MCP registration on doctor's mcp check", () => {
  const { step } = brainInitMcpStep();
  expect(step.length).toBeGreaterThan(0);
  expect(fencedCommands(step)).toContain("brain doctor --json");
  // Every check id the step names is `mcp`: reading another check's status
  // (`db`, `hooks`) would branch on something unrelated to registration.
  const ids = [...step.matchAll(/`id` is `"([^"]+)"`/g)].map((m) => m[1]);
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids)).toEqual(new Set(["mcp"]));
});

test("the brain-init skill runs claude mcp add only when doctor's mcp check does not pass", () => {
  const { step, bullets } = brainInitMcpStep();
  const passIdx = bullets.findIndex((b) => b.split("\n")[0].includes('"pass"'));
  expect(passIdx).toBeGreaterThan(-1);
  const isAdd = (c: string) => /^claude mcp add\b/.test(c);
  // On pass, nothing to run: the project .mcp.json already declares the server.
  expect(fencedCommands(bullets[passIdx]).filter(isAdd)).toEqual([]);
  // The branch after it is the non-pass one, and it carries the command.
  const other = bullets[passIdx + 1] ?? "";
  expect(fencedCommands(other).filter(isAdd)).toEqual([
    "claude mcp add brain -- bun node_modules/.bin/brain mcp",
  ]);
  // And nowhere before the verification runs it outside that branch.
  const beforeVerify = step.slice(0, step.search(/brain_read/));
  expect(fencedCommands(beforeVerify).filter(isAdd)).toEqual(fencedCommands(other).filter(isAdd));
});

test("the brain-init skill re-registers at project scope when the tools do not serve this brain", () => {
  // A pass means registered somewhere, not serving this brain: a user-scope
  // `brain` for another brain passes too. So the step must verify against
  // this repo's own note and fall back to registering here when that fails.
  const { step } = brainInitMcpStep();
  const verify = step.search(/brain_read[^\n]*`me\/identity\.md`/);
  expect(verify).toBeGreaterThan(-1);
  expect(step).toMatch(/restart or an approval is\s+not success/);
  const fallback = fencedCommands(step.slice(verify)).filter((c) =>
    /^claude mcp add --scope project brain\b/.test(c)
  );
  expect(fallback).toEqual(["claude mcp add --scope project brain -- bun node_modules/.bin/brain mcp"]);
});

/**
 * The pre-commit hook runs tests whenever the staged change touches
 * `brain.config.*`, which is exactly what /brain-init's single commit does.
 * `bun test` errors rather than passing when a brain has no test files, so
 * that commit — the interview's own revert point — was rejected on every
 * brand-new brain (#75).
 *
 * Driven through a real `git commit` rather than by reading the script: the
 * bug lived in how sh and bun compose, which no predicate test would have
 * seen.
 */
function gitBrainWithHooks(): { root: string; shimDir: string } {
  const root = tempBrain({ empty: true });
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "test@example.invalid"],
    ["config", "user.name", "Test"],
    ["config", "commit.gpgsign", "false"],
  ]) {
    const done = Bun.spawnSync(["git", "-C", root, ...args]);
    if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  }
  installGitHooks(root);

  // The hook resolves the brain CLI from PATH and exits 0 outright when it
  // finds none — which would make every assertion below vacuous. A stub that
  // always validates clean puts the hook on the path under test.
  const shimDir = join(root, ".shim");
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, "brain"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { root, shimDir };
}

function commit(root: string, shimDir: string, message: string) {
  const proc = Bun.spawnSync(["git", "-C", root, "commit", "-q", "-m", message], {
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
  });
  return {
    code: proc.exitCode,
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

test("pre-commit lets the first brain.config.ts commit through when the brain has no tests", () => {
  const { root, shimDir } = gitBrainWithHooks();
  writeFileSync(join(root, "brain.config.ts"), "export default {};\n");
  Bun.spawnSync(["git", "-C", root, "add", "-A"]);

  const { code, stderr } = commit(root, shimDir, "brain-init: personalized structure");
  expect(stderr).toContain("no tests in this brain");
  expect(stderr).not.toContain("tests failed");
  expect(code).toBe(0);
});

test("pre-commit still rejects that commit when the brain has a failing test", () => {
  const { root, shimDir } = gitBrainWithHooks();
  writeFileSync(join(root, "brain.config.ts"), "export default {};\n");
  writeFileSync(
    join(root, "regression.test.ts"),
    'import { expect, test } from "bun:test";\ntest("fails", () => {\n  expect(1).toBe(2);\n});\n'
  );
  Bun.spawnSync(["git", "-C", root, "add", "-A"]);

  const { code, stderr } = commit(root, shimDir, "brain-init: personalized structure");
  expect(stderr).toContain("tests failed");
  expect(stderr).not.toContain("no tests in this brain");
  expect(code).not.toBe(0);
});

test("pre-commit lets it through when the brain's tests pass", () => {
  const { root, shimDir } = gitBrainWithHooks();
  writeFileSync(join(root, "brain.config.ts"), "export default {};\n");
  writeFileSync(
    join(root, "regression.test.ts"),
    'import { expect, test } from "bun:test";\ntest("passes", () => {\n  expect(1).toBe(1);\n});\n'
  );
  Bun.spawnSync(["git", "-C", root, "add", "-A"]);

  const { code, stderr } = commit(root, shimDir, "brain-init: personalized structure");
  expect(stderr).not.toContain("tests failed");
  expect(code).toBe(0);
});

test("the hook does not decide by parsing bun's output", () => {
  // bun 1.3.14 says "0 test files matching …" on one machine and "No tests
  // found!" on another. The first version of this fix read that prose and
  // passed locally, then failed on CI. Its wording is not an interface.
  const code = readFileSync(join(import.meta.dir, "../src/hooks/pre-commit"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line)) // the comments quote both, on purpose
    .join("\n");
  expect(code).not.toContain("0 test files matching");
  expect(code).not.toContain("No tests found");
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

/** A PATH holding only `bun`: no git, no sh, nothing else. */
function bunOnlyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-bun-only-"));
  temps.push(dir);
  symlinkSync(process.execPath, join(dir, "bun"));
  return dir;
}

test("doctor without git on PATH still prints every check, with git-hooks naming the missing binary", async () => {
  const root = tempBrain();
  const { stdout, stderr, code } = await runCli(root, ["doctor", "--json"], { PATH: bunOnlyPath() });
  expect(code, stderr).toBe(0);
  const checks = JSON.parse(stdout).checks as { id: string; status: string; detail: string }[];
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  expect(byId["git-hooks"]).toMatchObject({ status: "warn", detail: "git is not installed or not on PATH" });
  expect(byId["runtime"]?.status).toBe("pass");
  expect(byId["config"]?.status).toBe("pass");
  expect(byId["db"]).toBeDefined();
  expect(byId["privacy"]?.detail).toContain("git is not installed");
  expect(byId["scratch"]?.detail).toContain("git is not installed");
  // Every check answered for itself; none fell back to the crash guard.
  expect(checks.filter((c) => c.detail.startsWith("the check itself failed"))).toEqual([]);
  expect(checks.map((c) => c.id)).toEqual([
    "runtime", "git-hooks", "symlinks", "shadowed-commands", "instructions-weight", "config", "db",
    "embeddings", "mcp", "deps", "version", "privacy", "git-storage", "scratch", "cache-merge", "sqlite-vec-macos",
  ]);
});

/** PATH with only `bun`, and a throwaway HOME and bin directory, so setup's bin links land nowhere real. */
function noGitEnv(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), "brain-home-"));
  temps.push(home);
  return { PATH: bunOnlyPath(), HOME: home, XDG_BIN_HOME: join(home, "bin") };
}

test("doctor --fix and brain setup without git on PATH finish and say why hooks were skipped", async () => {
  const root = tempBrain();
  // A git repository, so the only reason to skip is the missing binary.
  mkdirSync(join(root, ".git"));
  const env = noGitEnv();
  const fix = await runCli(root, ["doctor", "--fix", "--json"], env);
  expect(fix.code, fix.stderr).toBe(0);
  expect(JSON.parse(fix.stdout).fixesApplied).not.toContain("git-hooks");
  const setup = await runCli(root, ["setup", "--json"], env);
  expect(setup.code, setup.stderr).toBe(0);
  expect(JSON.parse(setup.stdout).warnings).toContain("git is not installed or not on PATH — skipped git hooks");
  const human = await runCli(root, ["setup", "--human"], env);
  expect(human.code, human.stderr).toBe(0);
  expect(human.stdout).toContain("  git hooks:  skipped (git is not installed or not on PATH)");
});

// Review round 1: containment is proven through the command, not the helper.
test("a check that throws becomes a warn, and every later check still reports", async () => {
  const root = tempBrain();
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } }));
  // A file where the scratch directory's parent should be: mkdir throws ENOTDIR inside the check.
  writeFileSync(join(root, ".brain"), "not a directory\n");
  const { stdout, stderr, code } = await runCli(root, ["doctor", "--json"]);
  expect(code, stderr).toBe(0);
  const checks = JSON.parse(stdout).checks as { id: string; status: string; detail: string }[];
  const scratch = checks.find((c) => c.id === "scratch");
  expect(scratch?.status).toBe("warn");
  expect(scratch?.detail).toStartWith("the check itself failed: ENOTDIR");
  expect(checks.map((c) => c.id).slice(-2)).toEqual(["cache-merge", "sqlite-vec-macos"]);

  const fix = await runCli(root, ["doctor", "--fix", "--json"]);
  expect(fix.code, fix.stderr).toBe(0);
  expect(fix.stderr).toContain("doctor --fix: scratch fix failed: ENOTDIR");
});
