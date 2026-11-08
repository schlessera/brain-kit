/**
 * Reproducible Odysseus scenarios for the bounded multi-read spike (#3641).
 *
 * Every document is generated here from fixed text, so a scenario is the same
 * bytes on every run and nothing is copied from a private corpus. They are
 * written into a temporary copy of `packages/core/fixtures/corpus`, whose small
 * project documents serve the small-file cases. The world's reference date is
 * the pinned `2026-07-12`.
 */
import type { ReadManyRequest } from "../../packages/core/src/lib/ops/read-many.ts";

export const REFERENCE_DATE = "2026-07-12";

const note = (fields: Record<string, string>, body: string) =>
  "---\n" + Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n---\n\n" + body;

const SHIPS = ["Ithaca", "Zacynthus", "Same", "Dulichium", "Nericus", "Crocylea", "Aegilips", "Echinae", "Elis", "Cephallenia", "Neritum", "Ogygia"];

/** A crew ledger whose frontmatter is far larger than its body. */
function largeFrontmatter(): string {
  const crew = Array.from({ length: 600 }, (_, i) => `  - "Oarsman ${i + 1} of the ${SHIPS[i % 12]}"`).join("\n");
  return (
    "---\ntype: note\ntitle: \"Crew ledger from Troy\"\ncreated: 2026-07-01\nupdated: " + REFERENCE_DATE +
    "\ntags: [crew, ledger, ships]\nstatus: active\nrelevance: secondary\nsummary: \"600 men in 12 ships from Troy; none after Thrinacia\"\ncrew:\n" +
    crew + "\n---\n\n## Count\n\nSix hundred men left Troy in twelve ships. After Thrinacia, Odysseus is the single survivor.\n\n## Losses\n\nRecorded ship by ship in the frontmatter.\n"
  );
}

/** A voyage log with one short section per day: many headings. */
function manyHeadings(): string {
  const days = Array.from({ length: 240 }, (_, i) =>
    `## Day ${i + 1}\n\nWind from the ${["north", "east", "south", "west"][i % 4]}; ${i % 3 ? "the raft holds" : "Odysseus re-lashes the deck"}.\n`).join("\n");
  return note({ type: "journal", title: "\"Ogygia passage log\"", created: "2026-05-01", updated: REFERENCE_DATE, status: "active" }, "# Passage log\n\n" + days);
}

/** Star bearings copied as one unbroken line: no headings, no line to cut at. */
function hugeLine(): string {
  const reading = (i: number) => `Pleiades ${i % 90} deg, Bootes ${(i * 7) % 90} deg, the Bear on the left hand;`;
  return note({ type: "study", title: "\"Raw star bearings\"", created: "2026-07-10", updated: REFERENCE_DATE },
    Array.from({ length: 1200 }, (_, i) => reading(i)).join(" ") + "\n");
}

/**
 * Names and quotations in several scripts, with characters JSON must escape:
 * quotes, backslashes, tabs, an astral emoji (two UTF-16 units, four UTF-8
 * bytes) and Greek and CJK text (one unit, two or three bytes).
 */
function mixedScripts(): string {
  const raft = "\u{1F6F6}";
  const line = (i: number) =>
    `${i}. Ὀδυσσεύς 奥德修斯 ${raft} "the man of many turns" \\ path\\to\\raft\tcol`;
  return note({ type: "note", title: "\"Names of the wanderer\"", created: "2026-07-02", updated: REFERENCE_DATE },
    "## Names\n\n" + Array.from({ length: 60 }, (_, i) => line(i + 1)).join("\n") + "\n\n## Epithets\n\n\"Polytropos\" \\ \"much-enduring\".\n");
}

/** A raft build log that gains a section late in the document during the scenario. */
export function raftLog(launched: boolean): string {
  const days = Array.from({ length: 4 }, (_, i) => `## 2026-07-0${i + 8} Build day ${i + 1}\n\n${"Cut, joined and pegged timber. ".repeat(40)}\n`).join("\n");
  const launch = launched ? `\n## ${REFERENCE_DATE} Launch\n\nThe raft is in the water. Calypso's wind fills the sail; seventeen days to Scheria.\n` : "";
  return note({ type: "project", title: "\"Raft — build log\"", created: "2026-07-08", updated: launched ? REFERENCE_DATE : "2026-07-11", status: "active" },
    "# Build log\n\n" + days + launch);
}

/** One of twenty medium notes that together overflow a default result. */
const harbour = (i: number) =>
  note({ type: "note", title: `"Harbour ${i + 1}"`, created: "2026-06-01", updated: REFERENCE_DATE },
    `## Harbour ${i + 1}\n\n` + `Water, timber and a safe beach near ${SHIPS[i % 12]}. `.repeat(30) + "\n");

/** Repo-relative path to content of every generated scenario document. */
export function scenarioDocuments(): Record<string, string> {
  const docs: Record<string, string> = {
    "notes/crew-ledger.md": largeFrontmatter(),
    "journal/passage-log.md": manyHeadings(),
    "studies/raw-bearings.md": hugeLine(),
    "notes/names-of-the-wanderer.md": mixedScripts(),
    "projects/active/raft/build-log.md": raftLog(false),
  };
  for (let i = 0; i < 20; i++) docs[`notes/harbours/harbour-${String(i + 1).padStart(2, "0")}.md`] = harbour(i);
  return docs;
}

/** Small corpus documents a project-overview task reads by known path. */
export const SMALL_PATHS = [
  "projects/active/raft/status.md",
  "projects/active/sail-repairs/status.md",
  "context/current-focus.md",
  "me/identity.md",
];

export interface Scenario {
  id: string;
  covers: string;
  requests: ReadManyRequest[];
}

/** The request sets, each one batch, and the same requests as individual reads. */
export const SCENARIOS: Scenario[] = [
  { id: "small-files", covers: "small files", requests: SMALL_PATHS.map(path => ({ path })) },
  { id: "large-frontmatter", covers: "large frontmatter", requests: [{ path: "notes/crew-ledger.md" }] },
  { id: "many-headings", covers: "many headings", requests: [{ path: "journal/passage-log.md" }] },
  { id: "huge-line", covers: "huge lines", requests: [{ path: "studies/raw-bearings.md" }] },
  { id: "mixed-scripts", covers: "mixed scripts and JSON escaping", requests: [{ path: "notes/names-of-the-wanderer.md" }] },
  {
    id: "sections", covers: "sections",
    requests: [
      { path: "me/identity.md", section: "How to Work With Odysseus" },
      { path: "projects/active/raft/plan.md", section: "cut list" },
      { path: "projects/active/raft/status.md", section: "Next action" },
    ],
  },
  {
    id: "missing-refused", covers: "missing and refused paths",
    requests: [
      { path: "projects/active/raft/missing.md" },
      { path: "../outside.md" },
      { path: "/etc/hostname" },
      { path: "notes/escape-link.md" },
      { path: "projects/active/raft" },
      { path: "me/identity.md", section: "No Such Heading" },
    ],
  },
  {
    id: "duplicates", covers: "duplicate requests",
    requests: [
      { path: "projects/active/raft/status.md" },
      { path: "projects/active/raft/./status.md" },
      { path: "me/identity.md", section: "Reaching Odysseus" },
      { path: "me/identity.md", section: "reaching  ODYSSEUS" },
      { path: "me/identity.md" },
    ],
  },
  {
    id: "aggregate-overflow", covers: "aggregate overflow",
    requests: Array.from({ length: 20 }, (_, i) => ({ path: `notes/harbours/harbour-${String(i + 1).padStart(2, "0")}.md` })),
  },
];
