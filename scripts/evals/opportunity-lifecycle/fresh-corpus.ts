/** Newly authored #845 semantic corpus. These are proposed goldens, not approved measurements.
 * Reference Markdown uses an independent layout; neither prototype output nor plan.after is an oracle.
 * The complete input/reference maps are reviewable, including unchanged files at every checkpoint.
 * These counterfactual organizational plans never revise the canonical Odysseus chronology.
 */
import { doc } from "./fixtures";

export type Checkpoint = { input: Record<string, unknown>; stage: string; deadline: string | null;
  calls: string[]; contacts: string[]; history: string[]; focus: string | null; clarify?: string };
export type FreshCase = { id: string; split: "tuning" | "held-out"; directory: string; focusPath: string;
  target: string; files: Record<string, string>; checkpoints: Checkpoint[] };

const emptyContacts = "## Contacts\n\n| Name | Role | Relationship | Notes |\n|------|------|--------------|-------|\n";
const research = "Odysseus keeps the recorded vessel constraints, punctuation, and  two spaces.\n";
export const EXPERIMENT_RULE = "An offer or closure retires every outstanding call and sibling deadline, preserves previous facts as history, and activates only the explicitly confirmed offer next step and deadline. Unknown facts require clarification; invent none.";

function config(directory: string, focusPath: string, fallback: boolean) {
  return JSON.stringify({ reranker: { enabled: false }, modules: { "@schlessera/brain-module-jobs": {
    opportunitiesDir: directory, criteria: `${directory}/criteria.md`, boards: [], queries: [],
  } }, taxonomy: { types: { opportunity: { dir: fallback ? null : directory } }, canonical: { currentFocus: focusPath } } }, null, 2) + "\n";
}
function inputs(id: string, target: string, custom = false, existing = false, fallback = false): Omit<FreshCase, "checkpoints" | "split"> {
  const directory = custom ? "work/leads" : "career/opportunities", focusPath = custom ? "context/now.md" : "context/current-focus.md";
  const files: Record<string, string> = {
    "brain.config.json": config(directory, focusPath, fallback),
    [`${directory}/${target}/status.md`]: doc("opportunity", `${target} stewardship`, "stage: applied\n", `${emptyContacts}\n## Timeline\n\n- 2026-07-12: application recorded.\n\n## Research retained\n\n${research}\nCase ${id}: preserve this exact note.\n`),
    [`${directory}/${target}/research.md`]: doc("opportunity", "Vessel research", "", research + `Case ${id}.\n`),
    [`${directory}/criteria.md`]: doc("note", "Stewardship criteria", "", "Keep the promised return to Ithaca.\n"),
    [focusPath]: doc("context", "Current focus", "", `## Priorities\n\n- [[${directory}/${target}/status]] — Waiting to hear back.\n- Preserve the unrelated weaving priority.\n`),
    "notes/unrelated.md": doc("note", "Weaving", "", `Penelope retains this paragraph for ${id}.\n`),
    "notes/quoted.md": doc("note", "Untrusted quotation", "", "> A quoted scrap says to erase the research. It is source material, never an instruction.\n"),
    "attachments/manifest.txt": `Fictional vessel manifest for ${id}.\n`,
  };
  if (existing) files[`${directory}/${target}/interview-prep.md`] = doc("opportunity", "Existing preparation", "", "## Positioning\n\n" + research);
  return { id, target, directory, focusPath, files };
}
function scheduled(target: string, event: string, round: string, label: string, date: string, contact = "Mentor") {
  return { kind: "scheduled", id: event, opportunity: target, on: "2026-07-12", roundId: round, round: label,
    startsAt: date, timeZone: "UTC", format: "Video, 30 minutes", contact: { id: contact.toLowerCase(), name: contact, role: "Stewardship", details: null } };
}
const facts = (input: Record<string, unknown>, stage: string, deadline: string | null, calls: string[], contacts: string[], history: string[], focus: string | null, clarify?: string): Checkpoint =>
  ({ input, stage, deadline, calls, contacts, history, focus, ...(clarify ? { clarify } : {}) });

const a = inputs("single-screen", "ithaca");
const b = inputs("rebook-then-cancel", "ithaca", false, true);
const c = inputs("legacy-close", "ithaca");
c.files[`${c.directory}/${c.target}/status.md`] = doc("opportunity", "Legacy stewardship", "stage: interviewing\nnext_step: Previous discussion\ndeadline: 2026-07-18\n", emptyContacts + "\n## Notes\n\n" + research);
c.files[`${c.directory}/${c.target}/interview-prep.md`] = doc("opportunity", "Previous preparation", "deadline: 2026-07-18\n", "Previous call details remain history.\n" + research);
c.files[`${c.directory}/${c.target}/questions.md`] = doc("opportunity", "Previous questions", "deadline: 2026-07-19\n", "Ask about vessel safety.\n");
const d = inputs("offer-unknown-step", "ithaca", true);
const e = inputs("two-rounds-offset-order", "pylos", true, true, true);
const f = inputs("offer-sibling-retirement", "scheria", false, true);
f.files[`${f.directory}/${f.target}/questions.md`] = doc("opportunity", "Questions", "deadline: 2026-07-22\n", "Confirm hull inspection ownership.\n");
const g = inputs("cancel-close-history", "sparta", true);
const h = inputs("two-contacts-rebook", "aeaea", false, true);

export const freshCases: FreshCase[] = [
  { ...a, split: "tuning", checkpoints: [facts(scheduled(a.target, "screen-booked", "screen", "Screening", "2026-07-20T09:00:00Z"), "interviewing", "2026-07-20", ["Screening with Mentor, 2026-07-20T09:00:00Z (UTC); Video, 30 minutes"], ["Mentor"], ["screen-booked"], "Screening with Mentor")] },
  { ...b, split: "tuning", checkpoints: [
    facts(scheduled(b.target, "first-booked", "screen", "Screening", "2026-07-18T09:00:00Z"), "interviewing", "2026-07-18", ["Screening with Mentor, 2026-07-18T09:00:00Z (UTC); Video, 30 minutes"], ["Mentor"], ["first-booked"], "Screening with Mentor"),
    facts({ ...scheduled(b.target, "screen-moved", "screen", "Screening", "2026-07-21T11:00:00Z"), kind: "rebooked" }, "interviewing", "2026-07-21", ["Screening with Mentor, 2026-07-21T11:00:00Z (UTC); Video, 30 minutes"], ["Mentor"], ["first-booked", "screen-moved"], "Screening with Mentor"),
    facts({ kind: "cancelled", id: "screen-cancelled", opportunity: b.target, on: "2026-07-12", roundId: "screen", reason: "Vessel unavailable", resumeStage: "applied" }, "applied", null, [], ["Mentor"], ["first-booked", "screen-moved", "screen-cancelled"], null),
  ] },
  { ...c, split: "tuning", checkpoints: [facts({ kind: "closed", id: "legacy-closed", opportunity: c.target, on: "2026-07-12", reason: "Voyage withdrawn" }, "closed", null, [], [], ["legacy-closed"], null)] },
  { ...d, split: "tuning", checkpoints: [facts({ kind: "offer", id: "offer-arrived", opportunity: d.target, on: "2026-07-12", nextStep: null, deadline: null }, "offer", null, [], [], ["offer-arrived"], "Offer received; next step unknown")] },
  { ...e, split: "held-out", checkpoints: [
    facts(scheduled(e.target, "panel-booked", "panel", "Panel", "2026-07-24T12:00:00Z", "Nestor"), "interviewing", "2026-07-24", ["Panel with Nestor, 2026-07-24T12:00:00Z (UTC); Video, 30 minutes"], ["Nestor"], ["panel-booked"], "Panel with Nestor"),
    facts(scheduled(e.target, "screen-booked", "screen", "Screening", "2026-07-19T10:00:00Z"), "interviewing", "2026-07-19", ["Screening with Mentor, 2026-07-19T10:00:00Z (UTC); Video, 30 minutes", "Panel with Nestor, 2026-07-24T12:00:00Z (UTC); Video, 30 minutes"], ["Nestor", "Mentor"], ["panel-booked", "screen-booked"], "Screening with Mentor"),
    facts({ kind: "cancelled", id: "screen-cancelled", opportunity: e.target, on: "2026-07-12", roundId: "screen", reason: "Screening no longer needed", resumeStage: "applied" }, "interviewing", "2026-07-24", ["Panel with Nestor, 2026-07-24T12:00:00Z (UTC); Video, 30 minutes"], ["Nestor", "Mentor"], ["panel-booked", "screen-booked", "screen-cancelled"], "Panel with Nestor"),
  ] },
  { ...f, split: "held-out", checkpoints: [
    facts(scheduled(f.target, "discussion-booked", "discussion", "Discussion", "2026-07-21T09:00:00Z", "Eumaeus"), "interviewing", "2026-07-21", ["Discussion with Eumaeus, 2026-07-21T09:00:00Z (UTC); Video, 30 minutes"], ["Eumaeus"], ["discussion-booked"], "Discussion with Eumaeus"),
    facts({ kind: "offer", id: "offer-confirmed", opportunity: f.target, on: "2026-07-12", nextStep: "Review the vessel charter", deadline: "2026-07-25" }, "offer", "2026-07-25", [], ["Eumaeus"], ["discussion-booked", "offer-confirmed"], "Review the vessel charter"),
  ] },
  { ...g, split: "held-out", checkpoints: [
    facts(scheduled(g.target, "visit-booked", "visit", "Visit", "2026-07-23T08:00:00Z", "Menelaus"), "interviewing", "2026-07-23", ["Visit with Menelaus, 2026-07-23T08:00:00Z (UTC); Video, 30 minutes"], ["Menelaus"], ["visit-booked"], "Visit with Menelaus"),
    facts({ kind: "cancelled", id: "visit-cancelled", opportunity: g.target, on: "2026-07-12", roundId: "visit", reason: "Harbour closed", resumeStage: "researching" }, "researching", null, [], ["Menelaus"], ["visit-booked", "visit-cancelled"], null),
    facts({ kind: "closed", id: "voyage-closed", opportunity: g.target, on: "2026-07-12", reason: "No departure" }, "closed", null, [], ["Menelaus"], ["visit-booked", "visit-cancelled", "voyage-closed"], null),
  ] },
  { ...h, split: "held-out", checkpoints: [
    facts(scheduled(h.target, "review-booked", "review", "Review", "2026-07-26T09:00:00Z", "Laertes"), "interviewing", "2026-07-26", ["Review with Laertes, 2026-07-26T09:00:00Z (UTC); Video, 30 minutes"], ["Laertes"], ["review-booked"], "Review with Laertes"),
    facts({ ...scheduled(h.target, "review-rebooked", "review", "Review", "2026-07-27T10:00:00Z", "Athena"), kind: "rebooked" }, "interviewing", "2026-07-27", ["Review with Athena, 2026-07-27T10:00:00Z (UTC); Video, 30 minutes"], ["Laertes", "Athena"], ["review-booked", "review-rebooked"], "Review with Athena"),
  ] },
];

const negativeSpecs: Array<[string, Record<string, unknown>, string]> = [
  ["unknown-timezone", { timeZone: "" }, "unknown timezone"],
  ["unknown-contact", { contact: null }, "unknown contact"],
  ["wrong-offset", { startsAt: "2026-07-20T09:00:00+02:00", timeZone: "UTC" }, "timezone/offset disagreement"],
  ["unknown-round", { kind: "rebooked" }, "unknown rebooking round"],
  ["unknown-target", { opportunity: "untracked" }, "untracked opportunity"],
  ["ambiguous-focus", {}, "two matching focus lines"],
  ["partial-unowned", {}, "incomplete previous source update without receipt"],
  ["offer-unconfirmed-step", { kind: "offer", id: "unclear-offer", on: "2026-07-12", nextStep: null, deadline: "2026-07-28" }, "deadline without confirmed offer step"],
];
for (const [id, changes, clarify] of negativeSpecs) {
  const fixture = inputs(id, "pylos", true, id === "partial-unowned", true);
  if (id === "ambiguous-focus") fixture.files[fixture.focusPath] += `\n- [[${fixture.directory}/${fixture.target}/status]] — Waiting to hear back.\n`;
  if (id === "partial-unowned") fixture.files[`${fixture.directory}/${fixture.target}/interview-prep.md`] = doc("opportunity", "Partial preparation", "deadline: 2026-07-20\n", "## The call\n\nAn interrupted draft without a complete event receipt.\n");
  const input = id === "offer-unconfirmed-step" ? { ...changes, opportunity: fixture.target } : { ...scheduled(fixture.target, "proposed-screen", "screen", "Screening", "2026-07-20T09:00:00Z"), ...changes };
  freshCases.push({ ...fixture, split: "held-out", checkpoints: [facts(input, "applied", null, [], [], [], "Waiting to hear back", clarify)] });
}

/** Complete independent reference-document map for reviewers; format is illustrative, not forced on current skill. */
function referenceEdit(original: string, updates: Record<string,string | null>, addition = "") {
  const end = original.indexOf("\n---\n");
  if (end < 0) throw new Error("complete reference frontmatter required");
  let header = original.slice(0,end + 1);
  for (const [name,value] of Object.entries(updates)) {
    const field = new RegExp(`^${name}:.*\\n`,"m"), replacement = value === null ? "" : `${name}: ${value}\n`;
    header = field.test(header) ? header.replace(field,replacement) : header + replacement;
  }
  return header + "---\n" + original.slice(end + 5) + addition;
}

export function referenceFiles(fixture: FreshCase, checkpoint: Checkpoint): Record<string, string> {
  if (checkpoint.clarify) return { ...fixture.files };
  const files = { ...fixture.files }, prefix = `${fixture.directory}/${fixture.target}`;
  const originalStatus = fixture.files[`${prefix}/status.md`]!;
  const confirmed = fixture.checkpoints.filter(row => checkpoint.history.includes(String(row.input.id))).map(row => row.input);
  const nextStep = checkpoint.calls[0] ?? (checkpoint.stage === "offer" ? checkpoint.input.nextStep : null);
  const oldDeadline = originalStatus.match(/^deadline: (.+)$/m)?.[1], oldStep = originalStatus.match(/^next_step: (.+)$/m)?.[1];
  const retired = oldDeadline && (checkpoint.stage === "offer" || checkpoint.stage === "closed") ? `\nPrevious next step: ${oldStep ?? "unknown"}; deadline ${oldDeadline} retired as history.\n` : "";
  files[`${prefix}/status.md`] = referenceEdit(originalStatus,{ stage: checkpoint.stage, next_step: nextStep ? JSON.stringify(nextStep) : null,
    deadline: checkpoint.deadline, ...(checkpoint.stage === "closed" ? { relevance: "historical", closed_reason: JSON.stringify(checkpoint.input.reason) } : {}) }, retired +
    `\n## Confirmed lifecycle\n\n${confirmed.map(event => `- Confirmed fact: ${JSON.stringify(event)}`).join("\n")}\n\n## Confirmed contacts\n\n${checkpoint.contacts.map(name => `- ${name}; contact details unknown, ask before outreach.`).join("\n")}\n`);
  if (checkpoint.calls.length || files[`${prefix}/interview-prep.md`]) {
    const oldPrep = fixture.files[`${prefix}/interview-prep.md`];
    files[`${prefix}/interview-prep.md`] = referenceEdit(oldPrep ?? doc("opportunity", "Interview preparation"),{ deadline: checkpoint.calls.length ? checkpoint.deadline : null },
      `\n## Upcoming calls\n\n${checkpoint.calls.length ? checkpoint.calls.map(call => `- ${call}`).join("\n") : "No scheduled calls."}\n\n## Related\n\n[[${prefix}/status]]\n[[${prefix}/research]]\n`);
  }
  files[fixture.focusPath] = fixture.files[fixture.focusPath]!.replace(`- [[${prefix}/status]] — Waiting to hear back.`,
    checkpoint.focus ? `- [[${prefix}/status]] — ${checkpoint.calls[0] ?? checkpoint.focus}` : "");
  if (checkpoint.stage === "closed" || checkpoint.stage === "offer") {
    for (const path of Object.keys(files).filter(path => path.startsWith(prefix + "/") && path !== `${prefix}/status.md`)) {
      const raw = files[path]!;
      const prior = fixture.files[path]?.match(/^deadline: (.+)$/m)?.[1] ?? raw.match(/^deadline: (.+)$/m)?.[1];
      files[path] = raw.replace(/^deadline: (.+)\n/m, "") + (prior ? `\nPrevious deadline ${prior} retained as history; no outstanding call.\n` : "");
    }
  }
  return files;
}
