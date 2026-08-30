/**
 * Custom-skill management: the manager's filesystem contract (real dirs =
 * custom, symlinks = builtin and untouchable, disable = move out of
 * discovery) and the routes over it, including the sync-failure degrade.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSkillManager } from "../src/skills/manager";
import { createSkillRoutes } from "../src/routes/skills";

const dirs: string[] = [];
function makeBrain(): string {
  const root = mkdtempSync(join(tmpdir(), "skills-test-"));
  dirs.push(root);
  mkdirSync(join(root, ".agents", "skills"), { recursive: true });
  return root;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SKILL = (name: string, description = "Use when testing.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

function addCustom(root: string, name: string, content = SKILL(name)): void {
  const dir = join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
}

function addBuiltin(root: string, name: string): void {
  // A "package" skill materialized as a symlink, the way syncSkills does it.
  const pkgDir = join(root, "node_modules", "fake-pkg", "skills", name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "SKILL.md"), SKILL(name, "Built-in test skill."), "utf-8");
  symlinkSync(pkgDir, join(root, ".agents", "skills", name));
}

describe("skill manager", () => {
  test("lists customs (both states) and builtins, sorted", () => {
    const root = makeBrain();
    addCustom(root, "my-flow");
    addBuiltin(root, "add");
    const manager = createSkillManager(root);
    manager.setEnabled("my-flow", false);
    addCustom(root, "another");

    const list = manager.list();
    expect(list.map((s) => `${s.name}:${s.source}:${s.enabled}`)).toEqual([
      "add:builtin:true",
      "another:custom:true",
      "my-flow:custom:false",
    ]);
  });

  test("create validates name, frontmatter name match, and description", () => {
    const root = makeBrain();
    const manager = createSkillManager(root);
    expect(() => manager.create("Bad Name", SKILL("Bad Name"))).toThrow("kebab-case");
    expect(() => manager.create("../escape", SKILL("../escape"))).toThrow("kebab-case");
    expect(() => manager.create("ok-name", SKILL("other-name"))).toThrow("must equal");
    expect(() => manager.create("ok-name", "---\nname: ok-name\n---\nbody")).toThrow(
      "description"
    );
    manager.create("ok-name", SKILL("ok-name"));
    expect(readFileSync(join(root, ".agents", "skills", "ok-name", "SKILL.md"), "utf-8")).toContain(
      "# ok-name"
    );
    expect(() => manager.create("ok-name", SKILL("ok-name"))).toThrow("already exists");
  });

  test("builtins cannot be edited, disabled, or removed", () => {
    const root = makeBrain();
    addBuiltin(root, "add");
    const manager = createSkillManager(root);
    expect(() => manager.update("add", SKILL("add"))).toThrow("package skill");
    expect(() => manager.setEnabled("add", false)).toThrow("package skill");
    expect(() => manager.remove("add")).toThrow("package skill");
    // The symlink (and its target) are untouched.
    expect(lstatSync(join(root, ".agents", "skills", "add")).isSymbolicLink()).toBe(true);
    // Read-only view still works.
    const detail = manager.get("add");
    expect(detail.source).toBe("builtin");
    expect(detail.content).toContain("Built-in test skill.");
  });

  test("disable moves the dir out of discovery; enable moves it back", () => {
    const root = makeBrain();
    addCustom(root, "my-flow");
    const manager = createSkillManager(root);

    manager.setEnabled("my-flow", false);
    expect(existsSync(join(root, ".agents", "skills", "my-flow"))).toBe(false);
    expect(existsSync(join(root, ".agents", "skills-disabled", "my-flow", "SKILL.md"))).toBe(true);

    manager.setEnabled("my-flow", true);
    expect(existsSync(join(root, ".agents", "skills", "my-flow", "SKILL.md"))).toBe(true);
  });

  test("remove deletes a custom skill in either state", () => {
    const root = makeBrain();
    addCustom(root, "gone");
    const manager = createSkillManager(root);
    manager.setEnabled("gone", false);
    manager.remove("gone");
    expect(existsSync(join(root, ".agents", "skills-disabled", "gone"))).toBe(false);
    expect(() => manager.get("gone")).toThrow("No custom skill");
  });
});

describe("skill routes", () => {
  test("CRUD round-trip runs sync after each mutation", async () => {
    const root = makeBrain();
    let syncs = 0;
    const app = createSkillRoutes({
      brainPath: root,
      syncSkills: async () => {
        syncs++;
        return "ok";
      },
    });

    let res = await app.request("/skills", {
      method: "POST",
      body: JSON.stringify({ name: "my-flow", content: SKILL("my-flow") }),
    });
    expect(res.status).toBe(201);
    expect(syncs).toBe(1);

    res = await app.request("/skills/my-flow/enabled", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { skill: { enabled: boolean } }).skill.enabled).toBe(false);
    expect(syncs).toBe(2);

    res = await app.request("/skills/my-flow", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(syncs).toBe(3);

    res = await app.request("/skills");
    expect(((await res.json()) as { skills: unknown[] }).skills).toHaveLength(0);
  });

  test("a failed sync degrades to a warning, not an error", async () => {
    const root = makeBrain();
    const app = createSkillRoutes({
      brainPath: root,
      syncSkills: async () => {
        throw new Error("no CLI here");
      },
    });
    const res = await app.request("/skills", {
      method: "POST",
      body: JSON.stringify({ name: "my-flow", content: SKILL("my-flow") }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { warning?: string };
    expect(body.warning).toContain("no CLI here");
    expect(existsSync(join(root, ".agents", "skills", "my-flow", "SKILL.md"))).toBe(true);
  });

  test("validation and conflict map to 400/404/409", async () => {
    const root = makeBrain();
    addBuiltin(root, "add");
    const app = createSkillRoutes({ brainPath: root, syncSkills: async () => "ok" });

    expect(
      (
        await app.request("/skills", {
          method: "POST",
          body: JSON.stringify({ name: "../etc", content: "x" }),
        })
      ).status
    ).toBe(400);
    expect(
      (
        await app.request("/skills/add", {
          method: "PUT",
          body: JSON.stringify({ content: SKILL("add") }),
        })
      ).status
    ).toBe(409);
    expect((await app.request("/skills/nope", { method: "DELETE" })).status).toBe(404);
  });
});
