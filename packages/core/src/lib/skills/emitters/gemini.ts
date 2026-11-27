/**
 * "gemini" emitter — embeds the installed agent contract in GEMINI.md.
 * Gemini discovers skills in the canonical `.agents/skills/` directory;
 * this emitter supplies the contract and migrates away its old Skills index.
 * Every byte outside clean managed spans is kept. Ambiguous markers or an
 * unreadable installed contract leave the file unchanged, with a warning.
 */

import { join } from "path";

import type { SkillEmitter } from "../../seams.js";
import { upsertContractBlock } from "./contract-block.js";

export const geminiEmitter: SkillEmitter = {
  agent: "gemini",
  emit(_skills, repoRoot) {
    return upsertContractBlock(join(repoRoot, "GEMINI.md"), "GEMINI.md");
  },
};
