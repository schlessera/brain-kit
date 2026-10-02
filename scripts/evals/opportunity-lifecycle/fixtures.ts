import { createLab, type Event } from "./prototype";

export const DAY = "2026-07-12";
export const doc = (type: string, title: string, extra = "", body = "") =>
  `---\ntype: ${type}\ntitle: ${title}\ncreated: ${DAY}\nupdated: ${DAY}\nstatus: active\nrelevance: primary\ntags: [job-search]\n${extra}---\n\n${body}`;
export const prose = "Alex Example keeps this researched paragraph, its punctuation, and  two spaces.\n";
export const schedule = (opportunity = "ridge", roundId = "screen", id = "book-screen"): Extract<Event, { kind: "scheduled" }> => ({
  id, kind: "scheduled", opportunity, on: DAY, roundId, round: "Screening", format: "Video, 30 minutes",
  startsAt: "2026-07-20T09:00:00+02:00", timeZone: "Europe/Berlin",
  contact: { id: "reviewer", name: "Hiring team", role: "Recruiting", details: null },
});
export function prepare(opportunity = "ridge", custom = false, existingPrep = false, moduleFallback = false) {
  const dir = custom ? "work/leads" : "career/opportunities";
  const focus = custom ? "context/now.md" : "context/current-focus.md";
  const focusBefore = `- [[${dir}/${opportunity}/status]] — Waiting to hear back.`;
  const status = doc("opportunity", "Tracked role", "stage: applied\n", `## Contacts\n\n| Name | Role | Relationship | Notes |\n|------|------|--------------|-------|\n\n## Timeline\n\n- ${DAY}: applied.\n\n## Notes\n\n${prose}`);
  const files: Record<string, string> = {
    [`${dir}/${opportunity}/status.md`]: status,
    [`${dir}/${opportunity}/research.md`]: doc("opportunity", "Research", "", prose),
    [focus]: doc("context", "Current focus", "", `## Priorities\n\n${focusBefore}\n- Preserve the unrelated priority.\n`),
    "notes/unrelated.md": doc("note", "Other note", "", "An unrelated note stays byte-identical.\n"),
  };
  if (existingPrep) files[`${dir}/${opportunity}/interview-prep.md`] = doc("opportunity", "Existing prep", "", `## Positioning\n\n${prose}`);
  return { lab: createLab(files, custom, moduleFallback), dir, focus, focusBefore, files };
}
// Separate entities and layouts; these are proposed goldens, pending independent review.
export const cases = [
  { id: "new", split: "tuning", entity: "ridge", custom: false, prep: false, fallback: false },
  { id: "existing-prep", split: "tuning", entity: "ridge", custom: false, prep: true, fallback: false },
  { id: "custom-taxonomy", split: "held-out", entity: "cedar", custom: true, prep: true, fallback: false },
  { id: "module-directory", split: "held-out", entity: "harbor", custom: true, prep: false, fallback: true },
] as const;
