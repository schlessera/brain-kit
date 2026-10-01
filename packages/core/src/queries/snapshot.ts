import { Database } from "bun:sqlite";
import { statSync } from "fs";
import { join } from "path";
import { SCHEMA_VERSION } from "../lib/db.js";
import type { QueryCode, QueryResult, Root } from "./types.js";
/** Private control flow: native messages and input values never escape. */
export class QueryFailure extends Error {
  constructor(readonly code: QueryCode) { super(code); }
}
export type Feature = "graph" | "links" | "voice" | "list" | "find";
const GRAPH_COLUMNS = {
  graph_metrics: ["document_id", "in_degree", "out_degree", "community", "pagerank"],
  graph_communities: ["community", "size", "label", "top_terms"],
  graph_root_distances: ["document_id", "distance"],
  graph_layouts: ["document_id", "mode", "x", "y"],
};
function requireColumns(db: Database, tables: Record<string, string[]>): void {
  for (const [table, required] of Object.entries(tables)) {
    // Table names are private literals, never caller input.
    if (!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
      throw new QueryFailure("corrupt_index");
    const columns = new Set(db.query<{
      name: string;
    }, []>(`PRAGMA table_info(${table})`).all().map(r => r.name));
    if (required.some(column => !columns.has(column)))
      throw new QueryFailure("corrupt_index");
  }
}
function compatibility(db: Database, feature: Feature): {
  meta: Map<string, string>;
  schemaVersion: number;
} {
  requireColumns(db, { index_metadata: ["key", "value"] });
  const meta = new Map(db.query<{
    key: string;
    value: string;
  }, []>("SELECT key, value FROM index_metadata").all().map(r => [r.key, r.value]));
  const version = meta.get("schema_version") ?? "";
  const schemaVersion = Number(version);
  if (!/^[1-9]\d*$/.test(version) || !Number.isSafeInteger(schemaVersion) || schemaVersion < 3 || schemaVersion > SCHEMA_VERSION) {
    throw new QueryFailure("incompatible_index");
  }
  const documents = ["path", "indexed_at"];
  const tables: Record<string, string[]> = { documents };
  if (feature !== "find")
    documents.push("title", "type");
  if (feature === "find")
    documents.push("type", "status", "updated");
  if (feature === "graph") {
    documents.push("id", "asset_type", "updated");
    tables.links = ["source_id", "target_id", "target"];
    if (schemaVersion >= 8)
      Object.assign(tables, GRAPH_COLUMNS);
  }
  if (feature === "links") {
    documents.push("id", "summary", "updated");
    tables.links = ["source_id", "target_id", "target"];
  }
  if (feature === "voice") {
    documents.push("asset_type", "content");
    tables.links = ["target"];
    tables.tags = ["name"];
  }
  if (feature === "list") {
    documents.push("id", "status", "relevance", "updated");
    tables.tags = ["id", "name"];
    tables.document_tags = ["document_id", "tag_id"];
  }
  requireColumns(db, tables);
  return { meta, schemaVersion };
}
function safeCode(error: unknown): QueryCode {
  if (error instanceof QueryFailure)
    return error.code;
  const code = (error as {
    code?: unknown;
  } | null)?.code;
  if (typeof code === "string") {
    if (/^SQLITE_(BUSY|LOCKED)/.test(code))
      return "busy_index";
    if (/^SQLITE_(CORRUPT|NOTADB|ERROR|SCHEMA)/.test(code))
      return "corrupt_index";
    if (code === "ENOENT")
      return "missing_index";
  }
  return "unavailable_index";
}
/** Every call validates, opens afresh, pins compatibility/results, and closes. */
export function withSnapshot<T>(opts: Root, feature: Feature, validate: () => void, read: (db: Database, meta: Map<string, string>, schemaVersion: number) => T): QueryResult<T> {
  let db: Database | undefined;
  try {
    try {
      if (!opts || typeof opts.brainPath !== "string" || !opts.brainPath.trim() || /[\x00-\x1f]/.test(opts.brainPath))
        throw new QueryFailure("invalid_input");
      validate();
      const dbPath = join(opts.brainPath, "brain.db");
      if (!statSync(dbPath).isFile())
        throw new QueryFailure("unavailable_index");
      db = new Database(dbPath, { readonly: true });
      db.run("PRAGMA busy_timeout=100");
      const connection = db;
      return db.transaction(() => {
        const { meta, schemaVersion } = compatibility(connection, feature);
        const newestIndexedAt = connection.query<{
          newest: string | null;
        }, []>("SELECT MAX(indexed_at) AS newest FROM documents").get()?.newest ?? null;
        const value = read(connection, meta, schemaVersion);
        return { ok: true as const, value, snapshot: { schemaVersion, newestIndexedAt } };
      })();
    }
    finally {
      db?.close(true);
    }
  }
  catch (error) {
    const code = safeCode(error);
    return { ok: false, error: { code, retryable: code === "busy_index" } };
  }
}
export function integer(value: unknown): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value)))
    throw new QueryFailure("invalid_input");
}
export function text(value: unknown): void {
  if (value !== undefined && (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value)))
    throw new QueryFailure("invalid_input");
}
export function choice(value: unknown, allowed: readonly string[]): void {
  if (value !== undefined && !allowed.includes(value as string))
    throw new QueryFailure("invalid_input");
}
/** Indexed paths use slash-separated root-relative keys, never filesystem reads. */
export function relativePath(value: unknown): string {
  text(value);
  if (typeof value !== "string" || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\"))
    throw new QueryFailure("invalid_input");
  const parts = value.split("/");
  if (parts.some(p => p === ".." || p === ""))
    throw new QueryFailure("invalid_input");
  return parts.filter(p => p !== ".").join("/") || (() => { throw new QueryFailure("invalid_input"); })();
}
