/** Fixed internal repair table. Preview is read-only; apply reconstructs a bounded
 * effect from current detection and checks both the fingerprint and preview premise.
 * Receipts are markdown, never authoritative state in brain.db. */
import { createHash, randomBytes } from "crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

import { loadAuditDocs } from "./auditor.js";
import type { BrainContext } from "./context.js";
import { hasDocumentsColumn, openDatabase } from "./db.js";
import { frontmatterLength } from "./document-parts.js";
import { editFrontmatter, type FrontmatterValue } from "./frontmatter-edit.js";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { canonicalFindings, detectCandidates, HYGIENE_DIR, HygieneLogError, readHygieneLog, reconcile, replaceIfUnchanged, type HygieneFinding } from "./hygiene.js";
import { getMarkdownFiles, indexAll } from "./indexer.js";
import { safeResolve, writeFileSafely } from "./safe-path.js";
import type { Taxonomy } from "./taxonomy.js";
import { validateDetailed } from "./validate.js";

export const CONFIG_BLOCKER_ID = "configuration-blocker";
type HandlerName = "link-suggested" | "link-note" | "link-text" | "required-field" | "manual" | "blocker";
type InputSchema = { type: "none" | "string" | "enum" | "date" | "strings" | "path"; values?: string[]; example?: string };
export interface RepairHandler {
  name: HandlerName;
  category: string;
  kind: "choice" | "field" | "manual" | "blocker";
  input: InputSchema;
  effect: string;
  postCheck: string;
  path: string | null;
  line: number | null;
  explanation: string;
  suggestedPath?: string;
}
interface RepairRequest {
  id: string;
  handler: string;
  input: unknown;
  expectFingerprint: string;
  expectPreview?: string;
  dryRun?: boolean;
}
export interface RepairResult {
  status: "preview" | "fixed" | "stale" | "refused" | "check_failed" | "undone" | "still_detected" | "not_detected" | "blocked" | "ready";
  id: string;
  reason?: string;
  fieldError?: { field: string; message: string };
  code?: string;
  handler?: RepairHandler;
  diff?: { path: string; before: string; after: string; changes: Array<{ before: string; after: string; line: number }> };
  previewToken?: string;
  undoToken?: string;
  changedFiles?: string[];
}
interface Plan {
  after: string;
  premise: string;
  changes: Array<{ before: string; after: string; line: number }>;
}
interface Receipt { id: string; path: string; before: string; after: string; handler: string }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

/** Fresh projection in memory: previews/checks never create or refresh brain.db.
 * Preserve accepted-mtime baselines from the existing disposable index. */
export async function repairDetection(brain: BrainContext, now: Date) {
  const db = openDatabase(":memory:");
  try {
    await indexAll(db, { root: brain.root, taxonomy: brain.taxonomy, force: false, quiet: true });
    if (existsSync(brain.dbPath)) {
      // Even a read-only SQLite connection updates WAL shared-memory bytes.
      // Read a private copy so check/preview changes no source file or sidecar.
      const dir = mkdtempSync(join(tmpdir(), "brain-hygiene-index-"));
      let previous;
      try {
        const copy = join(dir, "brain.db");
        copyFileSync(brain.dbPath, copy);
        if (existsSync(`${brain.dbPath}-wal`)) copyFileSync(`${brain.dbPath}-wal`, `${copy}-wal`);
        previous = openDatabase(copy, { readonly: true });
      } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
      try {
        if (hasDocumentsColumn(previous, "accepted_mtime")) {
          for (const row of previous.query("SELECT path, accepted_mtime FROM documents WHERE accepted_mtime IS NOT NULL").all() as Array<{ path: string; accepted_mtime: string }>) {
            db.query("UPDATE documents SET accepted_mtime = ? WHERE path = ?").run(row.accepted_mtime, row.path);
          }
        }
      } finally { previous.close(); rmSync(dir, { recursive: true, force: true }); }
    }
    const detection = await detectCandidates(db, brain, now);
    return { ...detection, findings: canonicalFindings(detection.candidates), docs: new Map(loadAuditDocs(db).map(d => [d.path, d])) };
  } finally { db.close(); }
}

function documentPath(brain: BrainContext, path: string, files = getMarkdownFiles(brain.root, brain.taxonomy)): string | null {
  const abs = safeResolve(brain.root, path);
  if (!abs || !path.endsWith(".md") || !files.includes(path)) return null;
  try { return lstatSync(join(brain.root, path)).isFile() ? abs : null; }
  catch { return null; }
}

/** Exactly one note by deterministic slug, alias or exact title. No proximity/fuzzy score. */
function suggestedNote(brain: BrainContext, target: string): string | null {
  const name = target.split("#")[0].replace(/\.md$/, "");
  const slug = basename(name);
  const files = getMarkdownFiles(brain.root, brain.taxonomy);
  const matches = files.filter(path => {
    if (!documentPath(brain, path, files)) return false;
    let data: Record<string, unknown> = {};
    try { data = parseFrontmatter(readFileSync(join(brain.root, path), "utf8")).data; } catch { /* Only a literal slug can match malformed metadata. */ }
    return basename(path, ".md") === slug || data.title === name ||
      (Array.isArray(data.aliases) && data.aliases.some(a => typeof a === "string" && a.toLowerCase().trim() === name.toLowerCase()));
  });
  return matches.length === 1 ? matches[0] : null;
}

function fieldSchema(field: string, taxonomy: Taxonomy): InputSchema | null {
  if (field === "title") return { type: "string", example: "Return to Ithaca" };
  if (field === "type") return { type: "enum", values: taxonomy.validTypes() };
  if (field === "created" || field === "updated") return { type: "date", example: "2026-07-12" };
  if (field === "tags") return { type: "strings", example: '["voyage"]' };
  return null;
}

/** Fixed category table, also consumed by the selection/server layers. */
export function repairHandlers(brain: BrainContext, finding: HygieneFinding): RepairHandler[] {
  const base = { category: finding.category, path: finding.path, line: 1, explanation: finding.message };
  if (finding.category === "broken-link") {
    const abs = documentPath(brain, finding.path);
    if (abs) {
      const raw = readFileSync(abs, "utf8");
      base.line = linkSpans(raw, finding.evidence)[0]?.line ?? 1;
    }
    const suggestion = suggestedNote(brain, finding.evidence);
    return [
      ...(suggestion ? [{ ...base, name: "link-suggested" as const, kind: "choice" as const, input: { type: "none" as const }, effect: "Replace this target's link tokens with the suggested note", postCheck: "file-validation", suggestedPath: suggestion }] : []),
      { ...base, name: "link-note", kind: "choice", input: { type: "path" }, effect: "Replace this target's link tokens with the selected note", postCheck: "file-validation" },
      { ...base, name: "link-text", kind: "choice", input: { type: "none" }, effect: "Keep display text and remove this target's link tokens", postCheck: "file-validation" },
    ];
  }
  if (["todo", "verify"].includes(finding.category)) {
    const abs = documentPath(brain, finding.path);
    if (abs) {
      const text = readFileSync(abs, "utf8");
      const marker = finding.category === "todo" ? "[TODO:" : "[VERIFY:";
      base.line = lineAt(text, Math.max(0, text.indexOf(marker)));
    }
  }
  const schema = finding.category === "required-field" ? fieldSchema(finding.evidence, brain.taxonomy) : null;
  if (schema) return [{ ...base, name: "required-field", kind: "field", input: schema, effect: `Set only ${finding.evidence}`, postCheck: "file-validation" }];
  return [{ ...base, name: "manual", kind: "manual", input: { type: "none" }, effect: "Open file and edit manually; then check again", postCheck: "detection", explanation: "This category requires a manual edit. Checking again does not apply a repair." }];
}

/** Same code exclusions and targets as wikiLinkTokens, with positions retained. */
function linkSpans(raw: string, target: string) {
  const offset = frontmatterLength(raw);
  const body = raw.slice(offset);
  const masked = body.replace(/```[\s\S]*?```/g, m => " ".repeat(m.length)).replace(/`[^`\n]*`/g, m => " ".repeat(m.length));
  const spans: Array<{ start: number; end: number; token: string; label: string; line: number }> = [];
  for (const m of masked.matchAll(/\[\[([^\]]+)\]\]/g)) {
    if (m[1].split("|")[0].trim() !== target) continue;
    const start = offset + m.index;
    spans.push({ start, end: start + m[0].length, token: m[0], label: m[1].includes("|") ? m[1].slice(m[1].indexOf("|") + 1) : target, line: lineAt(raw, start) });
  }
  return spans;
}

function fieldError(field: string, schema: InputSchema, value: unknown): string | null {
  if (schema.type === "strings") return Array.isArray(value) && value.length > 0 && value.every(v => typeof v === "string" && v.trim() && v === v.toLowerCase() && !/\s/.test(v)) ? null : 'Use a non-empty list of lowercase hyphenated tags, for example ["voyage"].';
  if (typeof value !== "string" || !value.trim()) return `Enter a non-empty ${field}.`;
  if (schema.type === "enum" && !schema.values?.includes(value)) return `Use one of: ${schema.values?.join(", ")}.`;
  if (schema.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return "Use YYYY-MM-DD, for example 2026-07-12.";
  return null;
}

function plan(brain: BrainContext, finding: HygieneFinding, handler: RepairHandler, input: unknown, before: string): Plan | RepairResult {
  if (handler.kind === "manual") return { status: "refused", id: finding.id, reason: "manual-only", handler };
  if (handler.name === "required-field") {
    const error = fieldError(finding.evidence, handler.input, input);
    if (error) return { status: "refused", id: finding.id, reason: "invalid-input", fieldError: { field: finding.evidence, message: error } };
    const after = editFrontmatter(before, { [finding.evidence]: input as FrontmatterValue });
    // Never serialize on refusal: a field edit has no authority over other keys.
    if (after === null) return { status: "refused", id: finding.id, reason: "frontmatter-edit-refused" };
    // Strip the unchanged prefix/suffix: include the raw replacement bytes and
    // key spelling in the premise, without binding unrelated frontmatter keys.
    let start = 0, end = 0;
    while (start < before.length && before[start] === after[start]) start++;
    while (end < before.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
    const old = before.slice(start, before.length - end), replacement = after.slice(start, after.length - end);
    return { after, premise: JSON.stringify([finding.evidence, old, replacement]), changes: [{ before: old, after: replacement, line: lineAt(before, start) }] };
  }
  if (handler.name !== "link-note" && input !== null) return { status: "refused", id: finding.id, reason: "invalid-input" };
  const path = handler.name === "link-suggested" ? handler.suggestedPath : input;
  if (handler.name !== "link-text" && (typeof path !== "string" || !documentPath(brain, path) || /[\[\]|#\r\n]/.test(path))) return { status: "refused", id: finding.id, reason: "not-a-contained-document" };
  const spans = linkSpans(before, finding.evidence);
  if (spans.length === 0) return { status: "stale", id: finding.id, reason: "link-premise-changed" };
  const changes = spans.map(s => ({ before: s.token, after: handler.name === "link-text" ? s.label : `[[${(path as string).replace(/\.md$/, "")}${finding.evidence.includes("#") ? "#" + finding.evidence.split("#").slice(1).join("#") : ""}|${s.label}]]`, line: s.line }));
  let after = before;
  for (let i = spans.length - 1; i >= 0; i--) after = after.slice(0, spans[i].start) + changes[i].after + after.slice(spans[i].end);
  return { after, premise: JSON.stringify(changes.map(c => [c.before, c.after])), changes };
}

function logContained(root: string): boolean {
  const canonicalRoot = safeResolve(root, ".");
  if (!canonicalRoot) return false;
  const expected = join(canonicalRoot, HYGIENE_DIR);
  return safeResolve(root, HYGIENE_DIR) === expected && ["open.md", "snoozed.md", "dismissed.md", "resolved.md", "_index.md", "last-run.md", "repairs"].every(name => safeResolve(root, `${HYGIENE_DIR}/${name}`) === join(expected, name));
}

async function markResolved(brain: BrainContext, id: string, by: string, now: Date): Promise<string[]> {
  if (!logContained(brain.root)) throw new HygieneLogError("hygiene log is not contained");
  const d = await repairDetection(brain, now);
  if (d.failedChecks.length || d.findings.has(id)) throw new HygieneLogError("resolution check did not complete");
  return reconcile(brain.root, d.candidates, d.docs, { now, resolution: { id, by } }).changedFiles;
}

/** Apply uses the same real validation as preview/detection; tests inject a
 * failing post-check after a real write without replacing the writer. */
export async function resolveHygiene(brain: BrainContext, request: RepairRequest, options: { now?: Date; postCheck?: (path: string) => string | null } = {}): Promise<RepairResult> {
  const now = options.now ?? new Date();
  const d = await repairDetection(brain, now);
  const finding = d.findings.get(request.id);
  if (!finding || finding.fingerprint !== request.expectFingerprint) return { status: "stale", id: request.id, reason: "stale-fingerprint" };
  const handler = repairHandlers(brain, finding).find(h => h.name === request.handler);
  if (!handler) return { status: "refused", id: request.id, reason: "handler-unavailable" };
  const abs = documentPath(brain, finding.path);
  if (!abs || !logContained(brain.root)) return { status: "refused", id: request.id, reason: "not-a-contained-document" };
  const sourceBytes = readFileSync(abs);
  const before = sourceBytes.toString("utf8");
  if (!Buffer.from(before, "utf8").equals(sourceBytes)) return { status: "refused", id: request.id, reason: "not-utf8" };
  const effect = plan(brain, finding, handler, request.input, before);
  if ("status" in effect) return effect;
  const previewToken = hash(JSON.stringify([finding.id, finding.fingerprint, request.handler, request.input, effect.premise]));
  const diff = { path: finding.path, before, after: effect.after, changes: effect.changes };
  if (request.dryRun) return { status: "preview", id: request.id, handler, diff, previewToken };
  if (request.expectPreview !== previewToken) return { status: "stale", id: request.id, reason: "preview-premise-changed" };
  if (!readHygieneLog(brain.root).some(e => e.id === request.id && e.state === "open")) return { status: "refused", id: request.id, reason: "finding-not-open" };
  if (d.failedChecks.length) return { status: "refused", id: request.id, reason: "detection-unavailable" };
  const token = randomBytes(16).toString("hex");
  const receipt: Receipt = { id: request.id, path: finding.path, before, after: effect.after, handler: request.handler };
  const receipts = safeResolve(brain.root, `${HYGIENE_DIR}/repairs`)!;
  mkdirSync(receipts, { recursive: true });
  const receiptPath = join(receipts, `${token}.md`);
  const day = now.toISOString().slice(0, 10);
  const tag = brain.taxonomy.tags?.vocabulary?.[0] ?? brain.taxonomy.tags?.aliases?.hygiene ?? "hygiene";
  const metadata = `---\ntitle: Hygiene repair receipt\ntype: ${JSON.stringify(brain.taxonomy.validTypes()[0])}\ncreated: ${day}\nupdated: ${day}\ntags: ${JSON.stringify([tag])}\n---\n`;
  writeFileSafely(receiptPath, `${metadata}# Hygiene repair receipt\n\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\`\n`, { replace: false });
  try {
    replaceIfUnchanged(abs, effect.after, before, () => {
      if (!readFileSync(abs).equals(sourceBytes) || documentPath(brain, finding.path) !== abs) throw new HygieneLogError("document path changed");
    });
  } catch (e) {
    if (!(e instanceof HygieneLogError)) throw e;
    if (safeResolve(brain.root, `${HYGIENE_DIR}/repairs/${token}.md`) === receiptPath) rmSync(receiptPath);
    return { status: "stale", id: request.id, reason: "write-premise-changed" };
  }
  let code: string | null;
  try {
    code = options.postCheck ? options.postCheck(finding.path) : validateDetailed(brain.root, brain.taxonomy).find(i => i.file === finding.path)?.detail.rule ?? null;
    if (!code) {
      const after = await repairDetection(brain, now);
      code = after.failedChecks[0] ?? (after.findings.has(request.id) ? "still-detected" : null);
    }
  } catch { code = "validation-unavailable"; }
  if (code) return { status: "check_failed", id: request.id, code, undoToken: token, changedFiles: [finding.path] };
  // A publication/storage exception is an internal error with an uncertain
  // receipt, not a post-check failure that promises an unchanged open log.
  const changed = await markResolved(brain, request.id, `handler:${request.handler}`, now);
  return { status: "fixed", id: request.id, changedFiles: [finding.path, ...changed] };
}

export function undoHygiene(brain: BrainContext, token: string, dryRun: boolean): RepairResult {
  const refused: RepairResult = { status: "refused", id: "", reason: "invalid-undo-token" };
  if (!/^[0-9a-f]{32}$/.test(token) || !logContained(brain.root)) return refused;
  const file = safeResolve(brain.root, `${HYGIENE_DIR}/repairs/${token}.md`);
  if (!file || !existsSync(file)) return refused;
  let receipt: Receipt;
  try {
    const text = readFileSync(file, "utf8");
    receipt = JSON.parse(/```json\n([^\n]+)\n```/.exec(text)?.[1] ?? "");
    if (![receipt.id, receipt.path, receipt.before, receipt.after, receipt.handler].every(v => typeof v === "string")) return refused;
  } catch { return refused; }
  const abs = documentPath(brain, receipt.path);
  if (!abs) return { ...refused, id: receipt.id, reason: "not-a-contained-document" };
  if (!readFileSync(abs).equals(Buffer.from(receipt.after, "utf8"))) return { status: "stale", id: receipt.id, reason: "undo-premise-changed" };
  const diff = { path: receipt.path, before: receipt.after, after: receipt.before, changes: [{ before: receipt.after, after: receipt.before, line: 1 }] };
  if (dryRun) return { status: "preview", id: receipt.id, diff };
  try {
    replaceIfUnchanged(abs, receipt.before, receipt.after, () => {
      if (!readFileSync(abs).equals(Buffer.from(receipt.after, "utf8")) || documentPath(brain, receipt.path) !== abs) throw new HygieneLogError("document path changed");
    });
  } catch (e) {
    if (!(e instanceof HygieneLogError)) throw e;
    return { status: "stale", id: receipt.id, reason: "undo-premise-changed" };
  }
  return { status: "undone", id: receipt.id, changedFiles: [receipt.path] };
}

/** Check-only completion: still-detected and failed checks write nothing. */
export async function checkHygiene(brain: BrainContext, id: string, now = new Date()): Promise<RepairResult> {
  if (!logContained(brain.root)) return { status: "refused", id, reason: "log-not-contained" };
  if (!readHygieneLog(brain.root).some(e => e.id === id)) return { status: "refused", id, reason: "unknown-finding" };
  let d;
  try { d = await repairDetection(brain, now); }
  catch { return { status: "check_failed", id, code: "detection-unavailable" }; }
  if (d.failedChecks.length) return { status: "check_failed", id, code: d.failedChecks[0] };
  if (d.findings.has(id)) return { status: "still_detected", id, handler: repairHandlers(brain, d.findings.get(id)!)[0] };
  const changedFiles = await markResolved(brain, id, "check", now);
  return { status: "not_detected", id, changedFiles };
}
