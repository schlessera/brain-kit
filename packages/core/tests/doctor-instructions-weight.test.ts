/**
 * `brain doctor`'s `instructions-weight` check: what every session pays for
 * before any work starts — CLAUDE.md with its `@` imports, AGENTS.md, and the
 * description of every model-invocable skill — against
 * `instructions.maxTokens` (default 8000), estimated as characters / 4.
 */

import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const REPO = resolve(import.meta.dir, "../../..");
const temps: string[] = [];
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

const MCP = JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } });

/** The fixture corpus, with the MCP check satisfied so doctor never probes a host `claude`. */
function corpusBrain(): string {
  const root = makeTempBrain();
  temps.push(root);
  writeFileSync(join(root, ".mcp.json"), MCP);
  return root;
}

/** A brain exactly as `template/` generates it, with the repo's packages installed. */
function templateBrain(): string {
  const root = mkdtempSync(join(tmpdir(), "brain-template-"));
  temps.push(root);
  cpSync(join(REPO, "template"), root, { recursive: true });
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  return root;
}

async function weightCheck(root: string) {
  const { stdout, code } = await runCli(root, ["doctor", "--json"]);
  expect(code).toBe(0);
  const check = JSON.parse(stdout).checks.find((c: { id: string }) => c.id === "instructions-weight");
  expect(check).toBeDefined();
  return check as { status: string; detail: string; fix?: string };
}

test("a 40,000-character CLAUDE.md warns and names CLAUDE.md among the largest", async () => {
  const root = corpusBrain();
  writeFileSync(join(root, "CLAUDE.md"), "Rule.\n".repeat(40_000 / 6));
  const check = await weightCheck(root);
  expect(check.status).toBe("warn");
  expect(check.detail).toMatch(/largest: CLAUDE\.md \(\d+\)/);
  expect(check.fix).toContain("instructions.maxTokens");
});

test("a brain generated from template/ passes, and counts the imported contract", async () => {
  const check = await weightCheck(templateBrain());
  expect(check.status).toBe("pass");
  expect(check.detail).toContain("CLAUDE.md ");
  expect(check.detail).toContain("node_modules/@schlessera/brain/CONTRACT.md ");
  expect(check.detail).toMatch(/[1-9]\d* skill description\(s\)/);
});

test("instructions.maxTokens set lower flips a template-sized brain to warn", async () => {
  const root = templateBrain();
  rmSync(join(root, "brain.config.ts"));
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ instructions: { maxTokens: 500 } }));
  const check = await weightCheck(root);
  expect(check.status).toBe("warn");
  expect(check.detail).toContain("over the 500 limit");
});

test("a manual-only skill's description does not count", async () => {
  const root = corpusBrain();
  const big = "Use when " + "the task is long and detailed. ".repeat(1_200);
  for (const [name, manual] of [["big-manual", true], ["big-auto", false]] as const) {
    const dir = join(root, ".agents", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${JSON.stringify(big)}\n${manual ? "disable-model-invocation: true\n" : ""}---\n\nBody.\n`
    );
  }
  const withBoth = await weightCheck(root);
  expect(withBoth.status).toBe("warn");
  expect(withBoth.detail).toContain("skill big-auto (");
  expect(withBoth.detail).not.toContain("big-manual");

  rmSync(join(root, ".agents", "skills", "big-auto"), { recursive: true });
  expect((await weightCheck(root)).status).toBe("pass");
});

test("an import outside the brain, or in a code span, is not counted", async () => {
  const root = corpusBrain();
  const outside = mkdtempSync(join(tmpdir(), "brain-outside-"));
  temps.push(outside);
  writeFileSync(join(outside, "huge.md"), "x".repeat(80_000));
  writeFileSync(join(root, "inside.md"), "x".repeat(80_000));
  writeFileSync(
    join(root, "CLAUDE.md"),
    `@../${outside.split("/").pop()}/huge.md\n@${join(outside, "huge.md")}\nSee \`@inside.md\` for the syntax.\n`
  );
  const check = await weightCheck(root);
  expect(check.status).toBe("pass");
  expect(check.detail).not.toContain("huge.md");
  expect(check.detail).not.toContain("inside.md");
});
