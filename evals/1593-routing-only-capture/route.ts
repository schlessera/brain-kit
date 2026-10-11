// Pure routing, calibration, tag-handoff parsing and the experimental deterministic
// writer for the #1593 routing-only candidate. No provider is called from this file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import type { Database } from "bun:sqlite";
import type { JevAnswers, JevChoiceAnswer } from "../../packages/core/src/lib/jev";
import { ingest } from "../../packages/core/src/lib/ingestion";
import { updateDocument } from "../../packages/core/src/lib/frontmatter-edit";
import type { Taxonomy } from "../../packages/core/src/lib/taxonomy";

export type Expected = { type: string; target: string | null; tags: string[] };
export type Case = { id: string; split: string; content: string; probes?: string; tagScored?: boolean; expected: Expected };
export type Doc = { path: string; type: string; title: string; tags: string[]; body: string };
export type Floors = { type: number; target: number };
export type Routing = { type: string; target: string | null; explicitTags: string[] | null; abstentions: number; decidedBy: { type: string; target: string } };

/** Types the capture policy describes; core's identity/index types are not capture destinations. */
export function typeMeanings(policy: string): Record<string, string> {
  const section = /Types: ([^.]+)\./.exec(policy)?.[1] ?? "";
  return Object.fromEntries(section.split(";").map((s) => s.trim().split(" = ")).filter((p) => p.length === 2).map(([t, m]) => [t.trim(), m.trim()]));
}

export const explicitType = (content: string, types: string[]) => {
  const t = /^Capture as (\w+)\./i.exec(content.trim())?.[1].toLowerCase();
  return t && types.includes(t) ? t : null;
};
export const explicitTags = (content: string) =>
  /^Tags:\s*([^\n]+)/i.exec(content.trim())?.[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) ?? null;
/** The shipped exact-title rule (`classifyContent`), restricted to the shortlist of append-match records. */
export function exactTarget(content: string, shortlist: Doc[]) {
  const title = content.trim().split("\n")[0].replace(/^#+\s*/, "").trim().toLowerCase();
  return shortlist.find((d) => d.title.toLowerCase() === title) ?? null;
}

/**
 * Code decides exact titles and explicit choices; Jev answers are used only at or
 * above their own floor. Below-floor type falls back to the inbox note and
 * below-floor target to none. Answers overridden by code are not abstentions.
 */
export function route(content: string, answers: JevAnswers | null, floors: Floors, shortlist: Doc[], types: string[]): Routing {
  let abstentions = 0;
  const pick = (id: string, floor: number) => {
    const a = answers?.[id] as JevChoiceAnswer | undefined;
    if (a && a.confidence >= floor) return a.choice;
    abstentions++;
    return null;
  };
  const wantType = explicitType(content, types);
  const exact = exactTarget(content, shortlist);
  let target: Doc | null = exact;
  let targetBy = exact ? "exact-title" : "jev";
  if (!target) {
    const choice = pick("target", floors.target);
    target = shortlist.find((d) => d.path === choice) ?? null;
    if (choice === null) targetBy = "floor-fallback";
  }
  // An explicit type request wins over an append target of another type.
  if (target && wantType && target.type !== wantType) { target = null; targetBy = "explicit-type"; }
  let type: string;
  let typeBy: string;
  if (target) { type = target.type; typeBy = "target"; }
  else if (wantType) { type = wantType; typeBy = "explicit"; }
  else {
    const choice = pick("type", floors.type);
    type = choice && types.includes(choice) ? choice : "note";
    typeBy = choice ? "jev" : "floor-fallback";
  }
  return { type, target: target?.path ?? null, explicitTags: explicitTags(content), abstentions, decidedBy: { type: typeBy, target: targetBy } };
}

export type Judged = { c: Case; answers: JevAnswers };
export type Calibration = { grid: number[]; target: { floor: number; correct: number; wrong: number }[]; type: { floor: number; correct: number }[]; frozen: Floors };

/**
 * Tuning-only, separate floors. Target: the floor with no wrong-target append and
 * the most correct targets, ties toward the higher (more cautious) floor. Type,
 * with that target floor fixed: the most correct types, ties toward the lower floor.
 */
export function calibrate(tuning: Judged[], shortlist: Doc[], types: string[], grid = [0, 0.2, 0.4, 0.6, 0.8, 0.95, 1]): Calibration {
  const target = grid.map((floor) => {
    const routed = tuning.map(({ c, answers }) => ({ c, r: route(c.content, answers, { type: 1, target: floor }, shortlist, types) }));
    return { floor, correct: routed.filter(({ c, r }) => r.target === c.expected.target).length, wrong: routed.filter(({ c, r }) => r.target !== null && r.target !== c.expected.target).length };
  });
  const safe = target.filter((t) => t.wrong === 0).sort((a, b) => b.correct - a.correct || b.floor - a.floor);
  const targetFloor = safe[0]?.floor ?? Infinity;
  const type = grid.map((floor) => ({ floor, correct: tuning.filter(({ c, answers }) => route(c.content, answers, { type: floor, target: targetFloor }, shortlist, types).type === c.expected.type).length }));
  const typeFloor = [...type].sort((a, b) => b.correct - a.correct || a.floor - b.floor)[0].floor;
  return { grid, target, type, frozen: { type: typeFloor, target: targetFloor } };
}

/**
 * The tag handoff: the LLM's reply contributes tags and nothing else. Any other
 * field, including a proposed type or target, is ignored by construction.
 */
export function parseTags(raw: string): { tags: string[]; invalid: boolean } {
  try {
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    if (!value || !Array.isArray(value.tags) || !value.tags.every((t: unknown) => typeof t === "string")) return { tags: [], invalid: true };
    return { tags: [...new Set<string>(value.tags.map((t: string) => t.trim().toLowerCase()).filter(Boolean))], invalid: false };
  } catch {
    return { tags: [], invalid: true };
  }
}

export type WriteContext = { root: string; db: Database; taxonomy: Taxonomy; shortlist: Doc[]; date: string };

/**
 * The experimental deterministic writer. It appends only to a shortlisted
 * append-match record revalidated on disk, as a dated section after the
 * unchanged old body, retaining its metadata. Everything else is created
 * through shipped ingestion with an explicit type, which never appends, and the
 * selected tag set is written exactly, including an empty set.
 */
export async function writeCapture(content: string, selection: { type: string; target: string | null; tags: string[] }, ctx: WriteContext) {
  const doc = selection.target ? ctx.shortlist.find((d) => d.path === selection.target) : undefined;
  const full = doc ? join(ctx.root, doc.path) : null;
  if (doc && full && existsSync(full)) {
    const old = readFileSync(full, "utf8");
    const data = parseFrontmatter(old).data;
    if (data.type === doc.type && ctx.taxonomy.appendMatchTypes().includes(doc.type) && String(data.title).toLowerCase() === doc.title.toLowerCase()) {
      writeFileSync(full, updateDocument(old, { updated: ctx.date }, `## ${ctx.date} Update\n\n${content.trim()}`));
      return { action: "appended" as const, path: doc.path };
    }
  }
  const type = ctx.taxonomy.isValidType(selection.type) ? selection.type : ctx.taxonomy.inboxType();
  const result = await ingest({ content, type, tags: selection.tags }, ctx.db, { root: ctx.root, taxonomy: ctx.taxonomy });
  const path = join(ctx.root, result.path);
  writeFileSync(path, updateDocument(readFileSync(path, "utf8"), { tags: selection.tags }));
  return { action: "created" as const, path: result.path, refusedTarget: selection.target && !doc ? selection.target : undefined };
}

/** Scores one write from the Markdown files before and after it. */
export function scoreWrite(content: string, expected: Expected, before: Record<string, string>, after: Record<string, string>, isValidType: (t: string) => boolean) {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]);
  const changed = Object.fromEntries(paths.map((p) => [p, after[p] ?? ""]));
  const appended = paths.filter((p) => p in before);
  const captured = paths.filter((p) => after[p] && parseFrontmatter(after[p]).content.includes(content.trim()));
  const chosen = captured[0] ?? paths[0];
  const parsed = chosen && after[chosen] ? parseFrontmatter(after[chosen]) : null;
  const tags = Array.isArray(parsed?.data.tags) ? parsed.data.tags.map(String) : [];
  const oldContentLoss = paths.some((p) => p in before && (!after[p] || !parseFrontmatter(after[p]).content.includes(parseFrontmatter(before[p]).content.trim())));
  return {
    type: String(parsed?.data.type ?? "invalid"), target: appended[0] ?? null, tags,
    invalid: paths.length !== 1 || !parsed || !isValidType(String(parsed.data.type)), abstentions: Number(paths.length === 0),
    literalViolation: captured.length !== 1, oldContentLoss, pendingSemanticReview: captured.length !== 1,
    contentLoss: captured.length !== 1 || oldContentLoss, wrongTarget: appended.some((p) => p !== expected.target), changed,
  };
}
export type Observation = ReturnType<typeof scoreWrite> & { answers?: JevAnswers | null; routing?: Routing; tagInvalid?: boolean; tagRaw?: string };
