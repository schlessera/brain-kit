// The goal, the project under it, and the open loops under that.
//
// One goal. One project. Five threads. That ratio is deliberate: the Actions
// screen groups by thread, and a world with fifteen equal projects has no
// shape to group. The Odyssey has exactly one objective and a great many
// obstructions, which is the shape a backlog actually has.

import { DAYS_SINCE_TROY, RAFT_DEADLINE, daysAfter } from "./time.js";
import type {
  ComparisonColumn,
  ComparisonRow,
  Project,
  ProjectId,
  Step,
  Thread,
  ThreadId,
} from "./types.js";

/** The one goal. Everything in this world is downstream of this sentence. */
export const goal = {
  title: "Return to Ithaca",
  path: "goals/return-to-ithaca.md",
  stated: "Set foot on Ithaca, alive, and find the household still standing.",
  openFor: `${DAYS_SINCE_TROY} days`,
} as const;

export const projects: Project[] = [
  {
    id: "project:sail-home",
    title: "Sail home from Troy",
    status: "active",
    path: "voyage/_index.md",
    summary:
      "Budgeted one sailing season. Now in its tenth year, on its second vessel, with none of the original crew.",
    deadline: RAFT_DEADLINE,
    progress: 71,
    places: ["place:ogygia", "place:scheria", "place:ithaca"],
    people: ["person:athena", "person:poseidon", "person:calypso"],
  },
  {
    id: "project:raft",
    title: "Build a vessel that will hold",
    status: "done",
    path: "voyage/ogygia/_index.md",
    summary:
      "Twenty trees, four days, one adze, no help until it was offered. Decked, bulwarked, ballasted, and rigged with cloth she cut herself.",
    deadline: null,
    progress: 100,
    places: ["place:ogygia"],
    people: ["person:calypso"],
  },
  {
    id: "project:estate",
    title: "Hold the estate",
    status: "blocked",
    path: "ithaca/estate.md",
    summary:
      "Not yours to run from here, and being run anyway by someone who has had no instructions for twenty years and has needed none.",
    deadline: null,
    progress: 40,
    places: ["place:ithaca"],
    people: ["person:penelope", "person:laertes", "person:eumaeus", "person:antinous"],
  },
  {
    id: "project:crew",
    title: "Bring the crew home",
    status: "abandoned",
    path: "crew/_index.md",
    summary: "Six hundred out of Troy. Closed on day 1,095 with a count of zero and a survivor of one.",
    deadline: null,
    progress: 0,
    places: ["place:troy", "place:thrinacia"],
    people: ["person:eurylochus", "person:elpenor"],
  },
];

export const projectById: Record<ProjectId, Project> = Object.fromEntries(
  projects.map((p) => [p.id, p])
) as Record<ProjectId, Project>;

/* ----------------------------------------------------------- open loops */

export const threads: Thread[] = [
  {
    id: "thread:route",
    label: "Route home",
    state: "open",
    waitingOn: "the forecast, which has one unverified premise in it",
    project: "project:sail-home",
    tone: "amber",
  },
  {
    id: "thread:poseidon",
    label: "The grievance",
    state: "blocked",
    waitingOn: "a council decision nobody will put a date on",
    project: "project:sail-home",
    tone: "red",
  },
  {
    id: "thread:supplies",
    label: "Water and stores",
    state: "open",
    waitingOn: "seventeen days of drinking water on a raft with no cask",
    project: "project:sail-home",
    tone: "gold",
  },
  {
    id: "thread:ithaca",
    label: "The hall",
    state: "blocked",
    waitingOn: "arriving, which is the only move that changes anything",
    project: "project:estate",
    tone: "purple",
  },
  {
    id: "thread:crew",
    label: "Crew safety",
    state: "closed-badly",
    waitingOn: "nothing. It closed itself on Thrinacia.",
    project: "project:crew",
    tone: "neutral",
  },
];

export const threadById: Record<ThreadId, Thread> = Object.fromEntries(
  threads.map((t) => [t.id, t])
) as Record<ThreadId, Thread>;

/** Threads that still need something. The Actions screen's grouping. */
export const openThreads: Thread[] = threads.filter((t) => t.state !== "closed" && t.state !== "closed-badly");

/* ------------------------------------------------------------ kit shapes */

/**
 * The voyage as a `StepList variant="progress"`: what is behind, what is
 * happening now, what is still ahead. Three states, one current.
 */
export const voyageSteps: Step[] = [
  {
    title: "Leave Ogygia",
    detail: "Raft launched on the morning tide, stores aboard, sail set.",
    meta: "today",
    state: "current",
  },
  {
    title: "Keep the Great Bear on the left hand",
    detail: "Calypso's own directions. Steer east of north and do not correct at night.",
    meta: "17 days",
    code: "bearing 067",
    state: "todo",
  },
  {
    title: "Make Scheria",
    detail: "Sailors with fast ships. No standing claim on their help.",
    meta: `due ${daysAfter(17)}`,
    state: "todo",
  },
  {
    title: "Land on Ithaca",
    detail: "Unannounced. The hall has a hundred and eight men in it who would prefer otherwise.",
    meta: "no date",
    state: "todo",
  },
];

/** The same list at the checklist scale: today's work, before the launch. */
export const launchChecklist: Step[] = [
  { title: "Twenty trees felled and squared", meta: "4 days", state: "done" },
  { title: "Deck laid, bulwarks fitted", meta: "day 3", state: "done" },
  { title: "Sail cut and bent on", meta: "day 4", state: "done" },
  { title: "Water aboard", detail: "One skin. Seventeen days of sailing.", meta: "short", state: "current" },
  { title: "Bread and a second skin of wine", meta: "not yet", state: "todo" },
];

/**
 * The decision the world is best known for, laid out the way the kit lays out
 * a decision: two columns, one of them recommended, and the recommendation
 * stated as a cost rather than as a preference.
 */
export const straitChoice: { columns: ComparisonColumn[]; rows: ComparisonRow[] } = {
  columns: [
    { label: "Pass under Scylla", note: "Circe's advice", tone: "amber", recommended: true },
    { label: "Pass over Charybdis", note: "the other shore", tone: "red" },
  ],
  rows: [
    { label: "Losses", cells: [{ v: "6 men", tone: "gold" }, { v: "all hands", tone: "red" }] },
    { label: "Certainty", cells: [{ v: "certain", tone: "red" }, { v: "three times a day", tone: "gold" }] },
    { label: "Ship", cells: [{ v: "survives", tone: "teal" }, { v: "lost", tone: "red" }] },
    { label: "Recoverable", cells: [{ v: "no", tone: "red" }, { v: "no", tone: "red" }] },
    { label: "Source", cells: ["knowledge/scylla.md", "knowledge/charybdis.md"] },
  ],
};
