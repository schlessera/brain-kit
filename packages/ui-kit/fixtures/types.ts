// The vocabulary the fixture world speaks.
//
// Two layers live in this directory and this file declares both:
//
//   1. WORLD types  — Person, Place, Project, Note, Run, ... The Odyssey as a
//      graph of stable ids. These are ours; nothing outside the fixtures
//      depends on their shape.
//   2. KIT SHAPES   — StatTile, TimelineItem, MapPin, TraceStep, ... one
//      interface per array-valued prop in the design drop. These are
//      reproduced from `.plan/design/catalog.md` and the `data-props` blocks
//      of the 56 `*.dc.html` component files, so that a fixture which
//      typechecks here is assignable to the component when it lands.
//
// The kit shapes are a deliberate, temporary mirror, and it shrinks as the
// port lands: when a component ships its own prop interface, the shape here is
// re-pointed at `../src` instead of restated. Wave 3 re-pointed thirteen of
// them, and doing so is what makes the stated guarantee below REAL rather than
// aspirational -- a fixture that names a tone its component cannot draw is now
// a compile error rather than a colourless span in a screenshot.
//
// What is still mirrored here belongs to components that have not shipped yet.
// Wave 4 re-pointed seven more -- OrbitAgent, RunTool, Lane, LaneSegment,
// LegendItem, GraphNode/GraphEdge and TabItem, plus RunState itself -- which
// leaves the world types and a handful of evidence shapes. Re-point each as
// its wave lands.

/* ------------------------------------------------------------------ tones */

// Tone, ButtonTone and the icon vocabulary are the KIT's, not the fixtures'.
// They are imported rather than restated so a fixture cannot name a colour or
// an icon the components do not have -- a fixture typo becomes a compile
// error instead of a blank square in a screenshot.
import type {
  ButtonTone,
  ContactTone,
  EmptyTone,
  QuoteTone,
  SuggestionTone,
  ToastTone,
  Tone,
  RunState as KitRunState,
} from "../src/types.js";
import type { IconName } from "../src/primitives/Icon.js";

// Shapes the kit now owns. Re-exported under the fixtures' own names so no
// fixture file has to change its imports, and so the two vocabularies stay one.
import type { ContactAction, ContactFact } from "../src/blocks/ContactCard.js";
import type { MapPath, MapPin } from "../src/blocks/MapView.js";
import type { ScheduleGroup, ScheduleItem } from "../src/blocks/ScheduleList.js";
import type { StatTile } from "../src/blocks/StatTiles.js";
import type { Step } from "../src/blocks/StepList.js";
import type { TimelineItem } from "../src/blocks/TimelineList.js";
import type {
  ComparisonColumn,
  ComparisonRow,
} from "../src/conversation/ComparisonTable.js";
import type { DigestGroup, DigestItem } from "../src/conversation/DigestCard.js";
import type { RelatedFileItem } from "../src/conversation/RelatedFiles.js";
import type { SuggestionItem } from "../src/conversation/SuggestionChips.js";
import type { AgentRunTool } from "../src/agents/AgentRunCard.js";
import type { OrbitAgent } from "../src/agents/AgentOrbit.js";
import type { GraphEdge, GraphNode } from "../src/agents/GraphView.js";
import type { Lane, LaneLegendItem, LaneSegment } from "../src/agents/LaneChart.js";
import type { TabItem } from "../src/chrome/TabBar.js";

export type {
  ComparisonColumn,
  ComparisonRow,
  ContactAction,
  ContactFact,
  DigestGroup,
  DigestItem,
  GraphEdge,
  GraphNode,
  Lane,
  LaneSegment,
  MapPath,
  MapPin,
  OrbitAgent,
  ScheduleGroup,
  ScheduleItem,
  StatTile,
  Step,
  TabItem,
  TimelineItem,
};

/** The fixtures' name for `AgentRunCard`'s tool strip entry. */
export type RunTool = AgentRunTool;

/**
 * The fixtures' name for a legend row.
 *
 * `LaneChart`'s is the wider of the two — it carries the swatch `glyph` that
 * `GraphView`'s does not — so one alias serves both and a lane legend stays
 * assignable to a graph legend.
 */
export type LegendItem = LaneLegendItem;

/** The fixtures' name for `RelatedFiles`' row. */
export type RelatedFile = RelatedFileItem;

/** The fixtures' name for `SuggestionChips`' chip. */
export type SuggestionChip = SuggestionItem;

export type { ButtonTone, ContactTone, EmptyTone, IconName, QuoteTone, SuggestionTone, ToastTone, Tone };

/** Reads better at a fixture call site than `IconName` does. Same union. */
export type IconKey = IconName;

/**
 * Every component that can stand in for its own data uses this. Declared here
 * because the kit has not shipped `Placeholder`'s public union yet; move the
 * import up to `../src` when it does.
 */
export type ViewState = "ready" | "loading" | "empty" | "error";

/* ----------------------------------------------------------- world: ids */

export type PersonId = `person:${string}`;
export type PlaceId = `place:${string}`;
export type ProjectId = `project:${string}`;
export type ThreadId = `thread:${string}`;
export type NoteId = `note:${string}`;
export type RunId = `run:${string}`;

/* ------------------------------------------------------- world: entities */

/** How the owner of the brain stands towards someone. */
export type Standing = "household" | "ally" | "hostile" | "host" | "crew" | "counterparty" | "dead";

export interface Person {
  id: PersonId;
  /** Display name. */
  name: string;
  /**
   * What they are to the voyage, in the world's own register. Never a modern
   * job title -- "Chief suitor", not "Stakeholder".
   */
  role: string;
  /** Where they are right now, as a `PlaceId`. Null when it is not knowable. */
  at: PlaceId | null;
  standing: Standing;
  /** Two letters for the avatar fallback. */
  initials: string;
  /** The relationship note, one sentence, stated as fact. */
  relationship: string;
  /** Reserved-range contact details, or null where the world has none. */
  phone: string | null;
  email: string | null;
  /** Path of the person's document in the brain. */
  path: string;
  /** Days since that document was last touched, measured from REFERENCE_DATE. */
  staleDays: number;
  tone: Tone;
}

export type PlaceKind =
  /** Home. There is exactly one. */
  | "home"
  /** Somewhere the voyage has already been. */
  | "visited"
  /** Somewhere the voyage must still pass. */
  | "ahead"
  /** A named danger rather than a landfall. */
  | "hazard"
  /** Reached by someone else in the world, not by the owner. */
  | "elsewhere";

export interface Place {
  id: PlaceId;
  /** The name in the poem. */
  name: string;
  /** The real place the coordinate belongs to, and which the map draws. */
  site: string;
  lat: number;
  lon: number;
  kind: PlaceKind;
  /** Day of the voyage, counted from the fall of Troy. Null if never visited. */
  day: number | null;
  /** One sentence of what happened, or is expected to. */
  summary: string;
  /** The English Wikipedia article the coordinate was read from. */
  source: string;
  tone: Tone;
}

export type ProjectStatus = "active" | "blocked" | "done" | "abandoned";

export interface Project {
  id: ProjectId;
  title: string;
  status: ProjectStatus;
  path: string;
  summary: string;
  /** ISO date, pinned. Null when the thing genuinely has no deadline. */
  deadline: string | null;
  /** 0-100. Stated, not computed: the world knows how far along it is. */
  progress: number;
  places: PlaceId[];
  people: PersonId[];
}

export type ThreadState = "open" | "blocked" | "closed" | "closed-badly";

/** An open loop. The thing the Actions screen groups by. */
export interface Thread {
  id: ThreadId;
  label: string;
  state: ThreadState;
  /** What it is waiting on, in one clause. */
  waitingOn: string;
  project: ProjectId;
  tone: Tone;
}

export type NoteKind = "note" | "knowledge" | "decision" | "journal" | "omen" | "oath" | "person";

export interface Note {
  id: NoteId;
  path: string;
  title: string;
  kind: NoteKind;
  /** ISO date, pinned. */
  updated: string;
  /** Days since `updated`, measured from REFERENCE_DATE. */
  staleDays: number;
  tags: string[];
  /** Outbound wiki-links, by target path. Every one of these resolves. */
  links: string[];
  /** Entities the note is about. */
  people: PersonId[];
  places: PlaceId[];
  /** The sentence worth quoting out of it. */
  excerpt: string;
}

/** Re-pointed at the kit in wave 4, along with the six agent-view shapes. */
export type RunState = KitRunState;

export interface Run {
  id: RunId;
  /** The agent's functional name. The tooling is modern; its errands are not. */
  agent: "researcher" | "note-filer" | "source-watch" | "ledger";
  state: RunState;
  /** The quoted task. */
  task: string;
  /** 0-100. */
  progress: number;
  steps: number;
  tokens: number;
  /** Whole cents, so no fixture ever prints a float it did not mean. */
  cents: number;
  /** Elapsed, pre-formatted -- the world has no stopwatch to re-run. */
  elapsed: string;
  thread: ThreadId | null;
}

/* ------------------------------------------------- kit shapes: primitives */

export interface BarRow {
  label: string;
  pct: number;
  value: string;
  tone?: Tone;
}

export interface ReceiptRow {
  k: string;
  v: string;
  tone?: Tone;
}

export interface TableColumn {
  label: string;
  w?: number;
  align?: "left" | "right";
}

export interface TableCell {
  v: string;
  tone?: Tone;
  mono?: boolean;
  bold?: boolean;
}

export interface TableRow {
  cells: TableCell[];
}

export interface TrendSeries {
  label: string;
  value: string;
  delta: string;
  deltaTone: "teal" | "red";
  /** Raw values in the series' own unit. TrendChart scales them itself. */
  values: number[];
  ticks: string[];
  tone?: Tone;
}

export interface FilterItem {
  label: string;
}

/* ------------------------------------------------------ kit shapes: lists */

export interface AskOption {
  title: string;
  subtitle?: string;
  selected?: boolean;
  mono?: boolean;
  italic?: boolean;
  dim?: boolean;
}

export interface NotificationAction {
  label: string;
  tone?: ButtonTone;
}

/* ------------------------------------------------ kit shapes: agent views */

export interface TraceStep {
  state: "done" | "active" | "paused" | "failed" | "skipped";
  tool: string;
  text?: string;
  time?: string;
  output?: string;
}

/* ------------------------------------------------- kit shapes: graph, map */

/** Everything MapView needs for one view, so no caller re-derives a bbox. */
export interface MapScene {
  title: string;
  subtitle: string;
  meta: string;
  icon: IconKey;
  pins: MapPin[];
  paths: MapPath[];
  /** Minimum span, in kilometres. MapView widens to fit the pins. */
  spanKm: number;
  height: number;
}
