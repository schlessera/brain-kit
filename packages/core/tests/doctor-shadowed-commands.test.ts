/**
 * `brain doctor`'s `shadowed-commands` check: a `.claude/commands/<name>.md`
 * file is dead when a skill has the same name, because Claude Code runs the
 * skill (https://code.claude.com/docs/en/skills).
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

/** A fixture brain whose MCP check passes from project config, so doctor never probes a host `claude`. */
function tempBrain(): string {
  const root = makeTempBrain();
  temps.push(root);
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } })
  );
  return root;
}

function command(root: string, rel: string): void {
  const file = join(root, ".claude", "commands", rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "Do the thing the old way.\n");
}

async function shadowedCheck(root: string) {
  const { stdout, code } = await runCli(root, ["doctor", "--json"]);
  expect(code).toBe(0);
  const check = JSON.parse(stdout).checks.find((c: { id: string }) => c.id === "shadowed-commands");
  expect(check).toBeDefined();
  return check as { status: string; detail: string; fix?: string };
}

test("a command file named like the core `add` skill warns and names it", async () => {
  const root = tempBrain();
  command(root, "add.md");
  command(root, "my-own.md");
  const check = await shadowedCheck(root);
  expect(check.status).toBe("warn");
  expect(check.detail).toContain(".claude/commands/add.md");
  expect(check.detail).not.toContain("my-own");
  expect(check.fix).toContain("the skill runs");
});

test("a repo-local skill shadows a command of its name too", async () => {
  const root = tempBrain();
  const skillDir = join(root, ".agents", "skills", "my-own");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: my-own\ndescription: Use when testing.\n---\n\nBody.\n");
  command(root, "my-own.md");
  const check = await shadowedCheck(root);
  expect(check.status).toBe("warn");
  expect(check.detail).toContain(".claude/commands/my-own.md");
});

test("a command no skill shares a name with passes", async () => {
  const root = tempBrain();
  command(root, "my-own.md");
  expect((await shadowedCheck(root)).status).toBe("pass");
});

test("a namespaced command is `/<dir>:<name>`, so the `add` skill does not shadow tools/add.md", async () => {
  const root = tempBrain();
  command(root, "tools/add.md");
  expect((await shadowedCheck(root)).status).toBe("pass");
});

test("no .claude/commands directory passes", async () => {
  const check = await shadowedCheck(tempBrain());
  expect(check.status).toBe("pass");
  expect(check.detail).toBe("no .claude/commands directory");
});
