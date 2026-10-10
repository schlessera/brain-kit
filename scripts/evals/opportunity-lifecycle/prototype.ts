// Private #845 experiment. No CLI registration, package export or caller-given root.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { brainConfigSchema, type BrainConfig } from "../../../packages/core/src/lib/config";
import { buildTaxonomy, type Taxonomy } from "../../../packages/core/src/lib/taxonomy";
import { safeResolve, writeFileSafely } from "../../../packages/core/src/lib/safe-path";
import { parseFrontmatter } from "../../../packages/core/src/lib/frontmatter-parse";
import { editFrontmatter, type FrontmatterValue } from "../../../packages/core/src/lib/frontmatter-edit";
import { inertGeneratedText, readGeneratedRegion, rewriteGeneratedRegion, splitFrontmatterBlock } from "../../../packages/core/src/lib/generated-regions";
import { planRegistry, applyRegistry } from "../../../packages/core/src/lib/index-registry";
import { ensurePipelineIndex, STAGES } from "../../../packages/module-jobs/src/pipeline";
import { loadModules } from "../../../packages/core/src/lib/module-loader";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const line = z.string().trim().min(1).max(300).refine(v => !/[\r\n<>|`]/.test(v), "one inert line required");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}, "real calendar date required");
const base = { id, opportunity: id, on: day };
const call = {
  roundId: id, round: line, format: line,
  startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:Z|[+-]\d{2}:\d{2})$/),
  timeZone: z.string().min(1),
  contact: z.strictObject({ id, name: line, role: line, details: line.nullable() }),
};
export const eventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, ...call, kind: z.literal("scheduled") }),
  z.strictObject({ ...base, ...call, kind: z.literal("rebooked") }),
  z.strictObject({ ...base, kind: z.literal("cancelled"), roundId: id, reason: line, resumeStage: z.enum(["researching", "applied", "screening"]) }),
  z.strictObject({ ...base, kind: z.literal("offer"), nextStep: line.nullable(), deadline: day.nullable() }),
  z.strictObject({ ...base, kind: z.literal("closed"), reason: line }),
]);
export type Event = z.infer<typeof eventSchema>;
type Call = Extract<Event, { kind: "scheduled" | "rebooked" }>;
const labs = new WeakSet<Lab>();
const plans = new WeakMap<Plan, Lab>();

export interface Lab {
  root: string;
  config: BrainConfig;
  taxonomy: Taxonomy;
  opportunitiesDir: string;
  /** Fresh comparison fixtures resolve the actual disk config and enabled module. */
  authority?: { configText: string; jobsEnabled: boolean };
  close(): void;
}
function pathOf(lab: Lab, relative: string): string {
  if (!labs.has(lab)) throw new Error("only factory-created disposable fixtures are allowed");
  if (relative.split("/").some(p => !p || p.startsWith(".")) || relative.includes("\\")) throw new Error("unsafe relative path");
  const full = safeResolve(lab.root, relative);
  if (!full) throw new Error("path leaves fixture root");
  let prefix = lab.root;
  for (const part of relative.split("/")) {
    prefix = join(prefix, part);
    if (lstatSync(prefix, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("symlink requires clarification");
  }
  return full;
}
export function createLab(files: Record<string, string>, custom = false, moduleFallback = false): Lab {
  const root = mkdtempSync(join(tmpdir(), "brain-lifecycle-eval-"));
  const opportunitiesDir = custom ? "work/leads" : "career/opportunities";
  const focus = custom ? "context/now.md" : "context/current-focus.md";
  const config = brainConfigSchema.parse({
    reranker: { enabled: false },
    taxonomy: { types: { opportunity: { dir: moduleFallback ? null : opportunitiesDir } }, canonical: { currentFocus: focus } },
  });
  const lab: Lab = Object.freeze({ root, config, taxonomy: buildTaxonomy({ user: config }), opportunitiesDir, close: () => rmSync(root, { recursive: true, force: true }) });
  labs.add(lab);
  try {
    for (const [path, text] of Object.entries(files)) {
      const full = pathOf(lab, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSafely(full, text, { replace: false });
    }
  } catch (error) { lab.close(); throw error; }
  return lab;
}

/** Separate fresh factory; the historical seeded controls keep their original construction. */
export async function createConfiguredLab(files: Record<string, string>): Promise<Lab> {
  const configText = files["brain.config.json"];
  if (typeof configText !== "string") throw new Error("a complete disk configuration is required");
  const config = brainConfigSchema.parse(JSON.parse(configText));
  const original = createLab(files);
  try {
    // This issue owns its installed dependencies. Runtime isolation binds them read-only.
    symlinkSync(join(import.meta.dir, "../../../node_modules"), join(original.root, "node_modules"));
    const modules = await loadModules(config, original.root);
    const jobs = modules.find(mod => mod.manifest.name === "jobs" && mod.state === "active");
    const moduleDir = (jobs?.config as { opportunitiesDir?: unknown } | undefined)?.opportunitiesDir;
    const lab: Lab = Object.freeze({ ...original, config, taxonomy: buildTaxonomy({ user: config, modules }),
      opportunitiesDir: typeof moduleDir === "string" ? moduleDir : "career/opportunities",
      authority: Object.freeze({ configText, jobsEnabled: jobs !== undefined }),
    });
    labs.delete(original); labs.add(lab);
    return lab;
  } catch (error) { original.close(); throw error; }
}
function read(lab: Lab, path: string): string | null {
  const full = pathOf(lab, path);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}
function edit(raw: string, updates: Record<string, FrontmatterValue>): string {
  const next = editFrontmatter(raw, updates);
  if (next === null) throw new Error("frontmatter layout needs manual review");
  return next;
}
function region(raw: string, name: string, content: string, on: string): string {
  return rewriteGeneratedRegion(raw, name, content, on) ?? raw;
}
function ledger(raw: string): Event[] {
  const text = readGeneratedRegion(splitFrontmatterBlock(raw).body, "lifecycle-events");
  return text === null ? [] : text.trim().split("\n").map(row => eventSchema.parse(JSON.parse(row)));
}
function activeRounds(events: Event[]): Map<string, Call> {
  const rounds = new Map<string, Call>();
  for (const event of events) {
    if (event.kind === "scheduled" || event.kind === "rebooked") rounds.set(event.roundId, event);
    else if (event.kind === "cancelled") rounds.delete(event.roundId);
    else rounds.clear();
  }
  return rounds;
}
function callText(event: Call): string {
  return `${event.round} with ${event.contact.name}, ${event.startsAt} (${event.timeZone}); ${event.format}`;
}
function validateTime(event: Call): void {
  const date = new Date(event.startsAt);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid interview instant");
  day.parse(event.startsAt.slice(0, 10));
  // Check the supplied offset against the named zone, including DST. Never guess a timezone.
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: event.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const value = (key: string) => parts.find(p => p.type === key)!.value;
  if (`${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}` !== event.startsAt.slice(0, 16)) throw new Error("timezone and offset disagree");
  if (event.startsAt.slice(0, 10) < event.on) throw new Error("interview is before event date");
}
function children(lab: Lab, directory: string): string[] {
  const paths: string[] = [];
  for (const child of readdirSync(pathOf(lab, directory), { withFileTypes: true })) {
    const path = `${directory}/${child.name}`;
    pathOf(lab, path); // Includes links which the indexer's content walk would skip.
    if (child.isDirectory()) paths.push(...children(lab, path));
    else if (child.name.endsWith(".md")) paths.push(path);
  }
  return paths;
}
function dateOf(value: unknown): string | null {
  return value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === "string" ? value : null;
}
export interface Change { readonly path: string; readonly before: string | null; readonly after: string }
export interface Plan {
  readonly event: Event;
  readonly reads: readonly { path: string; raw: string | null }[];
  readonly changes: readonly Change[];
  readonly replay: boolean;
  readonly directory: string;
}
export type Inspection = { outcome: "clarify"; reason: string } | { outcome: "planned"; plan: Plan };

/** An exact focus line is separately selected by the caller, never inferred from prose. */
export function inspect(lab: Lab, input: unknown, focusBefore: string): Inspection {
  try {
    const event = eventSchema.parse(input);
    const directory = lab.taxonomy.dirForType("opportunity") ?? lab.opportunitiesDir;
    const dir = `${directory}/${event.opportunity}`;
    const statusPath = `${dir}/status.md`;
    const prepPath = `${dir}/interview-prep.md`;
    const focusPath = lab.taxonomy.canonicalPath("currentFocus");
    if (!focusPath) throw new Error("current-focus ownership is disabled");
    const reads = new Map<string, string | null>();
    const capture = (path: string) => {
      if (!reads.has(path)) reads.set(path, read(lab, path));
      return reads.get(path)!;
    };
    if (lab.authority) {
      if (capture("brain.config.json") !== lab.authority.configText) throw new Error("configuration changed; reload before planning");
      if (!lab.authority.jobsEnabled) throw new Error("jobs module is unavailable");
    }
    const status = capture(statusPath);
    if (status === null) throw new Error("unknown opportunity");
    const data = parseFrontmatter(status).data;
    if (data.type !== "opportunity" || !STAGES.includes(data.stage)) throw new Error("invalid opportunity type or stage");
    const events = ledger(status);
    if (events.some(e => e.opportunity !== event.opportunity)) throw new Error("event ledger belongs to another opportunity");
    const previous = events.find(e => e.id === event.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error("event id reused with different payload");
    const indexPath = `${directory}/_index.md`;
    capture(indexPath);
    if (previous) {
      const active = [...activeRounds(events).values()].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
      const last = events.at(-1)!;
      const expectedDeadline = last.kind === "offer" ? last.deadline : active[0]?.startsAt.slice(0, 10) ?? null;
      const expectedStage = last.kind === "closed" || last.kind === "offer" ? last.kind : active.length ? "interviewing" : last.kind === "cancelled" ? last.resumeStage : "interviewing";
      if (data.stage !== expectedStage || dateOf(data.deadline) !== expectedDeadline) throw new Error("event receipt disagrees with status; review source edits");
      const rawPrep = capture(prepPath);
      if (active.length && (rawPrep === null || dateOf(parseFrontmatter(rawPrep).data.deadline) !== expectedDeadline)) throw new Error("event receipt disagrees with prep deadline");
      if (!active.length) for (const path of children(lab, dir).filter(p => p !== statusPath)) {
        const raw = capture(path)!;
        if (parseFrontmatter(raw).data.deadline !== undefined) throw new Error("event receipt has a stale child deadline");
      }
      const plan: Plan = Object.freeze({ event: Object.freeze(event), reads: Object.freeze([...reads].map(([path, raw]) => Object.freeze({ path, raw }))), changes: Object.freeze([]), replay: true, directory });
      plans.set(plan, lab);
      return { outcome: "planned", plan };
    }
    if (events.length && event.on < events.at(-1)!.on) throw new Error("out-of-order event needs clarification");
    if (data.stage === "closed") throw new Error("closed opportunity cannot be reopened implicitly");
    if (!events.length && (event.kind === "scheduled" || event.kind === "rebooked") && (data.stage === "interviewing" || data.deadline !== undefined)) throw new Error("existing interview state needs ownership migration");
    const rounds = activeRounds(events);
    if (event.kind === "scheduled" || event.kind === "rebooked") {
      validateTime(event);
      if (event.kind === "scheduled" && rounds.has(event.roundId)) throw new Error("duplicate round requires replay or explicit rebooking");
      if (event.kind === "rebooked" && !rounds.has(event.roundId)) throw new Error("unknown round for rebooking");
    }
    if (event.kind === "cancelled" && !rounds.has(event.roundId)) throw new Error("unknown round for cancellation");
    if (event.kind === "offer" && event.deadline !== null && event.nextStep === null) throw new Error("deadline requires an explicit next step");
    if (event.kind === "offer" && event.deadline !== null && event.deadline < event.on) throw new Error("offer deadline is before event date");
    const focus = capture(focusPath);
    if (focus === null || focusBefore.includes("\n") || focusBefore.includes("\r")) throw new Error("exact current-focus line required");
    const focusLines = focus.split("\n");
    const previouslyRetiredFocus = !focusBefore && event.kind === "closed" && events.length > 0 &&
      !focusLines.some(line => line.includes(`[[${dir}/status]]`));
    if (!previouslyRetiredFocus && (focusLines.filter(l => l === focusBefore).length !== 1 || !focusBefore.includes(`[[${dir}/status]]`))) throw new Error("current-focus target is absent or ambiguous");
    const prep = capture(prepPath);
    if (prep !== null && parseFrontmatter(prep).data.type !== "opportunity") throw new Error("unsupported prep type");
    // Legacy contact rows and call details need an explicit ownership migration, not string guessing.
    if (!events.length && (event.kind === "scheduled" || event.kind === "rebooked")) {
      const contactsSection = status.split(/^## Contacts\r?$/m)[1]?.split(/^## /m)[0];
      const emptyContacts = contactsSection !== undefined && contactsSection.split(/\r?\n/).every(row => !row.trim() || /^\|[ -]+\|[ -]+\|[ -]+\|[ -]+\|$/.test(row) || row === "| Name | Role | Relationship | Notes |");
      if (!emptyContacts || prep?.includes("## The call")) throw new Error("unowned contacts or call details need review");
    }
    const nextEvents = [...events, event];
    const nextRounds = [...activeRounds(nextEvents).values()].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.roundId < b.roundId ? -1 : a.roundId > b.roundId ? 1 : 0));
    const next = nextRounds[0];
    const updates: Record<string, FrontmatterValue> = { updated: event.on };
    if (event.kind === "closed") Object.assign(updates, { stage: "closed", relevance: "historical", closed_reason: event.reason, next_step: null, deadline: null });
    else if (event.kind === "offer") Object.assign(updates, { stage: "offer", next_step: event.nextStep, deadline: event.deadline });
    else Object.assign(updates, { stage: next ? "interviewing" : event.kind === "cancelled" ? event.resumeStage : "interviewing", next_step: next ? callText(next) : null, deadline: next ? next.startsAt.slice(0, 10) : null });
    const changes = new Map<string, string>();
    let statusNext = edit(status, updates);
    if (data.deadline !== undefined) {
      const oldDeadline = data.deadline instanceof Date ? data.deadline.toISOString().slice(0, 10) : String(data.deadline);
      const prior = readGeneratedRegion(splitFrontmatterBlock(statusNext).body, "lifecycle-previous-step");
      const recorded = `- Before [${event.id}] on ${event.on}: Previous next step: ${inertGeneratedText(String(data.next_step ?? "unknown"))}; deadline ${inertGeneratedText(oldDeadline)}.`;
      statusNext = region(statusNext, "lifecycle-previous-step", [prior, recorded].filter(Boolean).join("\n"), event.on);
    }
    statusNext = region(statusNext, "lifecycle-events", nextEvents.map(e => JSON.stringify(e)).join("\n"), event.on);
    const history = nextEvents.map(e => `- ${e.on}: ${e.kind} [${e.id}]${e.kind === "scheduled" || e.kind === "rebooked" ? ` — ${callText(e)}` : e.kind === "closed" || e.kind === "cancelled" ? ` — ${e.reason}` : ` — ${e.nextStep ?? "no next step"}`}`).join("\n");
    statusNext = region(statusNext, "lifecycle-timeline", `## Recorded lifecycle\n\n${history}`, event.on);
    const contacts = new Map<string, Call["contact"]>();
    for (const e of nextEvents) if (e.kind === "scheduled" || e.kind === "rebooked") contacts.set(e.contact.id, e.contact);
    if (contacts.size) statusNext = region(statusNext, "lifecycle-contacts", `## Recorded contacts\n\n| Name | Role | Relationship | Notes |\n| --- | --- | --- | --- |\n${[...contacts.values()].map(c => `| ${c.name} | ${c.role} | Interview | ${c.details ?? "unknown; ask before outreach"} |`).join("\n")}`, event.on);
    // Status is last: the complete event receipt follows the other source writes.
    const focusAfter = event.kind === "closed" || (!next && event.kind === "cancelled") ? "" : `- [[${dir}/status]] — ${event.kind === "offer" ? event.nextStep ?? "Offer received; next step unknown" : callText(next!)}`;
    if (!previouslyRetiredFocus) changes.set(focusPath, edit(focusLines.map(l => l === focusBefore ? focusAfter : l).filter((l, i) => l !== "" || focusLines[i] !== focusBefore).join("\n"), { updated: event.on }));
    if (next) {
      const raw = prep ?? `---\ntype: opportunity\ntitle: Interview preparation\ncreated: ${event.on}\nupdated: ${event.on}\nstatus: active\nrelevance: primary\ntags: [job-search, interview-prep]\n---\n\n## Related\n\n[[${dir}/status]]\n[[${dir}/research]]\n`;
      changes.set(prepPath, region(edit(raw, { deadline: next.startsAt.slice(0, 10), updated: event.on }), "lifecycle-calls", `## Upcoming calls\n\n${nextRounds.map(e => `- [${e.roundId}] ${callText(e)}`).join("\n")}`, event.on));
      statusNext = region(statusNext, "lifecycle-related", `## Related preparation\n\n[[${dir}/interview-prep]]`, event.on);
    } else if (prep !== null) changes.set(prepPath, region(edit(prep, { deadline: null, updated: event.on }), "lifecycle-calls", "## Upcoming calls\n\nNo scheduled calls.", event.on));
    if (event.kind === "closed" || event.kind === "offer") {
      // All opportunity documents participate. A malformed/unsafe child aborts the preview.
      for (const path of children(lab, dir).filter(p => p !== statusPath)) {
        const raw = capture(path)!;
        const child = parseFrontmatter(raw).data;
        if (child.type !== "opportunity") throw new Error("unsupported opportunity child type");
        if (child.deadline !== undefined) {
          const oldDeadline = child.deadline instanceof Date ? child.deadline.toISOString().slice(0, 10) : String(child.deadline);
          const current = changes.get(path) ?? raw;
          changes.set(path, region(edit(current, { deadline: null, updated: event.on }), "lifecycle-retired-deadline", `Cancelled ${event.on}: ${event.kind}; previous deadline ${oldDeadline}.`, event.on));
        }
      }
    }
    changes.set(statusPath, statusNext);
    const list = [...changes].filter(([path, after]) => capture(path) !== after).map(([path, after]) => Object.freeze({ path, before: reads.get(path)!, after }));
    const plan: Plan = Object.freeze({ event: Object.freeze(event), reads: Object.freeze([...reads].map(([path, raw]) => Object.freeze({ path, raw }))), changes: Object.freeze(list), replay: false, directory });
    plans.set(plan, lab);
    return { outcome: "planned", plan };
  } catch (error) { return { outcome: "clarify", reason: (error as Error).message }; }
}

/** Stops with an honest partial receipt. Retry the same sealed plan only while every byte matches. */
export function apply(lab: Lab, plan: Plan, authorized: boolean, interruptAfter = Infinity) {
  const written: string[] = [];
  if (!authorized) return { outcome: "denied", written };
  if (plans.get(plan) !== lab) return { outcome: "denied", written };
  try {
    const after = new Map(plan.changes.map(c => [c.path, c.after]));
    for (const source of plan.reads) {
      const now = read(lab, source.path);
      if (now !== source.raw && now !== after.get(source.path)) return { outcome: "stale", written, path: source.path };
    }
    for (const change of plan.changes) {
      if (read(lab, change.path) === change.after) continue;
      if (written.length >= interruptAfter) return { outcome: "interrupted", written };
      writeFileSafely(pathOf(lab, change.path), change.after, { replace: change.before !== null });
      written.push(change.path);
    }
    if (written.length >= interruptAfter) return { outcome: "interrupted", written };
    const index = ensurePipelineIndex(lab.root, plan.directory, plan.event.on);
    const registry = planRegistry(lab.root, lab.taxonomy, plan.event.on);
    const result = applyRegistry(lab.root, { indexes: registry.indexes.filter(i => i.path === index.path), problems: registry.problems.filter(p => p.path === index.path) }, {});
    if (result.invalid.length || result.stale.length) return { outcome: "repair-pipeline", written, registry: result };
    return { outcome: "applied", written: [...written, ...result.written], replay: plan.replay };
  } catch (error) { return { outcome: "failed", written, reason: (error as Error).message }; }
}
