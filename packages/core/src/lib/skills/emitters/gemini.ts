/**
 * "gemini" emitter — maintains the machine-managed Skills index block in
 * GEMINI.md at the repo root (same strategy as the codex emitter's AGENTS.md
 * block; no per-skill files). Content outside the markers is never touched.
 */

import { join } from "path";

import type { SkillEmitter } from "../../seams";
import { upsertIndexBlock } from "./index-block";

export const geminiEmitter: SkillEmitter = {
  agent: "gemini",
  emit(skills, repoRoot) {
    const file = join(repoRoot, "GEMINI.md");
    return {
      written: upsertIndexBlock(file, skills) ? ["GEMINI.md"] : [],
      removed: [],
    };
  },
};
