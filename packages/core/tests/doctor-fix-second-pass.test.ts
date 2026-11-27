/**
 * `brain doctor --fix` re-runs only the checks an attempted fix can change
 * (#4794). Counting `gh` and `claude` stubs show the network and agent probes
 * run once when no fix can change their answer and twice when one can, and
 * the checks it prints equal a plain `brain doctor` run straight afterwards.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";
import { git } from "./git-fixture";

type Check = { id: string; status: string; detail: string; fix?: string };
const temps: string[] = [];
afterEach(() => {
  while (temps.length) {
    const dir = temps.pop()!;
    cleanup(dir);
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A git brain with an `origin` remote whose scratch area is not ignored, so the scratch fix runs. */
function brainWithRemote(): string {
  const root = makeTempBrain();
  temps.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", "https://example.invalid/ithaca/voyage.git");
  return root;
}

/**
 * `gh` and `claude` stubs that append their argv to a log. `claude mcp list`
 * names `brain` from the start, or (`registeredAfterAdd`) only once
 * `claude mcp add` has run.
 */
function stubs(registeredAfterAdd: boolean): { bin: string; log: string } {
  const bin = tempDir("brain-doctor-stubs-");
  const log = join(bin, "calls.log");
  const registered = join(bin, "registered");
  if (!registeredAfterAdd) writeFileSync(registered, "");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf 'gh %s\\n' "$*" >> '${log}'\nprintf '{"visibility":"PRIVATE"}\\n'\n`);
  writeFileSync(join(bin, "claude"), [
    "#!/bin/sh",
    `printf 'claude %s\\n' "$*" >> '${log}'`,
    `if [ "$1 $2" = "mcp add" ]; then : > '${registered}'; fi`,
    `if [ "$1 $2" = "mcp list" ] && [ -e '${registered}' ]; then printf 'brain: bun node_modules/.bin/brain mcp - connected\\n'; fi`,
    "",
  ].join("\n"));
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "claude"), 0o755);
  return { bin, log };
}

const calls = (log: string, prefix: string) =>
  (existsSync(log) ? readFileSync(log, "utf8").split("\n") : []).filter((line) => line.startsWith(prefix));

async function doctor(root: string, flags: string[], env: Record<string, string> = {}): Promise<{ checks: Check[]; fixesApplied?: string[] }> {
  const result = await runCli(root, ["doctor", "--json", ...flags], env);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

test("doctor --fix asks gh and claude once when no attempted fix can change their answer", async () => {
  const root = brainWithRemote();
  const { bin, log } = stubs(false);
  const env = { PATH: `${bin}:${keylessEnv(root).PATH}` };
  const before = await doctor(root, [], env);
  expect(before.checks.find((c) => c.id === "scratch")?.status).not.toBe("pass");
  expect(before.checks.find((c) => c.id === "mcp")?.status).toBe("pass");
  rmSync(log, { force: true });

  const fixed = await doctor(root, ["--fix"], env);
  expect(fixed.fixesApplied).toContain("scratch");
  expect(fixed.checks.find((c) => c.id === "scratch")?.status).toBe("pass");
  expect(calls(log, "gh ")).toEqual(["gh repo view --json visibility"]);
  expect(calls(log, "claude ")).toEqual(["claude mcp list"]);
});

test("doctor --fix re-runs the mcp check after the mcp fix registers the server", async () => {
  const root = brainWithRemote();
  const { bin, log } = stubs(true);
  const env = { PATH: `${bin}:${keylessEnv(root).PATH}` };
  const fixed = await doctor(root, ["--fix"], env);
  expect(fixed.fixesApplied).toContain("mcp");
  expect(calls(log, "claude mcp list")).toHaveLength(2);
  expect(calls(log, "claude mcp add")).toHaveLength(1);
  expect(fixed.checks.find((c) => c.id === "mcp")?.status).toBe("pass");
  expect(calls(log, "gh ")).toHaveLength(1);
});

const states: [string, string, (root: string) => Promise<void>][] = [
  ["scratch not ignored", "scratch", async (root) => {
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  }],
  ["index missing", "db", async (root) => {
    expect(existsSync(join(root, ".brain-index", "brain.db"))).toBe(false);
  }],
  ["a legacy cache file in the brain root", "legacy-caches", async (root) => {
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    writeFileSync(join(root, ".context-cache.jsonl"), '{"k":"oar","v":"from Ithaca"}\n');
  }],
];

for (const [name, fix, prepare] of states) {
  test(`doctor --fix prints the checks a fresh doctor run reports afterwards: ${name}`, async () => {
    const root = makeTempBrain();
    temps.push(root);
    git(root, "init", "-q", "-b", "main");
    await prepare(root);
    const fixed = await doctor(root, ["--fix"]);
    expect(fixed.fixesApplied).toContain(fix);
    const fresh = await doctor(root, []);
    expect(fixed.checks).toEqual(fresh.checks);
  }, 60_000);
}

const check = (checks: Check[], id: string) => checks.find((c) => c.id === id);

test("doctor --fix re-runs the mcp check after the symlinks fix restores the file a registration names (#4885)", async () => {
  const root = makeTempBrain();
  temps.push(root);
  git(root, "init", "-q", "-b", "main");
  // A local skill whose `.claude/skills` link dangles, and a project
  // registration naming a script reached through that link.
  mkdirSync(join(root, ".agents", "skills", "harbour", "scripts"), { recursive: true });
  writeFileSync(join(root, ".agents", "skills", "harbour", "SKILL.md"), "---\nname: harbour\ndescription: Moor the ship in Ithaca's harbour.\n---\n\nMoor the ship.\n");
  writeFileSync(join(root, ".agents", "skills", "harbour", "scripts", "serve.ts"), "// The harbour master's MCP server.\n");
  mkdirSync(join(root, ".claude", "skills"), { recursive: true });
  symlinkSync("../../.agents/skills/scheria", join(root, ".claude", "skills", "harbour"));
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { brain: { command: "bun", args: [".claude/skills/harbour/scripts/serve.ts"] } } }));
  const before = await doctor(root, []);
  expect(check(before.checks, "symlinks")?.status).toBe("warn");
  expect(check(before.checks, "mcp")?.status).toBe("fail");

  const fixed = await doctor(root, ["--fix"]);
  expect(fixed.fixesApplied).toContain("symlinks");
  expect(fixed.fixesApplied).not.toContain("mcp");
  const fresh = await doctor(root, []);
  expect(check(fresh.checks, "mcp")?.status).toBe("pass");
  expect(fixed.checks).toEqual(fresh.checks);
}, 60_000);

test("doctor --fix re-runs the git checks after the deps fix runs the brain's install scripts (#4885)", async () => {
  const root = makeTempBrain();
  temps.push(root);
  // No node_modules, so the deps fix runs `bun install`. The test network
  // guard keeps a real install out of tests, so a `bun` stub stands in for
  // one whose postinstall stages a tool leftover and a chart (new loose
  // objects and index entries); every other `bun` call runs the real one.
  rmSync(join(root, "node_modules"));
  git(root, "init", "-q", "-b", "main");
  const bin = tempDir("brain-doctor-install-");
  writeFileSync(join(bin, "bun"), [
    "#!/bin/sh",
    `for last; do :; done`,
    `if [ "$last" = install ]; then '${Bun.which("mkdir")}' node_modules && printf 'Finder' > .DS_Store && printf 'chart' > aegean.png && exec git add .DS_Store aegean.png; fi`,
    `exec '${process.execPath}' "$@"`,
    "",
  ].join("\n"));
  chmodSync(join(bin, "bun"), 0o755);
  const env = { PATH: `${bin}:${keylessEnv(root).PATH}` };
  const before = await doctor(root, [], env);
  expect(check(before.checks, "deps")?.status).toBe("warn");
  expect(check(before.checks, "tracked-leftovers")?.status).toBe("pass");

  const fixed = await doctor(root, ["--fix"], env);
  expect(fixed.fixesApplied).toContain("deps");
  const fresh = await doctor(root, [], env);
  expect(check(fresh.checks, "tracked-leftovers")?.detail).toBe("1 committed tool leftover(s): .DS_Store");
  expect(check(fresh.checks, "tracked-media")?.detail).toContain("aegean.png");
  expect(fixed.checks).toEqual(fresh.checks);
}, 60_000);
