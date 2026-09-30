/**
 * "gemini" emitter — embeds the installed agent contract in GEMINI.md.
 * Gemini discovers skills in the canonical `.agents/skills/` directory;
 * this emitter supplies the contract and migrates away its old Skills index.
 * Every byte outside clean managed spans is kept. Ambiguous markers or an
 * unreadable installed contract leave the file unchanged, with a warning.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import type { SkillEmitter } from "../../seams.js";
import { CONTRACT_END, CONTRACT_FILE, CONTRACT_START, renderContractBlock } from "./contract-block.js";
import { INDEX_END, INDEX_START } from "./index-block.js";
import { appendBlock, applyEdits, scanBlock, type Edit } from "./managed-block.js";

export const geminiEmitter: SkillEmitter = {
  agent: "gemini",
  emit(_skills, repoRoot) {
    const file = join(repoRoot, "GEMINI.md");
    const original = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    const text = original ?? "";
    const written: string[] = [];
    const removed: string[] = [];
    const warnings: string[] = [];
    const contract = scanBlock(text, { start: CONTRACT_START, end: CONTRACT_END });
    const index = scanBlock(text, { start: INDEX_START, end: INDEX_END });

    for (const scan of [contract, index]) {
      if (scan.kind === "malformed") {
        warnings.push(`GEMINI.md has ${scan.reason}; left it unchanged, fix the markers by hand`);
        return { written, removed, warnings };
      }
    }
    if (
      contract.kind === "present" && index.kind === "present" &&
      contract.from < index.to && index.from < contract.to
    ) {
      warnings.push("GEMINI.md has the contract and old skills index blocks overlapping; left it unchanged, fix the markers by hand");
      return { written, removed, warnings };
    }

    let block: string;
    try {
      block = renderContractBlock(readFileSync(CONTRACT_FILE, "utf8"));
    } catch (e) {
      warnings.push(`could not read the installed CONTRACT.md (${(e as Error).message}); left GEMINI.md unchanged, check the @schlessera/brain installation and retry sync`);
      return { written, removed, warnings };
    }

    const edits: Edit[] = [];
    if (contract.kind === "present") {
      edits.push({ from: contract.from, to: contract.to, insert: block });
      if (index.kind === "present") edits.push({ from: index.from, to: index.to, insert: "" });
    } else if (index.kind === "present") {
      edits.push({ from: index.from, to: index.to, insert: block });
    }
    const next = edits.length > 0 ? applyEdits(text, edits) : appendBlock(text, block);
    if (next !== original) {
      writeFileSync(file, next);
      written.push("GEMINI.md");
    }
    return { written, removed, warnings };
  },
};
