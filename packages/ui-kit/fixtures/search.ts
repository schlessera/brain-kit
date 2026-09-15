// One query, three tabs: results, graph, timeline.
//
// The design's search screen is not a destination -- it is a query with three
// views of the same answer -- so the fixtures for all three live together and
// are answers to the SAME question. A graph fixture whose nodes have nothing
// to do with the result list above it looks fine in isolation and wrong on
// screen.

import type {
  GraphEdge,
  GraphNode,
  LegendItem,
  StatTile,
  SuggestionChip,
  TimelineItem,
} from "./types.js";

/** The query the whole screen is an answer to. */
export const query = "Where did Circe warn me about Scylla?";

/** The other queries the world offers, as `SuggestionChips`. */
export const suggestions: SuggestionChip[] = [
  { label: "What happened since leaving Troy?", icon: "digest", tone: "amber" },
  { label: "Who is still owed an offering?", icon: "policy", tone: "purple" },
  { label: "What did I promise Penelope?", icon: "ask", tone: "teal" },
  { label: "Which decisions cost men?", icon: "failed" },
];

/** The prompt behind the morning summary, written as the user would type it. */
export const summaryPrompt = "What happened since leaving Troy?";

export interface SearchHit {
  path: string;
  score: string;
  before: string;
  highlight: string;
  after: string;
  icon: "file" | "image";
}

/** Nine results; the three the screen actually shows. */
export const searchHits: SearchHit[] = [
  {
    path: "knowledge/scylla.md",
    score: "0.94",
    before: "…she named her before we were out of the bay: ",
    highlight: "six heads, six men, one pass",
    after: ". Not a fight. Row hard and accept the count…",
    icon: "file",
  },
  {
    path: "decisions/scylla-or-charybdis.md",
    score: "0.88",
    before: "…the advice was unambiguous. ",
    highlight: "Six certain against six hundred possible",
    after: " is not a close call, and the crew were not told…",
    icon: "file",
  },
  {
    path: "voyage/day-1043-strait.md",
    score: "0.71",
    before: "…held the Calabrian shore close enough to touch it, and ",
    highlight: "nobody stopped rowing",
    after: ". Six gone off the deck before the order could change…",
    icon: "file",
  },
];

export const searchResultCount = 9;

/** Tabs across the result set. The graph is a view, not a destination. */
export const searchTabs = [
  { label: `Results ${searchResultCount}` },
  { label: "Graph" },
  { label: "Timeline" },
];

/**
 * The 2-hop neighbourhood of the same query. `x` and `y` are percentages of
 * the viewport, not coordinates -- the map is the only thing in this world
 * that projects.
 */
export const graphNodes: GraphNode[] = [
  { label: "scylla", tone: "red", x: 50, y: 44, focus: true },
  { label: "charybdis", tone: "red", x: 74, y: 30 },
  { label: "circe", tone: "purple", x: 26, y: 26 },
  { label: "the strait", tone: "gold", x: 62, y: 60 },
  { label: "crew", tone: "neutral", x: 34, y: 70 },
  { label: "eurylochus", tone: "neutral", x: 14, y: 58 },
  { label: "aeaea", tone: "purple", x: 12, y: 40 },
  { label: "thrinacia", tone: "red", x: 84, y: 66 },
];

/** Index pairs into `graphNodes`. */
export const graphEdges: GraphEdge[] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 3],
  [0, 4],
  [4, 5],
  [2, 6],
  [2, 0],
  [3, 7],
  [4, 7],
];

export const graphLegend: LegendItem[] = [
  { label: "people", tone: "purple" },
  { label: "places", tone: "gold" },
  { label: "hazards", tone: "red" },
  { label: "crew", tone: "neutral" },
];

export const graphMeta = "2-hop · 34 nodes";

/** The third tab: the same query on a time axis. */
export const searchTimeline: TimelineItem[] = [
  {
    time: "d611",
    title: "Circe gives the directions",
    detail: "Aeaea, the morning we sailed. Scylla and Charybdis named in order.",
    meta: "people/circe.md",
    tone: "purple",
  },
  {
    time: "d1041",
    title: "The Sirens, exactly as described",
    detail: "First confirmation that the directions were reliable.",
    meta: "voyage/day-1041-sirens.md",
    tone: "teal",
  },
  {
    time: "d1043",
    title: "The strait",
    detail: "Six lost under Scylla. The ship came through.",
    meta: "decisions/scylla-or-charybdis.md",
    tone: "red",
  },
  {
    time: "d1044",
    title: "Thrinacia",
    detail: "The one condition the forecast set, broken on day thirty.",
    meta: "decisions/cattle-of-helios.md",
    tone: "red",
  },
];

/** The tiles above a structured chat answer. */
export const answerStats: StatTile[] = [
  { label: "sources", value: "4", meta: "all resolved", icon: "file", tone: "teal" },
  { label: "first named", value: "d611", meta: "Aeaea", icon: "history", tone: "purple" },
  { label: "cost", value: "6 men", meta: "as advised", icon: "failed", tone: "red" },
];

/** The collapsed trace line above the answer. */
export const answerTrace = "6 steps · 4 files touched · 2.4s";

/** What the user asked, verbatim, for the `MessageBubble`. */
export const userMessage = "Where did Circe warn me about Scylla, and did I tell the crew?";

/** The feedback row's question. Never "Was this helpful?". */
export const feedbackQuestion = "Did that answer the question?";

/** The empty-search copy, for the `no-results` state. */
export const noResults = {
  title: "Nothing in the corpus about that",
  body: "Ten years of this voyage are written down. This is not one of the things in them.",
  meta: "searched 4,812 documents · 0.2s",
};
