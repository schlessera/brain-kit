/** The installed agent contract shared by the Codex and Gemini emitters. */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

import { INDEX_END, INDEX_START } from "./index-block.js";
import { appendBlock, applyEdits, scanBlock, type Edit } from "./managed-block.js";

export const CONTRACT_START = "<!-- brain-kit:contract:start -->";
export const CONTRACT_END = "<!-- brain-kit:contract:end -->";

/** `<core>/CONTRACT.md`, at the same relative depth from src/ and dist/. */
export const CONTRACT_FILE = resolve(import.meta.dir, "../../../../CONTRACT.md");

/** The installed body, with only surrounding whitespace normalized, inside managed markers. */
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

/** What {@link upsertContractBlock} did to the file, emitter-shaped. */
export interface ContractBlockResult {
  written: string[];
  removed: string[];
  warnings: string[];
}

export interface ContractBlockHooks {
  /**
   * Runs once the file's markers are known to be clean and the contract was
   * read, before anything is written, with the old skills index block when
   * the file has one. Returning false leaves the file unchanged; the hook
   * reports why through `result.warnings`.
   */
  migrateIndex?(indexBlock: string, result: ContractBlockResult): boolean;
}

/**
 * Put the installed contract between the contract markers of `file` (an
 * agent's instructions file, reported as `label`), replacing the old skills index block if there is
 * one, or append it. Every byte outside clean managed spans is kept. Ambiguous
 * or overlapping markers, an unreadable installed contract, or a refusing hook
 * leave the file unchanged, with a warning.
 */
export function upsertContractBlock(file: string, label: string, hooks: ContractBlockHooks = {}): ContractBlockResult {
  const result: ContractBlockResult = { written: [], removed: [], warnings: [] };
  const original = existsSync(file) ? readFileSync(file, "utf8") : null;
  const text = original ?? "";

  const contract = scanBlock(text, { start: CONTRACT_START, end: CONTRACT_END });
  const index = scanBlock(text, { start: INDEX_START, end: INDEX_END });
  for (const [scan, block] of [
    [contract, "contract"],
    [index, "old skills index"],
  ] as const) {
    if (scan.kind === "malformed") {
      result.warnings.push(`${label} has ${scan.reason} for the ${block} block; left it unchanged, fix the markers by hand`);
      return result;
    }
  }
  if (contract.kind === "present" && index.kind === "present" && contract.from < index.to && index.from < contract.to) {
    result.warnings.push(`${label} has the contract and old skills index blocks overlapping; left it unchanged, fix the markers by hand`);
    return result;
  }

  let block: string;
  try {
    block = renderContractBlock(readFileSync(CONTRACT_FILE, "utf8"));
  } catch (e) {
    result.warnings.push(
      `could not read the installed CONTRACT.md (${(e as Error).message}); left ${label} unchanged, check the @schlessera/brain installation and retry sync`
    );
    return result;
  }

  if (index.kind === "present" && hooks.migrateIndex && !hooks.migrateIndex(text.slice(index.from, index.to), result)) {
    return result;
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
    result.written.push(label);
  }
  return result;
}
