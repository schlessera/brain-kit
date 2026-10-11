import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { discoverSkills } from "../src/lib/skills/discover";
import { syncSkills } from "../src/lib/skills/sync";
import { packageRoot } from "../src/package-version";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const roots: string[] = [];
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "odysseus-skills-"));
  roots.push(root);
  return root;
}
afterAll(() => { for (const root of roots) cleanup(root); });
function skill(base: string, name: string, description: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nOdysseus.\n`);
  return dir;
}
function install(root: string, version = "0.41.0"): string {
  const pkg = join(root, "node_modules/@schlessera/brain");
  mkdirSync(join(pkg, "skills"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@schlessera/brain", version }));
  skill(join(pkg, "skills"), "audit", `Odysseus ${version}`);
  skill(join(pkg, "skills"), "odysseus-new", "Only in the target installation");
  return pkg;
}

test("foreign CLI preserves committed relative core links and selects the target release idempotently", () => {
  const root = temp();
  const pkg = install(root, "0.40.0");
  const canonical = join(root, ".agents/skills");
  mkdirSync(canonical, { recursive: true });
  const target = "../../node_modules/@schlessera/brain/skills/audit";
  symlinkSync(target, join(canonical, "audit"));
  const first = syncSkills({ root, modules: [] });
  expect(readlinkSync(join(canonical, "audit"))).toBe(target);
  expect(first.materialized).toEqual(["odysseus-new"]);
  expect(first.warnings).toEqual([]);
  expect(discoverSkills({ root, modules: [] }).skills.find(s => s.name === "audit")?.description).toBe("Odysseus 0.40.0");
  expect(readFileSync(join(pkg, "skills/audit/SKILL.md"), "utf8")).toContain("0.40.0");
  const again = syncSkills({ root, modules: [] });
  expect(again).toEqual({ materialized: [], pruned: [], warnings: [], emitters: [{ agent: "claude", written: [], removed: [] }] });
});

test("equal versions in distinct installations do not establish identity", () => {
  const root = temp();
  const version = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version;
  install(root, version);
  expect(discoverSkills({ root, modules: [] }).skills.find(s => s.name === "audit")?.dir).toBe(join(root, "node_modules/@schlessera/brain/skills/audit"));
});

test("symlinked installed package and repo roots retain portable node_modules links", () => {
  const backing = temp();
  const pkg = install(backing);
  const root = temp();
  mkdirSync(join(root, "node_modules/@schlessera"), { recursive: true });
  symlinkSync(pkg, join(root, "node_modules/@schlessera/brain"));
  const alias = join(temp(), "repo");
  symlinkSync(root, alias);
  syncSkills({ root: alias, modules: [] });
  expect(readlinkSync(join(root, ".agents/skills/audit"))).toBe("../../node_modules/@schlessera/brain/skills/audit");
});

for (const state of ["missing", "incomplete", "wrong package"]) {
  test(`${state} local install warns without pruning, linking or emitting`, () => {
    const root = temp();
    if (state !== "missing") {
      const pkg = install(root);
      if (state === "incomplete") rmSync(join(pkg, "skills"), { recursive: true });
      else writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@schlessera/brain-module-jobs" }));
    }
    const canonical = join(root, ".agents/skills");
    mkdirSync(canonical, { recursive: true });
    symlinkSync("../../node_modules/@schlessera/brain/skills/audit", join(canonical, "audit"));
    symlinkSync("missing", join(canonical, "stale"));
    skill(canonical, "odysseus-local", "Keep local skills");
    let emitted = false;
    const result = syncSkills({ root, modules: [] }, { emitters: [{ agent: "sentinel", emit() { emitted = true; return { written: [], removed: [] }; } }] });
    expect(result.materialized).toEqual([]);
    expect(result.pruned).toEqual([]);
    expect(result.emitters).toEqual([]);
    expect(emitted).toBe(false);
    expect(readlinkSync(join(canonical, "stale"))).toBe("missing");
    expect(readlinkSync(join(canonical, "audit"))).toBe("../../node_modules/@schlessera/brain/skills/audit");
    expect(result.warnings.join(" ")).toContain(root);
    expect(result.warnings.join(" ")).toContain(resolve(packageRoot()));
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });
}

test("explicit core override preserves module and local precedence", () => {
  const root = temp();
  const core = temp();
  skill(core, "audit", "core");
  skill(core, "shared", "core");
  const mod = temp();
  skill(join(mod, "skills"), "shared", "module");
  skill(join(root, ".agents/skills"), "audit", "local");
  const sources = { root, modules: [{ key: "odysseus", dir: mod, config: {}, manifest: { name: "odysseus", skills: "skills" } }] };
  syncSkills(sources, { coreSkillsDir: core, emitters: [] });
  expect(discoverSkills(sources, { coreSkillsDir: core }).skills.map(s => s.source).sort()).toEqual(["local", "module"]);
  expect(readlinkSync(join(root, ".agents/skills/shared"))).toBe(join(mod, "skills/shared"));
});

test("CLI sync preserves its JSON envelope on success and no-install warning", async () => {
  const root = makeTempBrain();
  roots.push(root);
  const ok = await runCli(root, ["skills", "sync", "--json"]);
  expect(ok.code).toBe(0);
  expect(Object.keys(JSON.parse(ok.stdout)).sort()).toEqual(["emitters", "materialized", "pruned", "warnings"]);
  // The no-install fixture uses a standalone config with no package import.
  rmSync(join(root, "node_modules"));
  writeFileSync(join(root, "brain.config.ts"), "export default { types: { note: { directory: 'notes' } } };\n");
  const refused = await runCli(root, ["skills", "sync", "--json"]);
  expect(refused.code).toBe(0);
  const result = JSON.parse(refused.stdout);
  expect(Object.keys(result).sort()).toEqual(["emitters", "materialized", "pruned", "warnings"]);
  expect(result.materialized).toEqual([]);
  expect(result.warnings.join(" ")).toContain(root);
});

test("doctor warns for an existing foreign core link but accepts an absolute module link", async () => {
  const root = makeTempBrain();
  roots.push(root);
  const foreign = install(temp());
  const canonical = join(root, ".agents/skills");
  mkdirSync(canonical, { recursive: true });
  symlinkSync(join(foreign, "skills/audit"), join(canonical, "audit"));
  const mod = temp();
  writeFileSync(join(mod, "package.json"), JSON.stringify({ name: "@schlessera/brain-module-jobs" }));
  symlinkSync(skill(join(mod, "skills"), "jobs", "module"), join(canonical, "jobs"));
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } }));
  const report = await runCli(root, ["doctor", "--json"]);
  expect(report.code).toBe(0);
  const check = JSON.parse(report.stdout).checks.find((c: { id: string }) => c.id === "symlinks");
  expect(check.status).toBe("warn");
  expect(check.detail).toContain(".agents/skills/audit");
  expect(check.detail).not.toContain("jobs");
  rmSync(join(canonical, "audit"));
  symlinkSync(resolve(root, "node_modules/@schlessera/brain/skills/audit"), join(canonical, "audit"));
  const clean = await runCli(root, ["doctor", "--json"]);
  expect(clean.code).toBe(0);
  expect(JSON.parse(clean.stdout).checks.find((c: { id: string }) => c.id === "symlinks").status).toBe("pass");
});

test("a source checkout may discover its own shipped skills without a local dependency", () => {
  const found = discoverSkills({ root: packageRoot(), modules: [] });
  expect(found.warnings).toEqual([]);
  expect(found.skills.some(s => s.name === "audit" && s.source === "core")).toBe(true);
});

test("no-install refusal creates no skill homes in a fresh repository", () => {
  const root = temp();
  const result = syncSkills({ root, modules: [] });
  expect(result.warnings.length).toBe(1);
  expect(existsSync(join(root, ".agents"))).toBe(false);
  expect(existsSync(join(root, ".claude"))).toBe(false);
});

test("an unreadable local install refuses before creating skill homes", () => {
  const root = temp();
  const pkg = install(root);
  const skills = join(pkg, "skills");
  chmodSync(skills, 0o000);
  try {
    const result = syncSkills({ root, modules: [] });
    expect(result.warnings.length).toBe(1);
    expect(existsSync(join(root, ".agents"))).toBe(false);
  } finally {
    chmodSync(skills, 0o755);
  }
});
