import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";

export type Files = Record<string, string>;
export interface Case {
  id: string; source: string; split: string; directory: string; target: string;
  focusPath: string; files: Files; message: string; facts: Record<string, any>;
  expected: { kind: string; opportunity: string; stage: string; deadline: string | null;
    calls: string[]; contacts: string[]; focus: string | null; clarify?: string };
}
export const data = (s = "") => parseFrontmatter(s).data;
export const day = (v: unknown) => v instanceof Date ? v.toISOString().slice(0, 10) : v ?? null;
const contains = (text: string, part: string) => text.toLowerCase().includes(part.toLowerCase());
const hasDate = (text: string, date: string) => text.includes(date) || new RegExp(`\\b(?:${Number(date.slice(-2))}(?:st|nd|rd|th)?[ \\/-]+Jul(?:y)?|Jul(?:y)? +${Number(date.slice(-2))}(?:st|nd|rd|th)?)\\b`, "i").test(text);
const hasZone = (text: string, zone: string) => contains(text, zone) || (zone === "Europe/Berlin" && /CEST|\+02:00/i.test(text)) || (zone === "UTC" && /GMT|\+00:00|\dZ\b/i.test(text));
function hasTime(text: string, time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return new RegExp(`(?:^|\\D)0?${hour}:${String(minute).padStart(2, "0")}\\b`).test(text) ||
    new RegExp(`\\b0?${hour % 12 || 12}${minute ? ":" + String(minute).padStart(2, "0") : "(?::00)?"} *${hour < 12 ? "a" : "p"}\\.?m\\.?\\b`, "i").test(text);
}
export function score(c: Case, after: Files, mapping: { kind: string; opportunity: string }) {
  const prefix = `${c.directory}/${c.target}/`, status = `${prefix}status.md`, prep = `${prefix}interview-prep.md`;
  const e = c.expected, d = data(after[status]), checks: Record<string, boolean> = {};
  const changed = Object.keys({ ...c.files, ...after }).filter(p => c.files[p] !== after[p]);
  const vetoes: string[] = [];
  if (changed.some(p => p.startsWith(c.directory + "/") && p !== `${c.directory}/_index.md` && !p.startsWith(prefix))) vetoes.push("wrong-opportunity");
  for (const [p, before] of Object.entries(c.files)) {
    // Timeline bullets and authored prose are retained literally, including prep positioning.
    const retained = before.split("\n").filter(line => /^- 2026-07-\d\d:/.test(line) || /^(Odysseus keeps|Retain this exact note|Penelope retains)/.test(line));
    if (retained.some(line => !(after[p] ?? "").includes(line))) vetoes.push(p === prep ? "prep-content-loss" : "timeline-or-content-loss");
  }
  const noop = ["none", "unclear"].includes(e.kind);
  // A clarification may name a known target (e.g. missing interviewer details).
  // There is no applied target on a no-op, so score its event/refusal class only.
  checks.mapping = mapping.kind === e.kind && (noop || mapping.opportunity === e.opportunity);
  if (noop) checks.files = changed.filter(p => p !== `${c.directory}/_index.md`).length === 0;
  else {
    checks.stage = d.stage === e.stage;
    checks.deadline = day(d.deadline) === e.deadline;
    const body = parseFrontmatter(after[status] ?? "").content;
    checks.history = c.facts.reason ? body.includes(c.facts.reason) : c.facts.startsAt ? hasDate(body, c.facts.startsAt.slice(0, 10)) && hasTime(body, c.facts.startsAt.slice(11, 16)) && body.includes(c.facts.contact.name) : /offer/i.test(body);
    const contactSections = [...(after[status] ?? "").matchAll(/## [^\n]*contacts[^\n]*\n([\s\S]*?)(?=\n## |$)/gi)].map(m => m[1]).join("\n");
    checks.contacts = e.contacts.every(name => contactSections.split("\n").some(line => line.startsWith("|") ? line.split("|").some(cell => cell.replace(/[*`]/g, "").trim() === name) : /^- /.test(line) && new RegExp(`^${name}(?:[ ;:(]|$)`).test(line.slice(2).replace(/[*`]/g, ""))));
    const activePrep = (after[prep] ?? "").split(/## Upcoming calls|## The call/i).at(-1)?.split(/\n## |\n<!-- \/brain:/)[0] ?? "";
    checks.calls = e.calls.every(call => {
      const [round, rest] = call.split(" with "), name = rest?.split(", ")[0];
      const date = call.match(/2026-07-\d\d/)?.[0];
      const time = call.match(/T(\d\d:\d\d)/)?.[1], zone = call.match(/\(([^)]+)\)/)?.[1];
      const format = call.split("; ")[1], duration = format?.match(/\d+/)?.[0];
      const blocks = e.calls.length > 1 ? activePrep.split(/\n(?=- )/) : [String(data(after[prep]).title ?? "") + "\n" + activePrep];
      return blocks.some(block => [round, name].every(part => part && contains(block, part)) && !!time && hasTime(block, time) && !!zone && hasZone(block, zone) && !!date && hasDate(block, date) && !!format && contains(block, format.split(",")[0]) && !!duration && new RegExp(`\\b${duration} *min(?:ute)?s?\\b`, "i").test(block));
    });
    if (e.calls.length) {
      checks.prepDeadline = day(data(after[prep]).deadline) === e.deadline;
      checks.links = (after[prep] ?? "").includes(`${prefix}status`) && (after[prep] ?? "").includes(`${prefix}research`) && (after[status] ?? "").includes(`${prefix}interview-prep`);
      const first = e.calls[0], step = String(d.next_step ?? "");
      checks.nextStep = [first.split(" with ")[0], first.split(" with ")[1]?.split(", ")[0]].every(part => !!part && contains(step, part)) && hasTime(step, first.match(/T(\d\d:\d\d)/)![1]) && hasDate(step, e.deadline!) && hasZone(step, first.match(/\(([^)]+)\)/)![1]);
    } else {
      checks.retired = Object.entries(after).filter(([p]) => p.startsWith(prefix) && p !== status).every(([, s]) => !data(s).deadline);
      checks.nextStep = e.kind === "offer" && c.facts.nextStep ? d.next_step === c.facts.nextStep : !d.next_step;
      if (e.kind === "closed") checks.closure = d.relevance === "historical" && d.closed_reason === c.facts.reason;
    }
    const focus = (after[c.focusPath] ?? "").split("\n").find(line => line.includes(`${prefix}status`)) ?? "";
    checks.focus = e.calls.length ? hasDate(focus, e.deadline!) && hasTime(focus, e.calls[0].match(/T(\d\d:\d\d)/)![1]) && hasZone(focus, e.calls[0].match(/\(([^)]+)\)/)![1]) : e.focus ? c.facts.nextStep ? contains(focus, c.facts.nextStep) : /offer/i.test(focus) && /unknown|awaiting|clarif|not (?:yet )?known|no next step/i.test(focus) : !focus;
    const row = (after[`${c.directory}/_index.md`] ?? "").split("\n").find(line => line.startsWith("| ") && line.includes(prefix + "status")) ?? "";
    const cells = row.split("|").map(cell => cell.trim());
    checks.pipeline = cells[2] === e.stage && (e.deadline ? cells[5] === e.deadline : ["—", ""].includes(cells[5]) && ["—", ""].includes(cells[4]));
    checks.unrelated = changed.every(p => p.startsWith(prefix) || p === c.focusPath || p === `${c.directory}/_index.md`);
  }
  return { exact: Object.values(checks).every(Boolean) && !vetoes.length, checks, vetoes: [...new Set(vetoes)], changed,
    fields: { stage: d.stage ?? null, deadline: day(d.deadline), prepDeadline: day(data(after[prep]).deadline), nextStep: d.next_step ?? null, closedReason: d.closed_reason ?? null } };
}
