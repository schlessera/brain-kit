/**
 * `syncSkills(ctx)` — materialize discovered skills into `.agents/skills/` and
 * run the per-agent emitters.
 *
 * Layering vs the shell original (`scripts/hooks/sync-skills`): that script had
 * only one skill home (`.agents/skills/`) and did two things — link CLI bins
 * into ~/.local/bin, and symlink `.agents/skills` → `.claude/skills`. Here:
 *
 *   - The `.claude/skills` symlinks + junction fallback + stale pruning move
 *     verbatim into emitters/claude.ts (the default emitter).
 *   - The bin-link helper is `installBinLinks()` below (brain only; the source's
 *     whatsup/sync links were personal and are intentionally dropped).
 *   - NEW: package skills (core + modules) are materialized into `.agents/skills`
 *     as symlinks so the canonical home is complete before emitters run. Local
 *     skills already live there as real directories and are never touched.
 *     Stale symlinks (removed skills / old package paths) are pruned.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { homedir } from "os";
import { join, relative, sep } from "path";

import type { SkillEmitter } from "../seams";
import { discoverSkills, type DiscoverOptions, type SkillSources } from "./discover";
import { claudeEmitter } from "./emitters/claude";
import { isSymlink, makeLink, normalizeLinkTarget, readLink } from "./fs-links";

export interface SyncOptions extends DiscoverOptions {
  /** Emitters to run after materializing. Default: [claudeEmitter]. */
  emitters?: SkillEmitter[];
}

export interface SyncResult {
  /** Package skills newly linked (or re-pointed) into `.agents/skills` this run. */
  materialized: string[];
  /** Stale `.agents/skills` symlinks removed this run. */
  pruned: string[];
  warnings: string[];
  emitters: { agent: string; written: string[]; removed: string[] }[];
}

export function syncSkills(ctx: SkillSources, opts: SyncOptions = {}): SyncResult {
  const { skills, warnings } = discoverSkills(ctx, opts);

  const root = ctx.root;
  const agentsSkillsDir = join(root, ".agents", "skills");
  mkdirSync(agentsSkillsDir, { recursive: true });

  const materialized: string[] = [];
  const pruned: string[] = [];
  const managed = new Set<string>(); // package-skill names that should be symlinks

  for (const skill of skills) {
    if (skill.source === "local") continue; // real dir, already canonical
    managed.add(skill.name);

    const link = join(agentsSkillsDir, skill.name);
    const target = linkTargetFor(agentsSkillsDir, skill.dir, root);

    if (isSymlink(link)) {
      if (normalizeLinkTarget(readLink(link) ?? "") === normalizeLinkTarget(target)) continue;
      rmSync(link); // old package path — re-point
    } else if (existsSync(link)) {
      warnings.push(`.agents/skills/${skill.name} exists and is not a symlink; leaving it as-is`);
      continue;
    }

    if (makeLink(target, link, true)) materialized.push(skill.name);
    else warnings.push(`could not link skill "${skill.name}"`);
  }

  // Prune stale symlinks: removed skills or renamed packages. Real (local) dirs
  // are never symlinks, so they are untouched.
  for (const entry of readdirSync(agentsSkillsDir)) {
    const p = join(agentsSkillsDir, entry);
    if (isSymlink(p) && !managed.has(entry)) {
      rmSync(p);
      pruned.push(entry);
    }
  }

  const emitters = opts.emitters ?? [claudeEmitter];
  const emitterResults = emitters.map((e) => ({ agent: e.agent, ...e.emit(skills, root) }));

  return { materialized, pruned, warnings, emitters: emitterResults };
}

/** Relative link when the skill lives inside the repo, absolute otherwise. */
function linkTargetFor(agentsSkillsDir: string, skillDir: string, root: string): string {
  const inside = skillDir === root || skillDir.startsWith(root + sep);
  return inside ? relative(agentsSkillsDir, skillDir) : skillDir;
}

// ---------------------------------------------------------------------------
// bin links
// ---------------------------------------------------------------------------

export interface BinLinkResult {
  linked: string[];
  warnings: string[];
}

/**
 * Symlink `brain` into ~/.local/bin (honoring XDG_BIN_HOME), pointing at the
 * repo's pinned CLI (`node_modules/.bin/brain`). The source hook also linked
 * `whatsup` and `sync`; those were personal wrappers of Alain's repo and are
 * intentionally dropped from the portable installer.
 */
export function installBinLinks(root: string): BinLinkResult {
  const linked: string[] = [];
  const warnings: string[] = [];

  const binDir = process.env.XDG_BIN_HOME || join(homedir(), ".local", "bin");
  mkdirSync(binDir, { recursive: true });

  const target = join(root, "node_modules", ".bin", "brain");
  if (!existsSync(target)) {
    warnings.push(`brain CLI not found at ${target}; run \`bun install\` first`);
    return { linked, warnings };
  }

  const link = join(binDir, "brain");
  if (isSymlink(link)) {
    if (normalizeLinkTarget(readLink(link) ?? "") === normalizeLinkTarget(target)) {
      return { linked, warnings }; // already correct
    }
    rmSync(link);
  } else if (existsSync(link)) {
    warnings.push(`${link} exists and is not a symlink; leaving it as-is`);
    return { linked, warnings };
  }

  if (makeLink(target, link, false)) linked.push("brain");
  else warnings.push(`could not link brain into ${binDir}`);

  return { linked, warnings };
}
