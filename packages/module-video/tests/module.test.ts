import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, makeTempBrain } from "../../core/tests/cli-harness.js";
import { discoverSkills } from "../../core/src/lib/skills/discover.js";
import { lintSkills } from "../../core/src/lib/skills/lint.js";
import manifest, { configSchema } from "../src/module.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });
test("manifest is opt-in, schema rejects alternate engines and unsafe timeout", () => {
  const config = configSchema.parse({});
  expect(config.engine).toBe("gemini"); expect(config.timeoutMs).toBe(300000);
  expect(config.model.length).toBeGreaterThan(0);
  expect(() => configSchema.parse({ engine: "local" })).toThrow();
  expect(() => configSchema.parse({ timeoutMs: 0 })).toThrow();
  expect(() => configSchema.parse({ unknown: true })).toThrow();
  const contribution = manifest.setup(config);
  expect(Object.keys(contribution.commands!)).toEqual(["video"]);
  expect(contribution.tools).toBeUndefined();
  expect(contribution.taxonomy).toBeUndefined();
});
test("watch skill has portable instructions, named credential and conditional share handoff", () => {
  const root = makeTempBrain({ empty: true }); roots.push(root);
  const loaded = { key: "@schlessera/brain-module-video", manifest: { ...manifest.setup(configSchema.parse({})), name: "video" }, dir: resolve(import.meta.dir, ".."), config: {} };
  const found = discoverSkills({ root, modules: [loaded] }, { coreSkillsDir: resolve(import.meta.dir, "absent") });
  expect(found.warnings).toEqual([]); expect(found.skills.map((skill) => skill.name)).toEqual(["watch"]);
  expect(lintSkills(found.skills).filter((finding) => finding.severity !== "info")).toEqual([]);
  const skill = readFileSync(resolve(import.meta.dir, "../skills/watch/SKILL.md"), "utf8");
  expect(skill).toContain("compatibility:"); expect(skill).toContain("GEMINI_API_KEY");
  expect(skill).toContain("question verbatim"); expect(skill).toContain("untrusted evidence");
  expect(skill).not.toMatch(/(?:Bash|mcp__|yt-dlp|ffmpeg)/);
  const share = readFileSync(resolve(import.meta.dir, "../../core/skills/share/SKILL.md"), "utf8");
  expect(share).toContain("When the video module is enabled");
  expect(share).toContain("mediaType: video/*");
});
