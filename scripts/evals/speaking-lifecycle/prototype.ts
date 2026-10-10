/** Private #846 controls. Proposed fields/regions are not a production migration. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { archiveDocument } from "../../../packages/core/src/lib/archiver";
import { editFrontmatter } from "../../../packages/core/src/lib/frontmatter-edit";
import { parseFrontmatter } from "../../../packages/common/src/frontmatter-parse";
import { readGeneratedRegion, rewriteGeneratedRegion } from "../../../packages/core/src/lib/generated-regions";
import { renderRegistry } from "../../../packages/core/src/lib/index-registry";
import type { Taxonomy } from "../../../packages/core/src/lib/taxonomy";
import { apply as applyWrites, capture, type Input, type Plan } from "../mechanical-hygiene/prototype";

export { capture };
export const REGION = "speaking-eval";
export const OUTCOMES = ["accepted", "rejected", "waitlisted", "backup"] as const;
export interface Decision {
  kind: "outcome" | "withdrawal" | "delivery" | "close";
  conference: string;
  submission: string;
  outcome?: typeof OUTCOMES[number];
  date: string;
  source: string;
  confirmation?: string;
  slides?: string;
  conditions?: string;
  confirmed: boolean;
  eventOver?: boolean;
}
export interface Choices {
  conference?: { choice: string; confidence: number };
  submission?: { choice: string; confidence: number };
  outcome?: { choice: string; confidence: number };
}
export interface LifecyclePlan extends Plan { receipt?: string }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const value = (input: Input, key: string): string => input.data[key] instanceof Date ? sourceDay(input, key) : typeof input.data[key] === "string" ? input.data[key] as string : "";
export function day(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(text)) && new Date(text).toISOString().slice(0, 10) === text;
}
function sourceDay(input: Input, key: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(input.raw)?.[1] ?? "";
  const match = new RegExp(`^${key}: *["']?(\\d{4}-\\d{2}-\\d{2})["']? *\\r?$`, "m").exec(frontmatter);
  if (!match || !day(match[1])) throw new Error(`missing or invalid ${key}`);
  return match[1];
}
function editable(input: Input, taxonomy: Taxonomy): boolean {
  const inbox = taxonomy.dirForType(taxonomy.inboxType());
  return !taxonomy.isExcludedPath(input.path) && !input.path.split("/").includes("archived") &&
    input.data.status !== "archived" && !(inbox && input.path.startsWith(`${inbox}/`));
}
function unique(inputs: Input[], predicate: (input: Input) => boolean, what: string): Input {
  const found = inputs.filter(predicate);
  if (found.length !== 1) throw new Error(`missing or ambiguous ${what}`);
  return found[0];
}

/** Fixed-answer proposal control; confirmation is separate, trusted input, never classifier permission. */
export function admit(decision: Decision, choices: Choices | null, floor: number): Decision | null {
  if (!choices || decision.kind !== "outcome" || !Number.isFinite(floor) || floor < 0 || floor > 1) return null;
  const answers = [choices.conference, choices.submission, choices.outcome];
  if (answers.some(a => !a || !Number.isFinite(a.confidence) || a.confidence < floor || a.confidence > 1)) return null;
  if (choices.conference!.choice !== decision.conference || choices.submission!.choice !== decision.submission || choices.outcome!.choice !== decision.outcome) return null;
  return decision.confirmed === true ? decision : null;
}

export function questions(inputs: Input[], source: string) {
  const submissions = inputs.filter(i => value(i, "submission_id"));
  return {
    outcome: { accepted: "The selected submission is accepted, including explicit conditions.", rejected: "The selected submission is not selected.", waitlisted: "The selected submission is on a waitlist.", backup: "The selected submission is held as backup.", unclear: "No unambiguous outcome for that submission." },
    conference: ["none", ...new Set(submissions.map(i => value(i, "conference_id")))],
    submission: ["none", ...submissions.map(i => value(i, "submission_id"))],
    state: { untrusted_source: source, candidates: submissions.map(i => ({ id: value(i, "submission_id"), conference: value(i, "conference_id"), talk: value(i, "talk_id"), title: value(i, "title") })) },
  };
}

/** Plan on a disposable copy, exercising the real archive helper before any authoritative write. */
export async function plan(inputs: Input[], taxonomy: Taxonomy, decision: Decision | null, paths: { conferences: string; talks: string; focus: string }, asOf: string): Promise<LifecyclePlan> {
  const result: LifecyclePlan = { inputs, edits: [], refused: [] };
  if (!decision) return { ...result, refused: [{ path: "(decision)", reason: "missing/unclear answer" }] };
  const stage = mkdtempSync(join(tmpdir(), "brain-speaking-stage-"));
  try {
    if (decision.confirmed !== true || !["outcome", "withdrawal", "delivery", "close"].includes(decision.kind) || typeof decision.source !== "string" || !decision.source.trim() || !day(asOf) || !day(decision.date) || decision.date > asOf) throw new Error("unconfirmed or invalid/future decision date");
    if (taxonomy.dirForType("conference") !== paths.conferences || taxonomy.dirForType("talk") !== paths.talks) throw new Error("configured domain paths disagree");
    const target = unique(inputs, i => value(i, "submission_id") === decision.submission, "submission identity");
    const hub = unique(inputs, i => value(i, "conference_id") === decision.conference && !value(i, "submission_id") && i.data.type === "conference" && i.path.startsWith(`${paths.conferences}/`), "conference identity");
    const talk = unique(inputs, i => value(i, "talk_id") === value(target, "talk_id") && i.data.type === "talk", "talk identity");
    if (value(target, "conference_id") !== decision.conference || target.data.type !== "conference" || !target.path.startsWith(`${paths.conferences}/`) || !talk.path.startsWith(`${paths.talks}/`)) throw new Error("target relationship mismatch");
    if (![target, hub, talk].every(i => editable(i, taxonomy))) throw new Error("excluded or archived target");
    const submissions = inputs.filter(i => value(i, "submission_id") && i.data.type === "conference" && i.path.startsWith(`${paths.conferences}/`));
    const related = [hub, ...submissions.filter(i => value(i, "conference_id") === decision.conference)];
    if (new Set(submissions.map(i => value(i, "submission_id"))).size !== submissions.length) throw new Error("duplicate submission identity");
    const start = sourceDay(hub, "conference_start"), end = sourceDay(hub, "conference_end");
    if (start > end) throw new Error("invalid conference interval");
    for (const input of inputs) {
      mkdirSync(dirname(join(stage, input.path)), { recursive: true });
      writeFileSync(join(stage, input.path), input.raw);
    }
    const raw = (i: Input) => readFileSync(join(stage, i.path), "utf8");
    const set = (i: Input, fields: Record<string, string>) => {
      const next = editFrontmatter(raw(i), fields);
      if (next === null) throw new Error("unsupported frontmatter edit");
      writeFileSync(join(stage, i.path), next);
    };
    const receipt = hash(JSON.stringify({ kind: decision.kind, conference: decision.conference, submission: decision.submission, outcome: decision.outcome, date: decision.date, confirmation: decision.confirmation, slides: decision.slides, conditions: decision.conditions, eventOver: decision.eventOver }));
    result.receipt = receipt;
    if (decision.kind === "outcome" || decision.kind === "withdrawal") {
      if (!editable(target, taxonomy) || value(target, "delivered_on")) throw new Error("closed submission cannot receive an outcome");
      const previous = value(target, "outcome_date");
      if (previous && (!day(previous) || decision.date < previous)) throw new Error("older decision");
      const outcome = decision.kind === "withdrawal" ? "withdrawn" : decision.outcome;
      if (!outcome || ![...OUTCOMES, "withdrawn"].includes(outcome)) throw new Error("unsupported outcome");
      if (value(target, "decision_receipt") !== receipt) {
        const fields: Record<string, string> = { speaking_outcome: outcome, outcome_date: decision.date, decision_receipt: receipt, decision_source_sha256: hash(decision.source), updated: asOf, outcome_history: `${value(target, "outcome_history")}; ${decision.date} ${outcome}` };
        for (const [field, label, supplied] of [["confirmation_deadline", "Confirmation deadline", decision.confirmation], ["slides_deadline", "Slides deadline", decision.slides]] as const) {
          if (supplied !== undefined) {
            if (outcome !== "accepted" || !day(supplied) || !decision.source.split(/\r?\n/).includes(`${label}: ${supplied}`)) throw new Error("deadline lacks exact sourced value");
            fields[field] = supplied;
          }
        }
        if (decision.conditions !== undefined) fields.speaking_conditions = decision.conditions;
        set(target, fields);
      }
    } else if (decision.kind === "delivery") {
      if (value(target, "speaking_outcome") !== "accepted" || decision.date < start || decision.date > end) throw new Error("delivery outside accepted event lifecycle");
      if (value(target, "delivered_on") && value(target, "delivered_on") !== decision.date) throw new Error("conflicting delivery date");
      set(target, { delivered_on: decision.date, updated: asOf });
    } else {
      if (decision.eventOver !== true || decision.date < end) throw new Error("conference is not explicitly over");
      set(hub, { conference_phase: "closed", updated: asOf });
      for (const input of related.filter(i => i.data.status !== "archived")) {
        await archiveDocument(stage, input.path);
        // The existing helper uses the wall clock; pin only the disposable evaluation copy.
        set(input, { updated: asOf });
      }
    }
    const current = inputs.map(i => ({ ...i, raw: raw(i), data: parseFrontmatter(raw(i)).data }));
    const currentSubmissions = current.filter(i => submissions.some(s => s.path === i.path));
    const active = currentSubmissions.filter(i => i.data.status !== "archived" && value(i, "speaking_outcome") === "accepted" && !value(i, "delivered_on"));
    const projectedHub = current.find(i => i.path === hub.path)!;
    const allForHub = currentSubmissions.filter(i => value(i, "conference_id") === decision.conference);
    const counts = [...new Set(allForHub.map(i => value(i, "speaking_outcome")))].sort().map(outcome => `${allForHub.filter(i => value(i, "speaking_outcome") === outcome).length} ${outcome}`).join(", ");
    const deadlines = allForHub.filter(i => i.data.status !== "archived" && value(i, "speaking_outcome") === "accepted" && !value(i, "delivered_on")).flatMap(i => [sourceOptionalDay(i, "confirmation_deadline"), sourceOptionalDay(i, "slides_deadline")]).filter(Boolean).sort();
    set(projectedHub, { outcome_summary: counts, deadline: deadlines[0] ?? "" });
    projectedHub.data = parseFrontmatter(raw(projectedHub)).data;
    const project = (path: string, columns: string[], rows: Array<{path:string;data:Record<string,unknown>}>) => {
      const input = unique(inputs, i => i.path === path, "projection");
      if (!editable(input, taxonomy)) throw new Error("excluded or archived projection");
      if (readGeneratedRegion(raw(input), REGION) === null) throw new Error("unmanaged projection requires explicit migration");
      const content = renderRegistry({ columns }, rows, dirname(path));
      const next = rewriteGeneratedRegion(raw(input), REGION, content, asOf);
      if (next !== null) writeFileSync(join(stage, path), next);
    };
    project(hub.path, ["submission_id", "speaking_outcome", "outcome_history", "confirmation_deadline", "slides_deadline", "delivered_on"], allForHub);
    project(`${paths.conferences}/_index.md`, ["conference_id", "title", "outcome_summary", "conference_phase"], current.filter(i => value(i, "conference_id") && !value(i, "submission_id") && i.data.type === "conference" && i.path.startsWith(`${paths.conferences}/`)));
    project(`${paths.talks}/_proposals.md`, ["submission_id", "conference_id", "talk_id", "speaking_outcome", "outcome_history"], currentSubmissions);
    const deliveries = currentSubmissions.filter(i => value(i, "delivered_on"));
    const deliveryRows = [...new Map(deliveries.map(i => [`${value(i, "conference_id")}/${value(i, "talk_id")}/${value(i, "delivered_on")}`, i])).values()];
    project(`${paths.talks}/_index.md`, ["conference_id", "talk_id", "delivered_on"], deliveryRows);
    project(paths.focus, ["conference_id", "talk_id", "speaking_conditions"], active);
    result.edits = inputs.map(i => ({ path:i.path,before:i.raw,after:raw(i),kind:"table" as const })).filter(e => e.before !== e.after);
    return result;
  } catch (error) {
    return { ...result, edits: [], refused: [{ path: "(brain)", reason: String(error) }] };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
function sourceOptionalDay(input: Input, key: string): string { return value(input, key) || input.data[key] instanceof Date ? sourceDay(input, key) : ""; }
export function apply(root: string, proposal: LifecyclePlan, dryRun = false) { return applyWrites(root, proposal, dryRun); }
