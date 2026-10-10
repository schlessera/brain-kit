/**
 * Custom-skill management over the brain repo's canonical skill home.
 *
 * The store IS the filesystem convention `brain skills sync` already defines:
 *
 * - `.agents/skills/<name>` as a REAL directory = a user's custom skill —
 *   the local layer, highest discovery precedence, never touched by sync,
 *   inside the brain repo so it persists across deployments and rides the
 *   repo's own git backup.
 * - `.agents/skills/<name>` as a SYMLINK = a package skill (core or module),
 *   materialized by sync. Read-only here: managed by the packages.
 * - `.agents/skills-disabled/<name>` = a custom skill parked out of
 *   discovery. Disable is a directory move, so it applies to EVERY backend
 *   at once — after a sync, the claude/pi/codex/gemini emitters prune their
 *   links and the AGENTS.md index drops the row.
 *
 * After every mutation the caller runs `brain skills sync` so all agent
 * integration dirs and the AGENTS.md index block follow the canonical home.
 *
 * Security posture: names are strictly validated (no traversal), mutations
 * refuse to operate through symlinks (a package skill can never be edited or
 * deleted from here), and content is size-capped. The routes sit behind the
 * /api auth guard — this surface configures what the agent does.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";

/** Agent Skills standard: lowercase kebab, no traversal, bounded. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A SKILL.md past this is not a skill, it's a document dump. */
export const MAX_SKILL_CONTENT_BYTES = 128 * 1024;

export interface SkillEntry {
  /** Directory name (= the skill's identity for enable/disable/remove). */
  name: string;
  /** Frontmatter description, or empty when unparseable. */
  description: string;
  /** Where the skill comes from; only "custom" entries are editable. */
  source: "builtin" | "custom";
  enabled: boolean;
  /** Set when the SKILL.md failed to parse — shown, not hidden. */
  warning?: string;
}

export interface SkillDetail extends SkillEntry {
  content: string;
  /** Files in the skill directory besides SKILL.md (repo-relative names). */
  extraFiles: string[];
}

export class SkillValidationError extends Error {}
export class SkillNotFoundError extends Error {}
export class SkillConflictError extends Error {}

export interface SkillManager {
  list(): SkillEntry[];
  get(name: string): SkillDetail;
  create(name: string, content: string): SkillEntry;
  update(name: string, content: string): SkillEntry;
  setEnabled(name: string, enabled: boolean): SkillEntry;
  remove(name: string): void;
}

export function createSkillManager(brainPath: string): SkillManager {
  const enabledDir = join(brainPath, ".agents", "skills");
  const disabledDir = join(brainPath, ".agents", "skills-disabled");

  function assertValidName(name: string): void {
    if (!NAME_PATTERN.test(name)) {
      throw new SkillValidationError(
        "Skill name must be lowercase kebab-case (a-z, 0-9, hyphens), max 64 chars."
      );
    }
  }

  /** lstat without following; null when absent. */
  function kindOf(path: string): "dir" | "symlink" | "other" | null {
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) return "symlink";
      if (st.isDirectory()) return "dir";
      return "other";
    } catch {
      return null;
    }
  }

  function parseSkillFile(dir: string): { description: string; warning?: string } {
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) {
      return { description: "", warning: "SKILL.md is missing" };
    }
    try {
      const data = parseFrontmatter(readFileSync(file, "utf-8")).data as Record<string, unknown>;
      const description = typeof data.description === "string" ? data.description : "";
      if (!description) return { description: "", warning: "frontmatter has no description" };
      return { description };
    } catch (e) {
      return {
        description: "",
        warning: `frontmatter does not parse: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  function entryFor(name: string, dir: string, source: "builtin" | "custom", enabled: boolean): SkillEntry {
    const parsed = parseSkillFile(dir);
    return {
      name,
      description: parsed.description,
      source,
      enabled,
      ...(parsed.warning ? { warning: parsed.warning } : {}),
    };
  }

  /** Validate content as a plausible skill for directory `name`. */
  function validateContent(name: string, content: string): void {
    if (Buffer.byteLength(content, "utf-8") > MAX_SKILL_CONTENT_BYTES) {
      throw new SkillValidationError(
        `SKILL.md exceeds ${MAX_SKILL_CONTENT_BYTES / 1024}KB.`
      );
    }
    let data: Record<string, unknown>;
    try {
      data = parseFrontmatter(content).data as Record<string, unknown>;
    } catch (e) {
      throw new SkillValidationError(
        `Frontmatter does not parse: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    if (data.name !== name) {
      throw new SkillValidationError(
        `Frontmatter \`name\` must equal the skill directory name ("${name}").`
      );
    }
    if (typeof data.description !== "string" || !data.description.trim()) {
      throw new SkillValidationError(
        "Frontmatter needs a non-empty `description` — it is what makes agents find the skill."
      );
    }
  }

  /** The custom skill's live directory, or throw. Never follows symlinks. */
  function customDir(name: string): { dir: string; enabled: boolean } {
    assertValidName(name);
    const enabled = join(enabledDir, name);
    const disabled = join(disabledDir, name);
    if (kindOf(enabled) === "dir") return { dir: enabled, enabled: true };
    if (kindOf(disabled) === "dir") return { dir: disabled, enabled: false };
    if (kindOf(enabled) === "symlink") {
      throw new SkillConflictError(
        `"${name}" is a package skill (managed by brain-kit); it cannot be edited here.`
      );
    }
    throw new SkillNotFoundError(`No custom skill named "${name}".`);
  }

  return {
    list(): SkillEntry[] {
      const entries: SkillEntry[] = [];
      if (existsSync(enabledDir)) {
        for (const entry of readdirSync(enabledDir).sort()) {
          const p = join(enabledDir, entry);
          const kind = kindOf(p);
          if (kind === "symlink") entries.push(entryFor(entry, p, "builtin", true));
          else if (kind === "dir") entries.push(entryFor(entry, p, "custom", true));
        }
      }
      if (existsSync(disabledDir)) {
        for (const entry of readdirSync(disabledDir).sort()) {
          const p = join(disabledDir, entry);
          if (kindOf(p) === "dir") entries.push(entryFor(entry, p, "custom", false));
        }
      }
      return entries;
    },

    get(name: string): SkillDetail {
      assertValidName(name);
      // Builtins are readable (their content is useful reference) but the
      // detail is marked read-only via source.
      const enabledPath = join(enabledDir, name);
      const kind = kindOf(enabledPath);
      if (kind === "symlink") {
        // Follow explicitly for READ only.
        // resolve, not join: sync writes relative link targets, but a test or
        // hand-made link may be absolute.
        const target = resolve(enabledDir, readlinkSync(enabledPath));
        const content = existsSync(join(target, "SKILL.md"))
          ? readFileSync(join(target, "SKILL.md"), "utf-8")
          : "";
        return { ...entryFor(name, target, "builtin", true), content, extraFiles: [] };
      }
      const { dir, enabled } = customDir(name);
      const content = existsSync(join(dir, "SKILL.md"))
        ? readFileSync(join(dir, "SKILL.md"), "utf-8")
        : "";
      const extraFiles = readdirSync(dir)
        .filter((f) => f !== "SKILL.md")
        .sort();
      return { ...entryFor(name, dir, "custom", enabled), content, extraFiles };
    },

    create(name: string, content: string): SkillEntry {
      assertValidName(name);
      validateContent(name, content);
      if (kindOf(join(enabledDir, name)) !== null) {
        throw new SkillConflictError(`A skill named "${name}" already exists.`);
      }
      if (kindOf(join(disabledDir, name)) !== null) {
        throw new SkillConflictError(`A disabled skill named "${name}" already exists.`);
      }
      const dir = join(enabledDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
      return entryFor(name, dir, "custom", true);
    },

    update(name: string, content: string): SkillEntry {
      const { dir, enabled } = customDir(name);
      validateContent(name, content);
      writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
      return entryFor(name, dir, "custom", enabled);
    },

    setEnabled(name: string, enabled: boolean): SkillEntry {
      const current = customDir(name);
      if (current.enabled === enabled) {
        return entryFor(name, current.dir, "custom", enabled);
      }
      const target = enabled ? join(enabledDir, name) : join(disabledDir, name);
      if (kindOf(target) !== null) {
        throw new SkillConflictError(`"${name}" already exists at the target location.`);
      }
      mkdirSync(enabled ? enabledDir : disabledDir, { recursive: true });
      renameSync(current.dir, target);
      return entryFor(name, target, "custom", enabled);
    },

    remove(name: string): void {
      const { dir } = customDir(name);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
