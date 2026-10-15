import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frontmatterEngineSentinel } from "../../../tests/helpers/frontmatter-engine-sentinel";
import { createSkillManager } from "../src/skills/manager";
import { installSkillsFromEntries } from "../src/skills/install";
import { parseDefinitionFile } from "../src/schedules/definition";

test("skill create, discovery, archive install and schedule file parsing refuse engine dispatch", () => {
  const root = mkdtempSync(join(tmpdir(), "odyssey-frontmatter-"));
  const sentinel = frontmatterEngineSentinel({ name: "odyssey", description: "Review the voyage." });
  try {
    const manager = createSkillManager(root);
    for (const language of ["js", "javascript", "JS", "json", "odyssey"]) {
      const content = `---${language}\nOdysseus\n---\n`;
      let error: unknown;
      try { manager.create("odyssey", content); } catch (caught) { error = caught; }
      expect(sentinel.dispatched, "SKILL_CREATE_NO_ENGINE_DISPATCH").toEqual([]);
      expect(String(error)).toContain("frontmatter");
      expect(existsSync(join(root, ".agents/skills/odyssey/SKILL.md"))).toBe(false);
      const outcome = installSkillsFromEntries({ brainPath: root }, { "SKILL.md": Buffer.from(content) });
      expect(sentinel.dispatched, "SKILL_INSTALL_NO_ENGINE_DISPATCH").toEqual([]);
      expect(outcome[0]!.status).toBe("skipped"); expect(outcome[0]!.reason).toContain("use YAML data only");
      mkdirSync(join(root, ".agents/skills/odyssey"), { recursive: true });
      writeFileSync(join(root, ".agents/skills/odyssey/SKILL.md"), content);
      manager.list();
      expect(sentinel.dispatched, "SKILL_DISCOVERY_NO_ENGINE_DISPATCH").toEqual([]);
      expect(() => parseDefinitionFile(content)).toThrow("frontmatter");
      expect(sentinel.dispatched, "SCHEDULE_NO_ENGINE_DISPATCH").toEqual([]);
      rmSync(join(root, ".agents/skills/odyssey"), { recursive: true });
    }
    const valid = "---\nname: odyssey\ndescription: Review the voyage.\n---\nOdysseus\n";
    expect(manager.create("odyssey", valid).name).toBe("odyssey");
    expect(sentinel.dispatched).toEqual([]);
  } finally { sentinel.restore(); rmSync(root, { recursive: true, force: true }); }
});
