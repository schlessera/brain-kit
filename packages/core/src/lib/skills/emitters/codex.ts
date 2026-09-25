/**
 * "codex" emitter — keeps the brain's agent contract in AGENTS.md.
 *
 * Codex discovers skills natively in `.agents/skills/`, which `syncSkills`
 * already fills, so this emitter writes no per-skill files. What Codex cannot
 * get any other way is the contract: CLAUDE.md imports `CONTRACT.md` with an
 * `@` line, and AGENTS.md has no import mechanism. So the body of the
 * installed `CONTRACT.md` is copied between the contract markers, and updates
 * with the package on every sync.
 *
 * Earlier versions wrote `.codex/prompts/<name>.md` (a location Codex never
 * read from a project) and a Skills index block. The first run after upgrading
 * swaps the index block for the contract block in place and deletes the
 * prompt files it names. Prompts it does not name are hand-authored and stay.
 */

import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync } from "fs";
import { join, resolve } from "path";

import type { SkillEmitter } from "../../seams.js";
import { INDEX_MARKERS, readManagedNames } from "./index-block.js";
import { removeManagedBlock, upsertManagedBlock, type Markers } from "./managed-block.js";

export const CONTRACT_START = "<!-- brain-kit:contract:start -->";
export const CONTRACT_END = "<!-- brain-kit:contract:end -->";
const CONTRACT_MARKERS: Markers = { start: CONTRACT_START, end: CONTRACT_END };

/** `<core>/CONTRACT.md`, resolved from this file at packages/core/src/lib/skills/emitters/. */
export const CONTRACT_FILE = resolve(import.meta.dir, "../../../../CONTRACT.md");

/** The full managed block, markers included: the contract body, verbatim. */
export function renderContractBlock(contract: string): string {
  return [
    CONTRACT_START,
    "<!-- Managed by `brain skills sync` from the installed @schlessera/brain CONTRACT.md — do not edit between these markers. -->",
    "",
    contract.replace(/^\s+|\s+$/g, ""),
    "",
    CONTRACT_END,
  ].join("\n");
}

export const codexEmitter: SkillEmitter = {
  agent: "codex",
  emit(_skills, repoRoot) {
    const written: string[] = [];
    const removed: string[] = [];

    const agentsFile = join(repoRoot, "AGENTS.md");
    const formerPrompts = readManagedNames(agentsFile);

    const block = renderContractBlock(readFileSync(CONTRACT_FILE, "utf8"));
    let changed = upsertManagedBlock(agentsFile, CONTRACT_MARKERS, block, INDEX_MARKERS);
    // Both blocks present only when the contract block was there already.
    if (removeManagedBlock(agentsFile, INDEX_MARKERS)) changed = true;
    if (changed) written.push("AGENTS.md");

    const promptsDir = join(repoRoot, ".codex", "prompts");
    for (const name of formerPrompts) {
      const stale = join(promptsDir, `${name}.md`);
      if (existsSync(stale)) {
        rmSync(stale);
        removed.push(`.codex/prompts/${name}.md`);
      }
    }
    if (removed.length > 0) {
      for (const [dir, rel] of [
        [promptsDir, ".codex/prompts"],
        [join(repoRoot, ".codex"), ".codex"],
      ]) {
        if (!existsSync(dir) || readdirSync(dir).length > 0) break;
        rmdirSync(dir);
        removed.push(rel);
      }
    }

    return { written, removed };
  },
};
