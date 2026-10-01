import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });

function fixture(enabled = true, instructions = false): string {
  const root = makeTempBrain({ empty: true });
  roots.push(root);
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(root, `modules/${name}/skills/${name}-review`), { recursive: true });
    writeFileSync(join(root, `modules/${name}/skills/${name}-review/SKILL.md`),
      `---\nname: ${name}-review\ndescription: Review Odysseus's ${name} planning notes with their decisions.\n---\n\nRead the notes.\n`);
    writeFileSync(join(root, `modules/${name}/module.ts`), `
import { z } from "zod";
import { join } from "path";
export default {
  name: "${name}",
  configSchema: z.object({ label: z.string().min(1) }),
  setup: (config) => ({
    taxonomy: { types: { "${name}-note": { dir: "${name}-notes" } }, classifierHints: { "${name}-note": ["${name} navigation"] } },
    indexRules: { dirAnchors: ["${name}-anchor.md"] },
    skills: "skills",
    ${instructions ? `instructions: { text: "## ${name} workflow\\n\\nPlan Odysseus's ${name} navigation using " + config.label + ". Keep decisions linked to their notes." },` : ""}
    commands: { ${name}: async () => ({ summary: "${name} workflow", async run() { console.log("workflow ${name}"); return 0; } }) },
    cron: [{ name: "${name}-daily", schedule: "0 6 * * *", command: "${name} run" }],
    hygieneChecks: [async ({ root }) => { await Bun.write(join(root, ".${name}-hygiene"), "checked"); return []; }],
  }),
};
`);
    mkdirSync(join(root, `${name}-notes`));
    writeFileSync(join(root, `${name}-notes/odysseus.md`), `---\ntitle: Odysseus ${name} navigation\ntype: ${name}-note\ncreated: 2026-07-12\nupdated: 2026-07-12\nrelevance: primary\ntags: [navigation]\n---\n\nOdysseus ${name} navigation decisions.\n`);
  }
  config(root, enabled);
  return root;
}

function config(root: string, enabled: boolean): void {
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({
    skills: { emitters: ["codex", "gemini", "pi"] },
    exclude: { dirs: ["modules"], files: ["GEMINI.md"] },
    modules: { "./modules/alpha": { label: "Raft plans", enabled }, "./modules/beta": { label: "Return plans" } },
  }, null, 2) + "\n");
}

async function cli(root: string, args: string[]) {
  const result = await runCli(root, [...args, "--json"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  return JSON.parse(result.stdout);
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(dir: string, prefix: string) {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const rel = prefix + name;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) result[rel] = "link:" + readlinkSync(path);
      else if (stat.isDirectory()) visit(path, rel + "/");
      else result[rel] = readFileSync(path).toString("base64");
    }
  }
  visit(root, "");
  return result;
}

function instructionText(root: string): Record<string, string> {
  return Object.fromEntries(["CLAUDE.md", "AGENTS.md", "GEMINI.md"].map((file) => [file, readFileSync(join(root, file), "utf8")]));
}

function moduleBlock(text: string, owner: string): string {
  const block = new RegExp(`<!-- brain:generated:module-${owner} -->[\\s\\S]*?<!-- /brain:generated:module-${owner} -->\\r?\\n`).exec(text)?.[0];
  expect(block).toBeDefined();
  expect(block!.length).toBeGreaterThan(100);
  return block!;
}

test("dormant content validates and remains searchable, while discovery and scheduler metadata leave", async () => {
  const root = fixture();
  const active = await cli(root, ["module", "list"]);
  expect(active.enabled[0].types).toEqual(["alpha-note"]);
  expect(active.enabled[0].cron).toHaveLength(1);
  await cli(root, ["skills", "sync"]);
  expect(readFileSync(join(root, ".agents/skills/alpha-review/SKILL.md"), "utf8")).toContain("Odysseus");
  for (const agent of [".claude", ".pi"]) expect(readdirSync(join(root, agent, "skills"))).toContain("alpha-review");
  config(root, false);
  await cli(root, ["index"]);
  const validated = await cli(root, ["validate"]);
  expect(validated.errors).toBe(0);
  const search = await cli(root, ["search", "navigation", "--type", "alpha-note", "--mode", "fts"]);
  expect(search.results.map((r: { path: string }) => r.path)).toContain("alpha-notes/odysseus.md");
  const dormant = await cli(root, ["module", "list"]);
  expect(dormant.enabled[0].state).toBe("dormant");
  expect(dormant.enabled[0].cron).toEqual([]);
  await cli(root, ["skills", "sync"]);
  expect(existsSync(join(root, ".agents/skills/alpha-review"))).toBe(false);
  for (const agent of [".claude", ".pi"]) expect(readdirSync(join(root, agent, "skills"))).not.toContain("alpha-review");
  expect(existsSync(join(root, ".agents/skills/beta-review"))).toBe(true);
});

test("dormant content passes real validation with a strict module domain schema", async () => {
  const root = fixture();
  const modulePath = join(root, "modules/alpha/module.ts");
  writeFileSync(modulePath, readFileSync(modulePath, "utf8").replace('z.object({ label: z.string().min(1) })', 'z.object({ label: z.string().min(1) }).strict()'));
  const path = join(root, "brain.config.json");
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  delete cfg.modules["./modules/alpha"].enabled;
  writeFileSync(path, JSON.stringify(cfg));
  await cli(root, ["index"]);
  expect((await cli(root, ["validate"])).errors).toBe(0);
  cfg.modules["./modules/alpha"].enabled = false;
  writeFileSync(path, JSON.stringify(cfg));
  const result = await runCli(root, ["validate", "--json"]);
  expect(result.code, result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).errors).toBe(0);
  const search = await cli(root, ["search", "navigation", "--type", "alpha-note", "--mode", "fts"]);
  expect(search.results).toHaveLength(1);
});

test("dormancy removes only the module classifier hints while retaining its directory anchor", async () => {
  const root = fixture();
  const active = await cli(root, ["add", "alpha navigation: raft decisions"]);
  expect(active.type).toBe("alpha-note");
  writeFileSync(join(root, "alpha-notes/alpha-anchor.md"), readFileSync(join(root, "alpha-notes/odysseus.md"), "utf8"));
  writeFileSync(join(root, "beta-notes/odysseus.md"), readFileSync(join(root, "beta-notes/odysseus.md"), "utf8") + "\nSee [[alpha-notes/]].\n");
  config(root, false);
  const dormant = await cli(root, ["add", "alpha navigation: homeward decisions"]);
  expect(dormant.type).toBe("note");
  expect((await cli(root, ["add", "beta navigation: return decisions"])).type).toBe("beta-note");
  await cli(root, ["index"]);
  const validated = await cli(root, ["validate"]);
  expect(validated.errors).toBe(0);
  expect(validated.issues.filter((i: { message: string }) => i.message.includes("alpha-notes/"))).toEqual([]);
});

test("the real namespace guard refuses a dormant workflow and maintain skips only its hygiene", async () => {
  const root = fixture();
  const active = await runCli(root, ["alpha", "run"]);
  expect(active.code).toBe(0);
  expect(active.stdout).toContain("workflow alpha");
  config(root, false);
  const dormant = await runCli(root, ["alpha", "run"]);
  expect(dormant.code).toBe(1);
  expect(dormant.stderr).toContain("module alpha is dormant");
  expect(dormant.stderr).toContain("brain module enable alpha");
  expect(dormant.stdout).not.toContain("workflow alpha");
  await cli(root, ["maintain", "--no-git"]);
  expect(existsSync(join(root, ".beta-hygiene"))).toBe(true);
  expect(existsSync(join(root, ".alpha-hygiene"))).toBe(false);
});

test("dormant namespace help answers nonzero without importing its command", async () => {
  const root = fixture(false);
  const path = join(root, "modules/alpha/module.ts");
  const source = readFileSync(path, "utf8");
  writeFileSync(path, source.replace('async () => ({ summary: "alpha workflow", async run() { console.log("workflow alpha"); return 0; } })', 'async () => { throw new Error("dormant command was imported"); }'));
  const result = await runCli(root, ["alpha", "--help"]);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("module alpha is dormant");
  expect(result.stderr).not.toContain("dormant command was imported");
});

test("enable and disable preserve config and content and restore managed skill targets byte-identically", async () => {
  const root = fixture();
  await cli(root, ["skills", "sync"]);
  const path = join(root, ".agents/skills/alpha-review");
  const target = readlinkSync(path);
  const content = readFileSync(join(root, "alpha-notes/odysseus.md"));
  await cli(root, ["module", "disable", "alpha"]);
  expect(existsSync(path)).toBe(false);
  const parked = readFileSync(join(root, "brain.config.json"));
  expect(JSON.parse(parked.toString()).modules["./modules/alpha"]).toEqual({ label: "Raft plans", enabled: false });
  await cli(root, ["module", "disable", "alpha"]);
  expect(readFileSync(join(root, "brain.config.json"))).toEqual(parked);
  await cli(root, ["module", "enable", "alpha"]);
  expect(readlinkSync(path)).toBe(target);
  const restored = readFileSync(join(root, "brain.config.json"));
  await cli(root, ["module", "enable", "alpha"]);
  expect(readFileSync(join(root, "brain.config.json"))).toEqual(restored);
  expect(readFileSync(join(root, "alpha-notes/odysseus.md"))).toEqual(content);
});

test("both toggles refuse nonempty legacy mixed sections before any config, instruction or link change", async () => {
  const root = fixture(true, true);
  for (const file of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
    writeFileSync(join(root, file), "Personal: keep Ithaca's return plans.\n<!-- brain:generated:conventions -->\nAlpha and beta workflows. Odysseus prefers a short checklist.\n<!-- /brain:generated:conventions -->\n");
  }
  await cli(root, ["skills", "sync"]);
  expect(readlinkSync(join(root, ".agents/skills/alpha-review"))).toContain("modules/alpha");
  const before = snapshot(root);
  for (const sub of ["disable", "enable"]) {
    const result = await runCli(root, ["module", sub, "alpha"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Explicitly migrate mixed generated sections");
    expect(snapshot(root)).toEqual(before);
  }
});

test("explicit migration isolates owned regions, preserves all other bytes and restores context idempotently", async () => {
  const root = fixture(true, true);
  for (const file of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) writeFileSync(join(root, file), "Personal: Odysseus keeps the return plan.\n");
  await cli(root, ["skills", "sync"]);
  const shared = instructionText(root);
  expect(shared["AGENTS.md"]!.length).toBeGreaterThan(1000);
  expect(shared["GEMINI.md"]!.length).toBeGreaterThan(1000);
  await cli(root, ["module", "enable", "alpha"]);
  const active = instructionText(root);
  const skill = readFileSync(join(root, ".agents/skills/alpha-review/SKILL.md"));
  const target = readlinkSync(join(root, ".agents/skills/alpha-review"));
  for (const text of Object.values(active)) {
    expect(text).toContain("Raft plans");
    expect(moduleBlock(text, "beta")).toContain("Return plans");
  }
  const disabled = await cli(root, ["module", "disable", "alpha"]);
  expect(disabled.context.left).toContain("alpha-review");
  const dormant = instructionText(root);
  for (const file of Object.keys(active)) expect(dormant[file]).toBe(active[file]!.replace(moduleBlock(active[file]!, "alpha"), ""));
  const first = snapshot(root);
  expect((await cli(root, ["module", "disable", "alpha"])).changed).toBe(false);
  expect(snapshot(root)).toEqual(first);
  const enabled = await cli(root, ["module", "enable", "alpha"]);
  expect(enabled.context.entered).toContain("alpha-review");
  expect(instructionText(root)).toEqual(active);
  expect(readlinkSync(join(root, ".agents/skills/alpha-review"))).toBe(target);
  expect(readFileSync(join(root, ".agents/skills/alpha-review/SKILL.md"))).toEqual(skill);
  const second = snapshot(root);
  expect((await cli(root, ["module", "enable", "alpha"])).changed).toBe(false);
  expect(snapshot(root)).toEqual(second);
});

test("reactivation regenerates from changed validated config and attributes only discoverable module context", async () => {
  const root = fixture(true, true);
  writeFileSync(join(root, "CLAUDE.md"), "Personal: Odysseus keeps every decision.\n");
  await cli(root, ["module", "enable", "alpha"]);
  const active = await cli(root, ["module", "list"]);
  for (const m of active.enabled) { expect(Number.isInteger(m.contextTokens)).toBe(true); expect(m.contextTokens).toBeGreaterThan(0); }
  const contributed = instructionText(root);
  expect(moduleBlock(contributed["AGENTS.md"]!, "alpha")).toContain("Raft plans");
  expect(moduleBlock(contributed["AGENTS.md"]!, "beta")).toContain("Return plans");
  await cli(root, ["module", "disable", "alpha"]);
  const parked = await cli(root, ["module", "list"]);
  expect(parked.enabled[0].contextTokens).toBe(active.enabled[0].contextTokens);
  const cfg = JSON.parse(readFileSync(join(root, "brain.config.json"), "utf8"));
  cfg.modules["./modules/alpha"].label = "A newly validated raft plan. ".repeat(20);
  for (const file of ["CLAUDE.md", "AGENTS.md", "GEMINI.md"]) {
    writeFileSync(join(root, file), readFileSync(join(root, file), "utf8") + "Unrelated personal prose. ".repeat(100) + "\n");
  }
  const unrelated = await cli(root, ["module", "list"]);
  expect(unrelated.enabled.map((m: { contextTokens: number }) => m.contextTokens)).toEqual(parked.enabled.map((m: { contextTokens: number }) => m.contextTokens));
  writeFileSync(join(root, "brain.config.json"), JSON.stringify(cfg));
  const changed = await cli(root, ["module", "list"]);
  expect(changed.enabled[0].contextTokens).toBeGreaterThan(active.enabled[0].contextTokens);
  expect(changed.enabled[1].contextTokens).toBe(active.enabled[1].contextTokens);
  await cli(root, ["module", "enable", "alpha"]);
  const texts = instructionText(root);
  for (const text of Object.values(texts)) {
    expect(moduleBlock(text, "alpha")).toContain(cfg.modules["./modules/alpha"].label);
    expect(moduleBlock(text, "alpha")).not.toContain("Raft plans");
    expect(text).toContain("Unrelated personal prose.");
  }
});

test.each([
  ["unknown owner", "<!-- brain:module-instructions:stranger -->\n"],
  ["malformed owner", "<!-- brain:module-instructions:alpha -->\n<!-- brain:generated:module-alpha -->\nold\n"],
  ["duplicate slot", "<!-- brain:module-instructions:alpha -->\n<!-- brain:module-instructions:alpha -->\n"],
  ["unowned region", "<!-- brain:generated:module-alpha -->\nold\n<!-- /brain:generated:module-alpha -->\n"],
] as const)("%s is refused before any toggle side effect", async (_name, text) => {
  const root = fixture(true, true);
  await cli(root, ["skills", "sync"]);
  writeFileSync(join(root, "CLAUDE.md"), "Personal text.\n" + text);
  const before = snapshot(root);
  const result = await runCli(root, ["module", "disable", "alpha"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("No changes made");
  expect(snapshot(root)).toEqual(before);
});

test("invalid dormant domain config and malformed enabled flag fail before writes", async () => {
  const root = fixture(false, true);
  for (const entry of [{ label: "", enabled: false }, { label: "Raft plans", enabled: "false" }, { label: "Raft plans", enabled: null }]) {
    const cfg = JSON.parse(readFileSync(join(root, "brain.config.json"), "utf8"));
    cfg.modules["./modules/alpha"] = entry;
    writeFileSync(join(root, "brain.config.json"), JSON.stringify(cfg));
    const before = snapshot(root);
    const result = await runCli(root, ["module", "enable", "alpha"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Invalid");
    expect(snapshot(root)).toEqual(before);
  }
});

test("a manifest can refuse dormancy with its explicit reason", async () => {
  const root = fixture();
  const path = join(root, "modules/alpha/module.ts");
  writeFileSync(path, readFileSync(path, "utf8").replace('name: "alpha",', 'name: "alpha", canBeDormant: false, dormancyReason: "The return route must remain available.",'));
  const before = snapshot(root);
  const result = await runCli(root, ["module", "disable", "alpha"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("The return route must remain available.");
  expect(snapshot(root)).toEqual(before);
});

test("a literal TypeScript toggle preserves surrounding code, comments and other module config", async () => {
  const root = fixture(true, true);
  const cfg = JSON.parse(readFileSync(join(root, "brain.config.json"), "utf8"));
  const initial = '// Kept teaching comment.\nconst title = "Odysseus";\nexport default ' + JSON.stringify(cfg, null, 2).replace('"label": "Raft plans"', '"label": String("Raft plans")') + ';\n// Kept trailing comment.\n';
  const path = join(root, "brain.config.ts");
  writeFileSync(path, initial);
  await cli(root, ["module", "disable", "alpha"]);
  expect(readFileSync(path, "utf8")).toBe(initial.replace('"enabled": true', '"enabled": false'));
  await cli(root, ["module", "enable", "alpha"]);
  expect(readFileSync(path, "utf8")).toBe(initial);
});

test("ambiguous executable config is refused without serializing its evaluated value", async () => {
  const root = fixture(true, true);
  const cfg = readFileSync(join(root, "brain.config.json"), "utf8");
  writeFileSync(join(root, "brain.config.ts"), `const settings = ${cfg};\nexport default settings;\n`);
  const before = snapshot(root);
  const result = await runCli(root, ["module", "disable", "alpha"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("dynamic construction");
  expect(snapshot(root)).toEqual(before);
});

test("quoted marker examples remain inert and CRLF owned regions restore byte-identically", async () => {
  const root = fixture(true, true);
  writeFileSync(join(root, "CLAUDE.md"), 'Personal text.\r\n```html\r\n<!-- brain:module-instructions:alpha -->\r\n<!-- brain:generated:conventions -->\r\n```\r\n');
  await cli(root, ["module", "enable", "alpha"]);
  const active = readFileSync(join(root, "CLAUDE.md"), "utf8");
  expect(moduleBlock(active, "alpha")).toContain("\r\n");
  await cli(root, ["module", "disable", "alpha"]);
  await cli(root, ["module", "enable", "alpha"]);
  expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(active);
});

test("a CLAUDE import loads contributed module context once through AGENTS", async () => {
  const root = fixture(true, true);
  writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\nPersonal return plan.\n");
  await cli(root, ["module", "enable", "alpha"]);
  const active = instructionText(root);
  expect(active["CLAUDE.md"]).not.toContain("Plan Odysseus's alpha");
  expect(moduleBlock(active["AGENTS.md"]!, "alpha")).toContain("Raft plans");
  await cli(root, ["module", "disable", "alpha"]);
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).not.toContain("Plan Odysseus's alpha");
  await cli(root, ["module", "enable", "alpha"]);
  expect(instructionText(root)).toEqual(active);
});

test("all first-party modules contribute authoritative context and pass real module lint", async () => {
  const root = fixture();
  const path = join(root, "brain.config.json");
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const names = ["jobs", "speaking", "travel", "finance", "images"];
  for (const name of names) cfg.modules[`@schlessera/brain-module-${name}`] = name === "jobs" ? { criteria: "career/criteria.md" } : {};
  writeFileSync(path, JSON.stringify(cfg));
  const list = await cli(root, ["module", "list"]);
  for (const name of names) {
    expect(list.enabled.find((m: { name: string }) => m.name === name).contextTokens).toBeGreaterThan(20);
    expect((await cli(root, ["module", "lint", name])).errors).toBe(0);
  }
  await cli(root, ["module", "enable", "jobs"]);
  const jobSkills = readdirSync(join(root, "node_modules/@schlessera/brain-module-jobs/skills"));
  expect(jobSkills.length).toBeGreaterThan(0);
  const links = jobSkills.flatMap((name) => [".agents", ".claude", ".pi"].map((agent) => join(root, agent, "skills", name)));
  const targets = links.map((path) => readlinkSync(path));
  const contents = jobSkills.map((name) => readFileSync(join(root, ".agents/skills", name, "SKILL.md")));
  const active = instructionText(root);
  for (const name of names) expect(moduleBlock(active["AGENTS.md"]!, name)).toContain("workflow");
  await cli(root, ["module", "disable", "jobs"]);
  const dormant = instructionText(root);
  for (const agent of [".agents", ".claude", ".pi"]) {
    const entries = readdirSync(join(root, agent, "skills"));
    for (const name of jobSkills) expect(entries).not.toContain(name);
  }
  for (const file of Object.keys(active)) expect(dormant[file]).toBe(active[file]!.replace(moduleBlock(active[file]!, "jobs"), ""));
  expect((await cli(root, ["module", "lint", "jobs"])).errors).toBe(0);
  await cli(root, ["module", "enable", "jobs"]);
  expect(links.map((path) => readlinkSync(path))).toEqual(targets);
  expect(jobSkills.map((name) => readFileSync(join(root, ".agents/skills", name, "SKILL.md")))).toEqual(contents);
  expect(instructionText(root)).toEqual(active);
});

test("only discoverable descriptions affect skill context attribution; full bodies stay uncharged", async () => {
  const root = fixture(true, true);
  const initial = await cli(root, ["module", "list"]);
  const path = join(root, "modules/alpha/skills/alpha-review/SKILL.md");
  const original = readFileSync(path, "utf8");
  expect(original).toContain("description: Review Odysseus");
  writeFileSync(path, original + "Additional skill body. ".repeat(200));
  const body = await cli(root, ["module", "list"]);
  expect(body.enabled.map((m: { contextTokens: number }) => m.contextTokens)).toEqual(initial.enabled.map((m: { contextTokens: number }) => m.contextTokens));
  writeFileSync(path, original.replace("description: Review Odysseus", "description: " + "Detailed planning and review. ".repeat(20) + "Review Odysseus"));
  const described = await cli(root, ["module", "list"]);
  expect(described.enabled[0].contextTokens).toBeGreaterThan(initial.enabled[0].contextTokens);
  expect(described.enabled[1].contextTokens).toBe(initial.enabled[1].contextTokens);
  writeFileSync(path, original.replace("---\n\nRead", "disable-model-invocation: true\n---\n\nRead"));
  const hidden = await cli(root, ["module", "list"]);
  expect(hidden.enabled[0].contextTokens).toBeLessThan(initial.enabled[0].contextTokens);
  expect(hidden.enabled[1].contextTokens).toBe(initial.enabled[1].contextTokens);
});

test("a pre-existing schema-less domain object without enabled retains its prototype", async () => {
  const root = fixture();
  const path = join(root, "modules/alpha/module.ts");
  writeFileSync(path, readFileSync(path, "utf8")
    .replace('z.object({ label: z.string().min(1) })', '{ parse: (input) => input }')
    .replace('async run() { console.log("workflow alpha"); return 0; }', 'async run(_args, ctx) { console.log(ctx.config.getLabel()); return 0; }'));
  writeFileSync(join(root, "brain.config.ts"), 'export default { modules: { "./modules/alpha": new (class { label = "Raft plans"; getLabel() { return "Unchanged domain object"; } })() } };\n');
  const result = await runCli(root, ["alpha", "run"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Unchanged domain object");
});
