/**
 * Fenced, machine-managed "Skills index" block shared by the codex (AGENTS.md)
 * and gemini (GEMINI.md) emitters.
 *
 * Only the region between the markers is ever touched; everything before the
 * start marker and after the end marker is preserved byte-for-byte. The block
 * is rendered deterministically (skills sorted by name) so a re-run against an
 * unchanged skill set produces an identical file.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

import type { SkillManifest } from "../../seams";

export const INDEX_START = "<!-- endoxa:skills-index:start -->";
export const INDEX_END = "<!-- endoxa:skills-index:end -->";

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The full managed block, markers included. Deterministic. */
export function renderIndexBlock(skills: SkillManifest[]): string {
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  return [
    INDEX_START,
    "<!-- Managed by `brain skills sync` — do not edit between these markers. -->",
    "",
    "## Skills",
    "",
    ...sorted.map((s) => `- **${s.name}** — ${collapse(s.description)}`),
    "",
    INDEX_END,
  ].join("\n");
}

/** Skill names currently recorded in the managed block (for prune bookkeeping). */
export function readManagedNames(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  const start = text.indexOf(INDEX_START);
  const end = text.indexOf(INDEX_END);
  if (start === -1 || end === -1 || end < start) return [];
  const block = text.slice(start, end);
  const names: string[] = [];
  for (const line of block.split("\n")) {
    const m = line.match(/^- \*\*(.+?)\*\* —/);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Insert or replace the managed block in `filePath`, preserving all content
 * outside the markers. Creates the file when missing. Returns whether the file
 * changed (false ⇒ already up to date, no write).
 */
export function upsertIndexBlock(filePath: string, skills: SkillManifest[]): boolean {
  const block = renderIndexBlock(skills);
  const existed = existsSync(filePath);
  const original = existed ? readFileSync(filePath, "utf8") : "";

  const start = original.indexOf(INDEX_START);
  const end = original.indexOf(INDEX_END);

  let next: string;
  if (start !== -1 && end !== -1 && end > start) {
    next = original.slice(0, start) + block + original.slice(end + INDEX_END.length);
  } else if (!existed || original.trim() === "") {
    next = block + "\n";
  } else {
    const gap = original.endsWith("\n") ? "\n" : "\n\n";
    next = original + gap + block + "\n";
  }

  if (next === original) return false;
  writeFileSync(filePath, next);
  return true;
}
