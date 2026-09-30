/**
 * Discover skills from the three layers, with precedence local > module > core.
 *
 *   1. core package skills   — `<core pkg>/skills/<name>/SKILL.md`
 *   2. enabled module skills — `<module dir>/<manifest.skills>/<name>/SKILL.md`
 *   3. repo-local skills     — `<root>/.agents/skills/<name>/SKILL.md`
 *
 * A same-named skill in a higher layer wins. Frontmatter is parsed with
 * gray-matter; a file with invalid or missing (name/description) frontmatter is
 * collected as a warning and skipped.
 *
 * The local layer only enumerates REAL subdirectories of `.agents/skills/`:
 * package skills are materialized there as symlinks by syncSkills, and those
 * must not be misread as local skills (they are re-derived from layers 1–2).
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { parseFrontmatter } from "../frontmatter-parse.js";

import type { LoadedModule } from "../module-types.js";
import type { SkillManifest } from "../seams.js";

/** The subset of BrainContext skill discovery needs. */
export interface SkillSources {
  root: string;
  modules: LoadedModule[];
}

export interface DiscoverOptions {
  /** Override the core package skills dir. Defaults to the shipped `<core>/skills`. */
  coreSkillsDir?: string;
}

export interface DiscoveryResult {
  skills: SkillManifest[];
  warnings: string[];
}

/** `<core>/skills`, resolved from this file at packages/core/src/lib/skills/. */
const DEFAULT_CORE_SKILLS_DIR = resolve(import.meta.dir, "../../../skills");

export function discoverSkills(
  sources: SkillSources,
  opts: DiscoverOptions = {}
): DiscoveryResult {
  const warnings: string[] = [];
  const byName = new Map<string, SkillManifest>();

  // Layer 1 — core (lowest precedence).
  const coreDir = opts.coreSkillsDir ?? DEFAULT_CORE_SKILLS_DIR;
  for (const skill of readSkillsDir(coreDir, "core", warnings)) {
    byName.set(skill.name, skill);
  }

  // Layer 2 — modules in config order (override core; first module wins on a
  // module-vs-module name clash).
  for (const mod of sources.modules) {
    if (!mod.manifest.skills) continue;
    const dir = resolve(mod.dir, mod.manifest.skills);
    for (const skill of readSkillsDir(dir, "module", warnings)) {
      const existing = byName.get(skill.name);
      if (existing && existing.source === "module") {
        warnings.push(
          `skill "${skill.name}" is defined by more than one module; keeping the first`
        );
        continue;
      }
      byName.set(skill.name, skill);
    }
  }

  // Layer 3 — repo-local (highest precedence).
  const localDir = join(sources.root, ".agents", "skills");
  for (const skill of readSkillsDir(localDir, "local", warnings)) {
    byName.set(skill.name, skill);
  }

  return { skills: [...byName.values()], warnings };
}

function readSkillsDir(
  dir: string,
  source: SkillManifest["source"],
  warnings: string[]
): SkillManifest[] {
  if (!existsSync(dir)) return [];

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillManifest[] = [];
  for (const entry of entries) {
    // `isDirectory()` is false for a symlink-to-dir (the Dirent reflects the
    // link itself), so materialized package symlinks are skipped here.
    if (!entry.isDirectory()) continue;

    const skillDir = join(dir, entry.name);
    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    let data: Record<string, unknown>;
    try {
      data = parseFrontmatter(readFileSync(skillFile, "utf8")).data as Record<string, unknown>;
    } catch (e) {
      warnings.push(`${skillFile}: could not parse frontmatter (${(e as Error).message}); skipped`);
      continue;
    }

    const name = typeof data.name === "string" ? data.name : undefined;
    const description = typeof data.description === "string" ? data.description : undefined;
    if (!name || !description) {
      warnings.push(`${skillFile}: frontmatter missing name or description; skipped`);
      continue;
    }

    skills.push({ name, description, dir: skillDir, source, frontmatter: data });
  }
  return skills;
}
