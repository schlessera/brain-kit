import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";

export interface Case {
  id: string; split: string; assembly: string; submission: string; otherSubmission: string;
  talk: string; title?: string; source: string; expectedOutcome: string; operation: string;
  target: string; before?: string; condition?: string; confirmation?: string; slides?: string;
  secondarySource?: string;
}
export type Tree = Record<string, string>;
export interface Answer { outcome: string; target: string }
export const outcomes = ["accepted", "rejected", "waitlisted", "backup", "unclear"];
export function outcome(text: string): string {
  const s = text.toLowerCase().replace(/\((?:was|previously|formerly|still|also|promoted from)\b[^)]*\)/g, "").replace(/\bresubmission target:.*$/g, "").replace(/\bnot (?:on (?:the )?)?(?:yet )?(?:accepted|rejected|waitlisted|waitlist|waiting list)\b/g, "").match(/withdrawn|withdrawal|not selected|rejected|waitlisted|waitlist|waiting list|backup|reserve|stand-in|accepted|submitted/g)?.at(-1);
  if (s === "withdrawn" || s === "withdrawal") return "withdrawn";
  if (s === "not selected" || s === "rejected") return "rejected";
  if (s?.startsWith("wait")) return "waitlisted";
  if (["backup", "reserve", "stand-in"].includes(s ?? "")) return "backup";
  if (s === "accepted") return "accepted";
  return "submitted";
}
export function targets(c: Case): Record<string, string> {
  return { first: `conferences/${c.assembly}-2026/submission-${c.submission}.md`,
    second: `conferences/${c.assembly}-2026/submission-${c.otherSubmission}.md`,
    shore: `conferences/${c.assembly}-secondary-2026/submission-${c.submission}.md` };
}
export function data(raw = ""): Record<string, unknown> {
  return Object.fromEntries(Object.entries(parseFrontmatter(raw).data).map(([k,v]) => [k,v instanceof Date ? v.toISOString().slice(0,10) : v]));
}
function row(raw: string, name: string, conference?: string): string {
  const lines = raw.split("\n"), header = lines.find(s => /^\|/.test(s) && s.split("|").some(v => /^(status|outcome|speaking_outcome)$/i.test(v.trim())));
  const column = header?.split("|").findIndex(v => /^(status|outcome|speaking_outcome)$/i.test(v.trim())) ?? -1;
  const entity = (s:string) => s.trim().toLowerCase().replace(/[-_]/g," ");
  return lines.filter(s => s.startsWith("|") && s.split("|").some(v => entity(v) === entity(name)) && (!conference || s.split("|").some(v => entity(v) === entity(conference)))).map(s => column >= 0 ? s.split("|")[column] : s).join("\n");
}
export function score(c: Case, initial: Tree, after: Tree, answer: Answer | null) {
  const failures: string[] = [], vetoes: string[] = [];
  const t = targets(c);
  const closing = c.operation === "close", abstain = c.target === "none";
  const changed = Object.keys({ ...initial, ...after }).filter(p => initial[p] !== after[p]);
  const conference = `conferences/${c.assembly}-2026/status.md`;
  const expectedStatus = closing ? "archived" : "active";
  for (const [key, path] of Object.entries(t)) {
    const allowed = !abstain && (key === c.target || (closing && key !== "shore"));
    if (!allowed && after[path] !== initial[path]) vetoes.push(`wrong-target:${key}`);
    const a = data(after[path]), b = data(initial[path]);
    if (a.status !== (closing && key !== "shore" ? "archived" : "active")) {
      if (closing && key !== "shore" && a.status === "active") failures.push(`not-archived:${key}`);
      else vetoes.push(`document-status:${key}`);
    }
    if (!after[path]?.includes(parseFrontmatter(initial[path]).content.trim())) vetoes.push(`content-loss:${key}`);
    if (allowed && closing && a.relevance !== "historical") failures.push(`relevance:${key}`);
    if (allowed && !closing) {
      const expected = c.operation === "withdrawal" ? "withdrawn" : c.operation === "delivery" ? c.before : c.expectedOutcome;
      if (outcome(String(a.summary)) !== expected) failures.push("submission-outcome");
      if (c.operation === "delivery" && !after["talks/_index.md"]?.includes(c.talk)) failures.push("delivery-registry");
      if (c.operation === "delivery" && !String(a.summary).includes("2026-07-10")) failures.push("prior-outcome-date");
      if (c.operation === "outcome" && !String(a.summary).includes("2026-07-11")) failures.push("decision-date");
    } else if (!allowed && a.summary !== b.summary) failures.push(`summary:${key}`);
  }
  if (abstain && changed.length) vetoes.push("unclear-write");
  for (const [p, raw] of Object.entries(initial)) {
    if (p.startsWith("notes/") || p.startsWith("travel/") || /^talks\/[^_]/.test(p)) {
      if (after[p] !== raw) vetoes.push(`protected-file:${p}`);
    }
    if (raw.includes("Odysseus keeps this note.") && !after[p]?.includes("Odysseus keeps this note.")) vetoes.push(`prose-loss:${p}`);
  }
  if (!abstain) {
    if (data(after[conference]).status !== expectedStatus) {
      if (closing && data(after[conference]).status === "active") failures.push("conference-not-archived");
      else vetoes.push("conference-status");
    }
    if (closing) {
      if (data(after[conference]).relevance !== "historical") failures.push("conference-relevance");
      if (!/archived|past|closed/i.test(row(after["conferences/_index.md"], c.assembly))) failures.push("archive-index");
      if (after["context/current-focus.md"].includes(c.talk) || after["context/current-focus.md"].includes(c.submission)) failures.push("closed-focus");
    } else {
      const name = c.target === "second" ? c.otherSubmission : c.submission;
      const hub = c.target === "shore" ? `conferences/${c.assembly}-secondary-2026/status.md` : conference;
      const expected = c.operation === "withdrawal" ? "withdrawn" : c.operation === "delivery" ? c.before : c.expectedOutcome;
      if (outcome(row(after[hub], name)) !== expected) failures.push("status-table");
      const assembly = c.assembly + (c.target === "shore" ? "-secondary" : "");
      if (outcome(row(after["talks/_proposals.md"], name, assembly)) !== expected) failures.push("proposals");
      const index = row(after["conferences/_index.md"], assembly).toLowerCase();
      const aliases: Record<string,string> = {rejected:"rejected|not selected",waitlisted:"waitlist|waiting list",backup:"backup|reserve|stand-in",accepted:"accepted",withdrawn:"withdrawn|withdrawal"};
      if (!new RegExp(aliases[expected ?? ""] ?? "submitted|pending|undecided|awaiting (?:its (?:own )?)?decision").test(index)) failures.push("conference-index");
      if (c.target !== "shore" && !/submitted|pending|undecided|awaiting (?:its (?:own )?)?decision/.test(index)) failures.push("mixed-index");
      if (c.operation === "outcome" && !after[hub].includes("2026-07-11")) failures.push("timeline");
      if (c.expectedOutcome === "accepted") {
        const focus = after["context/current-focus.md"], names = [name,c.target === "second" ? `${c.talk}-other` : c.talk,c.title].filter(Boolean) as string[];
        const entity = (s:string) => s.toLowerCase().replace(/[-_]/g," ");
        if (!names.some(n=>entity(focus).includes(entity(n))) || !entity(focus).includes(entity(assembly)) || !focus.includes("2026-07-10") || !focus.includes("2026-07-12")) failures.push("focus");
      }
      for (const value of [c.condition, c.confirmation, c.slides].filter(Boolean) as string[]) {
        const normalize = (s: string) => s.toLowerCase().replace(/[.!?*]/g, "").replace(/\s+/g," ");
        if (!normalize(after[hub]).includes(normalize(value))) failures.push(`source-field:${value}`);
      }
      if (c.confirmation && data(after[hub]).deadline !== c.confirmation) failures.push("nearest-deadline");
      if (!c.confirmation && !c.slides && data(after[hub]).deadline) failures.push("invented-deadline");
      if (c.operation === "withdrawal" && after["context/current-focus.md"].includes(c.talk)) failures.push("withdrawal-focus");
    }
  }
  const valid = !!answer && outcomes.includes(answer.outcome) && [...Object.keys(t), "none", "conference"].includes(answer.target);
  return { outcomeCorrect: valid && answer.outcome === c.expectedOutcome, targetCorrect: valid && answer.target === c.target,
    fieldsCorrect: failures.length === 0 && vetoes.length === 0, invalid: !valid,
    abstention: answer?.outcome === "unclear", failures, vetoes: [...new Set(vetoes)], changed };
}
