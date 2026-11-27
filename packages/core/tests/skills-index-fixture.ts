/**
 * Builds the legacy machine-managed "Skills index" block that brain-kit once
 * wrote into GEMINI.md and AGENTS.md, so the emitter tests can stage a file the
 * Codex and Gemini emitters must migrate. Production only keeps the markers
 * (`INDEX_START`, `INDEX_END`); this renderer is the format being migrated.
 */
import { INDEX_END, INDEX_START } from "../src/lib/skills/emitters/index-block";
import type { SkillManifest } from "../src/lib/seams";

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The full legacy block, markers included, skills sorted by name. */
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
