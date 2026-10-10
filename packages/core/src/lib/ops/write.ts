/**
 * The write operations behind the core MCP tools (`brain_add`,
 * `brain_update`, `brain_archive`). Each takes resolved dependencies and
 * already-parsed input, writes the markdown, reindexes and returns the
 * result object; the MCP server keeps the schemas, the degraded-config
 * refusal and the mapping to MCP content (#1349).
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";

import { archiveDocument, relevanceOnArchive, type ArchiveResult } from "../archiver.js";
import { updateDocument, type FrontmatterValue } from "../frontmatter-edit.js";
import { indexAll } from "../indexer.js";
import { ingest, type IngestOutcome } from "../ingestion.js";
import { safeResolve, writeFileSafely } from "../safe-path.js";
import type { Taxonomy } from "../taxonomy.js";
import type { DocumentType } from "../types.js";

/** What a write operation needs from the running brain. */
export interface WriteDeps {
  db: Database;
  root: string;
  taxonomy: Taxonomy;
}

/** A comma-separated tag string as a list: trimmed, empties dropped. */
export function splitTags(tags: string): string[] {
  return tags.split(",").map((t) => t.trim()).filter(Boolean);
}

const reindex = (deps: WriteDeps) => (db: Database) =>
  indexAll(db, { root: deps.root, taxonomy: deps.taxonomy, force: false, quiet: true });

export interface AddInput {
  content: string;
  type?: string;
  title?: string;
  tags?: string[];
}

/** Classify, write and index new content, or append it to the document it matches. */
export function addDocument(deps: WriteDeps, input: AddInput): Promise<IngestOutcome> {
  return ingest(
    { content: input.content, type: input.type as DocumentType | undefined, title: input.title, tags: input.tags },
    deps.db,
    { root: deps.root, taxonomy: deps.taxonomy }
  );
}

export interface UpdateInput {
  path: string;
  summary?: string;
  status?: "active" | "archived" | "draft";
  relevance?: "primary" | "secondary" | "historical";
  /** Replaces the document's tags. */
  tags?: string[];
  /** `""` removes the field. */
  deadline?: string;
  /** `""` removes the field. */
  nextReview?: string;
  /** Appended to the end of the body; empty appends nothing. */
  appendContent?: string;
}

export interface UpdateResult {
  path: string;
  updated: string;
  /** The fields that changed, in input order, with `content` for an append. */
  changes: string[];
}

/**
 * Set frontmatter fields and/or append to the body of an existing markdown
 * document, bump `updated` and reindex. Throws when the path leaves the root,
 * is not an existing markdown document, or nothing would change.
 */
export async function updateDocumentFields(deps: WriteDeps, input: UpdateInput): Promise<UpdateResult> {
  const fullPath = safeResolve(deps.root, input.path);
  if (!fullPath) throw new Error("path escapes the brain root directory");
  if (!existsSync(fullPath) || !fullPath.endsWith(".md")) {
    throw new Error(`not an existing markdown document: ${input.path}`);
  }

  const raw = readFileSync(fullPath, "utf-8");
  const updates: Record<string, FrontmatterValue> = {};
  const changes: string[] = [];

  if (input.summary !== undefined) { updates.summary = input.summary; changes.push("summary"); }
  if (input.status !== undefined) { updates.status = input.status; changes.push("status"); }
  if (input.relevance !== undefined) { updates.relevance = input.relevance; changes.push("relevance"); }
  if (input.tags !== undefined) { updates.tags = input.tags; changes.push("tags"); }
  if (input.deadline !== undefined) {
    updates.deadline = input.deadline === "" ? null : input.deadline;
    changes.push("deadline");
  }
  if (input.nextReview !== undefined) {
    updates.next_review = input.nextReview === "" ? null : input.nextReview;
    changes.push("next_review");
  }
  if (input.appendContent) changes.push("content");

  // Archiving by a status edit applies brain_archive's relevance rule
  // (#450) to the effective relevance, including one set in this call.
  if (input.status === "archived") {
    const relevance = relevanceOnArchive(raw, input.relevance);
    if (relevance) {
      updates.relevance = relevance;
      if (!changes.includes("relevance")) changes.push("relevance");
    }
  }

  if (changes.length === 0) throw new Error("no changes specified");

  const updated = new Date().toISOString().split("T")[0];
  updates.updated = updated;
  // Only these keys change; the rest of the frontmatter keeps its bytes (#449).
  // Staged and renamed over the document, so a failed write leaves it whole (#1355).
  writeFileSafely(fullPath, updateDocument(raw, updates, input.appendContent || undefined));
  await reindex(deps)(deps.db);

  return { path: input.path, updated, changes };
}

/** Archive a document and reindex; a dry run previews without writing. */
export function archiveWithReindex(deps: WriteDeps, input: { path: string; dryRun: boolean }): Promise<ArchiveResult> {
  return archiveDocument(deps.root, input.path, {
    dryRun: input.dryRun,
    db: deps.db,
    reindex: input.dryRun ? undefined : reindex(deps),
  });
}
