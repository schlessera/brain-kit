/**
 * `brain doctor`'s `instructions-weight` check: what every session pays for
 * before any work starts — CLAUDE.md with its `@` imports, AGENTS.md, and the
 * description of every model-invocable skill — against
 * `instructions.maxTokens` (default 8000), estimated as characters / 4.
 */

import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { estimateTokens } from "../src/lib/context-assembler";
import { discoverSkills } from "../src/lib/skills/discover";

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

/**
 * A brain exactly as `template/` generates it, with the repo's packages
 * installed. `node_modules/@schlessera/brain` is a real directory holding a
 * real copy of CONTRACT.md, as an npm install leaves it, so the import
 * resolves inside the brain; everything else links back to the repo.
 */
function templateBrain(): string {
  const root = mkdtempSync(join(tmpdir(), "brain-template-"));
  temps.push(root);
  cpSync(join(REPO, "template"), root, { recursive: true });
  const linkAllBut = (from: string, to: string, except: string) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      if (entry !== except) symlinkSync(join(from, entry), join(to, entry));
    }
  };
  linkAllBut(join(REPO, "node_modules"), join(root, "node_modules"), "@schlessera");
  linkAllBut(join(REPO, "node_modules", "@schlessera"), join(root, "node_modules", "@schlessera"), "brain");
  const core = join(REPO, "packages", "core");
  linkAllBut(core, join(root, "node_modules", "@schlessera", "brain"), "CONTRACT.md");
  cpSync(join(core, "CONTRACT.md"), join(root, "node_modules", "@schlessera", "brain", "CONTRACT.md"));
  return root;
}

/** `name tokens` pairs from a detail's contributor list, which follows the first colon. */
function listed(detail: string): Map<string, number> {
  const list = detail.slice(detail.indexOf(detail.includes("All: ") ? "All: " : ": ") + 2).split(". ")[0];
  return new Map(
    list.split(", ").map((part) => {
      const m = part.match(/^(.*) (\d+)$/)!;
      return [m[1], Number(m[2])] as [string, number];
    })
  );
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

test("a brain generated from template/ passes, and counts the imported contract and every skill", async () => {
  const root = templateBrain();
  const check = await weightCheck(root);
  expect(check.status).toBe("pass");
  const parts = listed(check.detail);

  const contract = estimateTokens(readFileSync(join(REPO, "packages", "core", "CONTRACT.md"), "utf8"));
  expect(contract).toBeGreaterThan(500);
  expect(parts.get("node_modules/@schlessera/brain/CONTRACT.md")).toBe(contract);
  expect(parts.get("CLAUDE.md")).toBe(estimateTokens(readFileSync(join(root, "CLAUDE.md"), "utf8")));

  const skills = discoverSkills({ root, modules: [] }).skills.filter(
    (s) => s.frontmatter["disable-model-invocation"] !== true
  );
  expect(skills.length).toBeGreaterThan(5);
  for (const skill of skills) expect(parts.get(`skill ${skill.name}`)).toBe(estimateTokens(skill.description));

  const total = [...parts.values()].reduce((a, b) => a + b, 0);
  expect(check.detail.startsWith(`~${total} tokens always loaded`)).toBe(true);
  expect(parts.size).toBe(2 + skills.length);
});

test("an import that cannot be read warns even under the limit, keeping the partial total", async () => {
  const root = corpusBrain();
  writeFileSync(join(root, "CLAUDE.md"), "Rules.\n\n@missing.md\n");
  const check = await weightCheck(root);
  expect(check.status).toBe("warn");
  expect(check.detail).toMatch(/^~\d+ tokens always loaded \(limit 8000\)/);
  expect(check.detail).toContain("not measured, so the total is a lower bound: missing.md: not found");
});

test("instructions.maxTokens set lower flips a template-sized brain to warn", async () => {
  const root = templateBrain();
  rmSync(join(root, "brain.config.ts"));
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ instructions: { maxTokens: 500 } }));
  const check = await weightCheck(root);
  expect(check.status).toBe("warn");
  expect(check.detail).toContain("over the 500 limit");
  expect(check.detail).toContain("largest: node_modules/@schlessera/brain/CONTRACT.md (");
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
  const parts = [...listed(check.detail).keys()];
  expect(parts).toContain("CLAUDE.md");
  expect(parts.filter((p) => p.includes("huge.md") || p.includes("inside.md"))).toEqual([]);
  expect(check.detail).toContain("huge.md resolves outside the brain and is not counted");
  expect(check.detail).not.toContain("inside.md");
});
