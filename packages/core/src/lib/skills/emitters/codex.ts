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
 * migrates a repo off both; see `migratePrompts`. AGENTS.md is left untouched,
 * with a warning, whenever its markers are ambiguous or a prompt could not be
 * deleted, so the next sync can finish the job.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { parseFrontmatter } from "../../frontmatter-parse.js";

import type { SkillEmitter } from "../../seams.js";
import { CONTRACT_END, CONTRACT_FILE, CONTRACT_START, renderContractBlock } from "./contract-block.js";
import { INDEX_END, INDEX_START } from "./index-block.js";
import { appendBlock, applyEdits, scanBlock, type Edit } from "./managed-block.js";

export { CONTRACT_END, CONTRACT_FILE, CONTRACT_START, renderContractBlock } from "./contract-block.js";

/**
 * A skill name as the Agent Skills specification allows it: lowercase letters,
 * digits and single hyphens, at most 64 characters. Only such a name can come
 * from the index block unambiguously and become a file name without escaping
 * `.codex/prompts/`.
 */
const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** An index row exactly as the old renderer wrote it: `- **<name>** — <description>`. */
const INDEX_ROW = /^- \*\*(.+?)\*\* — (.*)$/;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

type Kind = "absent" | "directory" | "file" | "other";

/**
 * What is at `path`, without following a symlink. Only a missing path counts
 * as absent; any other failure to look (EACCES on an unsearchable parent)
 * throws, because "could not look" is not "nothing there".
 */
function kindOf(path: string): Kind {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    throw e;
  }
}

const RETRY = "kept the old index block so the next sync retries";

/**
 * Whether `file` is byte-for-byte the kind of prompt the old emitter wrote for
 * this index row: frontmatter of exactly `name` and `description`, in that
 * order and JSON-quoted, agreeing with the row.
 */
function isGeneratedPrompt(text: string, name: string, description: string): boolean {
  if (!text.startsWith(`---\nname: ${JSON.stringify(name)}\ndescription: "`)) return false;
  let data: Record<string, unknown>;
  try {
    data = parseFrontmatter(text).data as Record<string, unknown>;
  } catch {
    return false;
  }
  return (
    Object.keys(data).join(",") === "name,description" &&
    data.name === name &&
    typeof data.description === "string" &&
    collapse(data.description) === description
  );
}

/**
 * Delete the `.codex/prompts/` files the old index block proves this emitter
 * wrote. A file is deleted only when its row names a valid skill, it is a
 * regular file directly inside a real `.codex/prompts/` directory, and its
 * content is the old generated template for that row. Anything else is left
 * where it is and reported. Returns false when something could not be
 * inspected, deleted or removed, so the caller keeps the index block, which
 * is the only record of what was ours, and the next sync can retry.
 */
function migratePrompts(
  repoRoot: string,
  indexBlock: string,
  removed: string[],
  warnings: string[]
): boolean {
  const codexDir = join(repoRoot, ".codex");
  const promptsDir = join(codexDir, "prompts");
  try {
    for (const [dir, rel] of [
      [codexDir, ".codex"],
      [promptsDir, ".codex/prompts"],
    ] as const) {
      const kind = kindOf(dir);
      if (kind !== "absent" && kind !== "directory") {
        warnings.push(`\`${rel}\` is not a plain directory; left its prompts in place`);
        return true;
      }
    }
  } catch (e) {
    warnings.push(`could not inspect .codex/prompts (${(e as Error).message}); ${RETRY}`);
    return false;
  }

  let complete = true;
  for (const line of indexBlock.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const row = line.match(INDEX_ROW);
    if (!row || !SKILL_NAME.test(row[1])) {
      warnings.push(`AGENTS.md index row ${JSON.stringify(line)} does not name a skill unambiguously; left any prompt for it in place`);
      continue;
    }
    const [, name, description] = row;
    const rel = `.codex/prompts/${name}.md`;
    const file = join(promptsDir, `${name}.md`);

    let generated: boolean;
    try {
      const kind = kindOf(file);
      if (kind === "absent") continue;
      generated = kind === "file" && isGeneratedPrompt(readFileSync(file, "utf8"), name, description);
    } catch (e) {
      warnings.push(`could not inspect ${rel} (${(e as Error).message}); ${RETRY}`);
      complete = false;
      continue;
    }
    if (!generated) {
      warnings.push(`${rel} is not the prompt brain-kit generated for "${name}"; left in place`);
      continue;
    }
    try {
      rmSync(file);
      removed.push(rel);
    } catch (e) {
      warnings.push(`could not delete ${rel} (${(e as Error).message}); ${RETRY}`);
      complete = false;
    }
  }
  if (!complete) return false;

  // The old emitter created the directories even for zero skills. A directory
  // still holding something (a prompt that was not ours) stays, and so does
  // its parent.
  for (const [dir, rel] of [
    [promptsDir, ".codex/prompts"],
    [codexDir, ".codex"],
  ] as const) {
    try {
      const kind = kindOf(dir);
      if (kind === "absent") continue;
      if (kind !== "directory" || readdirSync(dir).length > 0) break;
      rmdirSync(dir);
      removed.push(rel);
    } catch (e) {
      warnings.push(`could not remove ${rel} (${(e as Error).message}); ${RETRY}`);
      return false;
    }
  }
  return true;
}

export const codexEmitter: SkillEmitter = {
  agent: "codex",
  emit(_skills, repoRoot) {
    const written: string[] = [];
    const removed: string[] = [];
    const warnings: string[] = [];

    const agentsFile = join(repoRoot, "AGENTS.md");
    const original = existsSync(agentsFile) ? readFileSync(agentsFile, "utf8") : null;
    const text = original ?? "";

    const contract = scanBlock(text, { start: CONTRACT_START, end: CONTRACT_END });
    const index = scanBlock(text, { start: INDEX_START, end: INDEX_END });
    for (const [scan, label] of [
      [contract, "contract"],
      [index, "old skills index"],
    ] as const) {
      if (scan.kind === "malformed") {
        warnings.push(`AGENTS.md has ${scan.reason} for the ${label} block; left it unchanged, fix the markers by hand`);
        return { written, removed, warnings };
      }
    }
    if (
      contract.kind === "present" &&
      index.kind === "present" &&
      contract.from < index.to &&
      index.from < contract.to
    ) {
      warnings.push("AGENTS.md has the contract and old skills index blocks overlapping; left it unchanged, fix the markers by hand");
      return { written, removed, warnings };
    }

    const block = renderContractBlock(readFileSync(CONTRACT_FILE, "utf8"));

    if (index.kind === "present") {
      const indexBlock = text.slice(index.from, index.to);
      if (!migratePrompts(repoRoot, indexBlock, removed, warnings)) return { written, removed, warnings };
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
      writeFileSync(agentsFile, next);
      written.push("AGENTS.md");
    }
    return { written, removed, warnings };
  },
};
