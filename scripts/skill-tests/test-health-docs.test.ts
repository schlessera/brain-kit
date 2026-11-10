/**
 * The test-health skills, their references, the authoring guide and the
 * scripts share one vocabulary and one command surface. A skill that names a
 * command the CLI does not have, or a smell the catalogue does not know, sends
 * an unattended agent somewhere that does not exist.
 */
import { describe, expect, test } from "bun:test";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { ACTIONS, LENS_IDS, SMELLS, STATUSES } from "../test-health/catalog";
import { loadConfig } from "../test-health/config";

const ROOT = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const SKILL = ".agents/skills/test-health";
const PUSH = ".agents/skills/test-health-push";
const references = readdirSync(join(ROOT, SKILL, "references")).filter(name => name.endsWith(".md")).sort();
const skillText = [read(`${SKILL}/SKILL.md`), ...references.map(name => read(`${SKILL}/references/${name}`))].join("\n");
const guide = read("docs/process/test-authoring.md");
const cli = read("scripts/test-health.ts");
const spans = (text: string) => new Set([...text.matchAll(/`([^`\n]+)`/g)].map(match => match[1]!));

const COMMANDS: Readonly<Record<string, readonly string[]>> = {
  doctor: [], inventory: [], signals: [], plan: [], brief: [], measure: [], mutate: [], validate: [], shards: [], report: [],
  record: ["cluster", "run", "batch", "void"], batch: ["status", "verify"], costs: ["ingest"],
};
/** Every `TH ...` or `bun scripts/test-health.ts ...` invocation written in a document. */
function invocations(text: string): Array<{ command: string; sub: string | undefined; flags: string[]; line: string }> {
  return [...text.matchAll(/(?:\bTH|bun scripts\/test-health\.ts) ([a-z]+)(?: ([a-z]+))?([^\n`]*)/g)].map(match => ({
    command: match[1]!, sub: match[2], flags: [...match[3]!.matchAll(/--([a-z][a-z-]*)/g)].map(flag => flag[1]!), line: match[0] }));
}

describe("the vocabulary", () => {
  const smellTable = guide.slice(guide.indexOf("## Smells and the rule that prevents each"), guide.indexOf("## Keeping this guide true"));

  test("every smell is explained in a lens reference and mapped to a rule in the authoring guide", () => {
    const explained = spans(skillText), mapped = spans(smellTable);
    expect(SMELLS.map(smell => smell.id).filter(id => !explained.has(id))).toEqual([]);
    expect(SMELLS.map(smell => smell.id).filter(id => !mapped.has(id))).toEqual([]);
  });

  test("the authoring guide's smell table names only smells the catalogue knows", () => {
    const named = [...smellTable.matchAll(/^\| (`[^|]+) \|/gm)].flatMap(match => [...spans(match[1]!)]);
    expect(named.length).toBeGreaterThanOrEqual(SMELLS.length);
    expect(named.filter(id => !SMELLS.some(smell => smell.id === id))).toEqual([]);
  });

  test("the skill's lens table lists every lens, in catalogue order", () => {
    const rows = [...read(`${SKILL}/SKILL.md`).matchAll(/^\| \d+ \| `([a-z-]+)` \|/gm)].map(match => match[1]!);
    expect(rows).toEqual([...LENS_IDS]);
  });

  test("the worksheet reference lists exactly the actions and statuses the validator accepts", () => {
    const worksheet = read(`${SKILL}/references/worksheet.md`);
    const actions = worksheet.slice(worksheet.indexOf("`action` is one of"), worksheet.indexOf("- `status` is"));
    const statuses = worksheet.slice(worksheet.indexOf("- `status` is"), worksheet.indexOf("- `note` is"));
    expect([...spans(actions)].filter(span => span !== "action").sort()).toEqual([...ACTIONS].sort());
    expect([...spans(statuses)].filter(span => span !== "status").sort()).toEqual([...STATUSES].sort());
  });
});

describe("the command surface", () => {
  const found = [...invocations(skillText), ...invocations(read(`${PUSH}/SKILL.md`)), ...invocations(guide)];

  test("the documents invoke the CLI often enough for this check to mean something", () => {
    expect(found.length).toBeGreaterThan(40);
    expect(new Set(found.map(entry => entry.command)).size).toBeGreaterThanOrEqual(10);
  });

  test("every documented command and subcommand exists", () => {
    const unknown = found.filter(entry => !(entry.command in COMMANDS)
      || (COMMANDS[entry.command]!.length > 0 && !COMMANDS[entry.command]!.includes(entry.sub ?? "")));
    expect(unknown.map(entry => entry.line)).toEqual([]);
  });

  test("every command in that table is one the CLI dispatches", () => {
    for (const [command, subs] of Object.entries(COMMANDS)) {
      if (!subs.length) expect(cli, command).toContain(`command === "${command}"`);
      for (const sub of subs) expect(cli, `${command} ${sub}`).toContain(`command === "${command}" && sub === "${sub}"`);
    }
  });

  test("every documented flag is one the CLI reads", () => {
    const reads = new Set([...cli.matchAll(/(?:flag|need|text)\((?:session, )?"([a-z-]+)"\)|flags\.has\("([a-z-]+)"\)|lists\.get\("([a-z-]+)"\)/g)]
      .map(match => match[1] ?? match[2] ?? match[3]!));
    const unread = found.flatMap(entry => entry.flags.map(flag => ({ flag, line: entry.line }))).filter(entry => !reads.has(entry.flag));
    expect(unread).toEqual([]);
  });

  test("the profiles the documents name are configured, and push changes only what scale requires", () => {
    const [cron, push] = [loadConfig("cron").profile, loadConfig("push").profile];
    expect(push).toMatchObject({ budgetFiles: null, ripe: { changedFiles: null, ageHours: null, whenExhausted: true } });
    const same = (profile: typeof cron) => ({ clusterSize: profile.clusterSize, reauditDays: profile.reauditDays, tiers: profile.tiers, weights: profile.weights, measure: profile.measure });
    expect(same(push)).toEqual(same(cron));
  });
});

describe("the wrapper adds only scale", () => {
  const push = read(`${PUSH}/SKILL.md`);

  test("it names no lens, smell or finding action of its own", () => {
    const named = spans(push);
    const vocabulary = [...LENS_IDS, ...SMELLS.map(smell => smell.id), ...ACTIONS.filter(action => action !== "none")];
    expect(vocabulary.filter(word => named.has(word))).toEqual([]);
  });

  test("it defers to the regular skill instead of restating its references", () => {
    expect(push).toContain("(../test-health/SKILL.md)");
    expect(push).toContain("--profile push");
    expect(references.filter(name => push.includes(`references/${name}`))).toEqual([]);
  });

  test("it is started by a person, never picked up implicitly", () => {
    expect(push).toMatch(/^disable-model-invocation: true$/m);
    const policy = Bun.YAML.parse(read(`${PUSH}/agents/openai.yaml`)) as { policy?: { allow_implicit_invocation?: unknown } };
    expect(policy.policy?.allow_implicit_invocation).toBe(false);
  });
});

describe("the tooling's tests are their own tier", () => {
  test("product discovery, which every package change's proof runs, finds none of them", async () => {
    const { discoverTests } = await import("../test-shards");
    const { DEFAULT_ROOTS } = await import("../test");
    const own = readdirSync(import.meta.dir).filter(name => name.endsWith(".test.ts"));
    expect(own.length).toBeGreaterThanOrEqual(11);
    const product = [...discoverTests(ROOT, DEFAULT_ROOTS), ...discoverTests(ROOT, ["experiments"])];
    expect(product.filter(file => own.some(name => file.endsWith(`/${name}`)))).toEqual([]);
    expect(product.filter(file => file.startsWith("scripts/"))).toEqual([]);
  });

  test("they have their own command, which names their directory and keeps the suite's timeout", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["test:skills"]).toBe("bun scripts/test.ts --timeout 30000 ./scripts/skill-tests");
    expect(scripts.test).not.toContain("skill-tests");
  });
});

describe("both skills are installed for every agent", () => {
  test.each([["test-health"], ["test-health-push"]])("%s is linked into .claude/skills and ships an agent description", name => {
    const link = join(ROOT, ".claude/skills", name);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(`../../.agents/skills/${name}`);
    const yaml = Bun.YAML.parse(read(`.agents/skills/${name}/agents/openai.yaml`)) as { interface?: { default_prompt?: string } };
    expect(yaml.interface?.default_prompt).toContain(`$${name}`);
    expect(read("AGENTS.md")).toContain(`| \`${name}\` |`);
  });

  test("every relative link in the skills resolves", () => {
    const broken: string[] = [];
    for (const path of [`${SKILL}/SKILL.md`, `${PUSH}/SKILL.md`, ...references.map(name => `${SKILL}/references/${name}`)]) {
      for (const match of read(path).matchAll(/\]\((\.[^)#\s]*)(?:#[^)]*)?\)/g)) {
        try { lstatSync(join(ROOT, path, "..", match[1]!)); } catch { broken.push(`${path} -> ${match[1]}`); }
      }
    }
    expect(broken).toEqual([]);
  });
});
