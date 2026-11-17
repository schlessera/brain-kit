/**
 * Reproducible Odysseus workload for the multi-query search spike (#3645).
 *
 * The documents are the core fixture corpus plus the generated documents of
 * the bounded-read spike (`../bounded-read/scenarios.ts`): twenty harbour
 * notes, a raft build log, a crew ledger, a passage log and others, all
 * written from fixed text with the pinned reference date `2026-07-12`. No
 * document is added here, so both spikes search and read the same brain.
 *
 * Each task is the set of searches one research step needs, named as a
 * caller would name them. `useful` lists, per query, the documents that
 * answer it: the coverage measure counts how many of those (query, path)
 * pairs an answer returns *attributed to that query*.
 */
import { REFERENCE_DATE, scenarioDocuments } from "../bounded-read/scenarios.ts";

export { REFERENCE_DATE, scenarioDocuments };

/** One named query, in the names `brain_search` takes over MCP. */
export interface NamedQuery {
  id: string;
  query: string;
  type?: string;
  tag?: string;
  relevance?: string;
  mode?: "fts" | "vector" | "hybrid";
  include_archived?: boolean;
  limit?: number;
  updated_since?: string;
  updated_before?: string;
  deadline_from?: string;
  deadline_to?: string;
  sort?: "score" | "updated" | "deadline";
  /** #3644 path scope, with `brain_context`'s semantics. Not a `brain_search` input today. */
  include?: string[];
  exclude?: string[];
}

export interface Task {
  id: string;
  shape: string;
  queries: NamedQuery[];
  /** Per query id, the paths that answer it. */
  useful: Record<string, string[]>;
}

export const TASKS: Task[] = [
  {
    id: "project-overview",
    shape: "overlapping: four status-style searches over the same projects",
    queries: [
      { id: "raft", query: "raft status" },
      { id: "sail", query: "sail repairs status" },
      { id: "focus", query: "current focus" },
      { id: "timber", query: "timber" },
    ],
    useful: {
      raft: ["projects/active/raft/status.md"],
      sail: ["projects/active/sail-repairs/status.md"],
      focus: ["context/current-focus.md"],
      timber: ["projects/active/raft/plan.md", "projects/active/raft/build-log.md"],
    },
  },
  {
    id: "disjoint",
    shape: "disjoint: three unrelated topics",
    queries: [
      { id: "rehab", query: "knee rehab", limit: 5 },
      { id: "bearings", query: "star bearings", limit: 5 },
      { id: "harbours", query: "safe beach", limit: 5 },
    ],
    useful: {
      rehab: ["health/knee-injury.md"],
      bearings: ["studies/star-bearings.md"],
      harbours: ["notes/harbours/harbour-01.md"],
    },
  },
  {
    id: "filtered",
    shape: "one topic under different per-query filters and sorts",
    queries: [
      { id: "projects", query: "raft", type: "project" },
      { id: "journal", query: "raft", type: "journal", limit: 5 },
      { id: "recent", query: "timber", updated_since: REFERENCE_DATE, sort: "updated", limit: 5 },
      { id: "due", query: "raft", deadline_from: REFERENCE_DATE, sort: "deadline", limit: 5 },
    ],
    useful: {
      projects: ["projects/active/raft/status.md"],
      journal: ["journal/2026-07-01.md"],
      recent: ["notes/harbours/harbour-01.md"],
      due: ["projects/active/raft/status.md"],
    },
  },
  {
    id: "heavy-overlap",
    shape: "overlapping and wide: a survey of every harbour, four searches of 20 that share the harbour notes; the useful hits include each list's tail",
    queries: [
      { id: "water", query: "harbour water", limit: 20 },
      { id: "beach", query: "safe beach", limit: 20 },
      { id: "timber", query: "timber", limit: 20 },
      { id: "ithaca", query: "Ithaca", limit: 20 },
    ],
    useful: {
      water: ["notes/quick-note-water.md", "notes/harbours/harbour-19.md"],
      beach: ["notes/harbours/harbour-20.md"],
      timber: ["projects/active/raft/plan.md", "projects/active/raft/build-log.md"],
      ithaca: ["me/identity.md", "notes/harbours/harbour-13.md"],
    },
  },
];

/** A call whose queries fail, repeat or find nothing. Not a coverage task. */
export const EDGE_QUERIES: NamedQuery[] = [
  { id: "raft", query: "raft status", limit: 5 },
  { id: "bad-date", query: "raft", updated_since: "2026-07-32", limit: 5 },
  { id: "no-answer", query: "tribute return deadline", limit: 5 },
  { id: "raft-again", query: "raft status", limit: 5 },
  { id: "bad-sort", query: "raft", sort: "tide" as never, limit: 5 },
];

/**
 * Scoped searches (#3644 semantics). Today `brain_search` takes no path
 * scope, so an agent filters the results itself; the prototype pushes the
 * scope into the candidate pool, as `assembleContext` does.
 */
export const SCOPED_QUERIES: NamedQuery[] = [
  { id: "raft-timber", query: "timber", include: ["projects/"] },
  { id: "harbour-timber", query: "timber", include: ["notes/harbours/"], exclude: ["notes/harbours/harbour-01.md"] },
  { id: "not-me", query: "Ithaca", exclude: ["me/"] },
];
