/**
 * The unions the design's `data-props` blocks name in their `tsType` fields.
 *
 * Copied from the source rather than re-derived: `tsType` is already
 * TypeScript source text, so where a prop declares `Tone` it gets `Tone`.
 *
 * Two components carry their own narrower tone set, and both are narrowed here
 * rather than widened to `Tone`, because in each case the component's runtime
 * table and its `data-props` options agree on the smaller set:
 *   - `Label` adds `ink`, which no other component offers.
 *   - `Toggle` supports exactly three; anything else falls back to amber, and
 *     a type that permits a value the component silently discards is a type
 *     that lies.
 */

/** Status semantics. amber = agent acting or your approval needed, teal = ok
 * or your turn, red = failed, gold = caution, purple = untrusted origin,
 * blue = companies and T1 triage, neutral = idle or scheduled. */
export type Tone = "amber" | "gold" | "teal" | "purple" | "blue" | "red" | "neutral";

/** `Label` alone may render in primary ink. */
export type LabelTone = Tone | "ink";

/** `Toggle`'s track only has three colours. */
export type ToggleTone = "amber" | "teal" | "purple";

/** `Surface` border weight. hairline = inert container, strong = interactive,
 * bold = needs a decision, dashed = stale or unverified. */
export type Emphasis = "hairline" | "strong" | "bold" | "dashed" | "none";

/** `Chip` shape. Meaning comes from `tone`, shape from here. */
export type ChipVariant =
  | "outline"
  | "soft"
  | "solid"
  | "pill"
  | "kv"
  | "effect"
  | "mono"
  | "count"
  | "ghost";

/** `Callout` shape. accent = editorial aside inside prose, boxed = a standing
 * notice, banner = a provenance or trust statement. */
export type CalloutVariant = "accent" | "boxed" | "banner" | "plain";

/** `Button` intent. Not a `Tone`: these name what the tap does, not a status. */
export type ButtonTone = "primary" | "affirm" | "ghost" | "quiet" | "danger" | "suggest";

/** `ListRow` container. group = a row inside a Surface's list, card =
 * standalone, launcher = the larger first-run tile, plain = no chrome. */
export type ListRowVariant = "group" | "card" | "launcher" | "plain";

/** `FileRow` node kind. `open` is a folder that is open, not a second thing. */
export type FileKind = "folder" | "open" | "file" | "image";

/** The queue's real states, never softened. */
export type QueueState = "claimed" | "blocked" | "ready" | "scheduled" | "failed" | "superseded";

/** `TraceSteps` step state. */
export type TraceState = "done" | "active" | "paused" | "failed" | "skipped";

/** What `ActionCard` is asking for. `kind` decides icon, accent, border weight
 * and kind label, so "decide this" never looks like "something broke". */
export type ActionKind =
  | "approval"
  | "choose"
  | "dead-letter"
  | "quarantined"
  | "unverified"
  | "fyi"
  | "suggestion";

/** How loudly an `ActionCard` states its kind. Defaults per kind. */
export type ActionEmphasis = "bold" | "tinted" | "dashed" | "plain";

/** The loading/empty/error swap the four `Placeholder` delegators take. */
export type ViewState = "ready" | "loading" | "empty" | "error";

/* ── Wave 3: in-chat blocks and conversation lifecycle ──────────────────────
 *
 * Six of these narrow `Tone`. The rule is the one at the top of this file —
 * a type that permits a value the component silently discards is a type that
 * lies — and wave 1 already set the precedent for overriding a `data-props`
 * declaration when the runtime table is narrower (`icon` is typed `IconName`,
 * not the declared `string`). Each narrowed union below is exactly the keys of
 * its component's own tone table, and `packages/ui-kit/fixtures/types.ts` says
 * why that matters from the other side: a fixture must not be able to name a
 * colour the component cannot draw.
 */

/** `StepList` container. numbered = a recipe you follow, checklist = things to
 * tick off, progress = something being executed for you. */
export type StepListVariant = "numbered" | "checklist" | "progress";

/** A step's state. `progress` expects exactly one `current`. */
export type StepState = "done" | "current" | "todo";

/** `ContactCard` entity kind. Decides the avatar shape and the default tone. */
export type ContactKind = "person" | "company" | "project";

/** `ContactCard`'s five. Entity colours: teal person, blue company, purple
 * project, amber a host, neutral anything unremarkable. */
export type ContactTone = "teal" | "blue" | "purple" | "amber" | "neutral";

/** `QuoteCard`'s five. Provenance, not severity — the quote is somebody's real
 * words and the rail says whose, which is why there is no red. */
export type QuoteTone = "teal" | "amber" | "purple" | "blue" | "neutral";

/** `SuggestionChips`' five. `neutral` here resolves to DIM INK rather than to
 * the neutral accent: a chip suggesting a plain question is text-coloured. */
export type SuggestionTone = "teal" | "amber" | "purple" | "blue" | "neutral";

/** `TrendChart`'s delta pill has two readings and no third. */
export type DeltaTone = "teal" | "red";

/** `AttachmentRow` kind. What the user sent in, rendered as what it is. */
export type AttachmentKind = "image" | "audio" | "doc" | "link";

/** `AttachmentRow`'s five. */
export type AttachmentTone = "teal" | "amber" | "purple" | "blue" | "neutral";

/** What the agent is doing right now, in its own vocabulary. */
export type StreamPhase = "thinking" | "searching" | "reading" | "fetching" | "writing";

/** `InlineToast`'s five. A receipt is confirmed, pending, provenance-bearing,
 * failed, or unremarkable. */
export type ToastTone = "teal" | "amber" | "purple" | "red" | "neutral";

/** `FeedbackRow`'s recorded answer. `null` is "not asked yet", not "no". */
export type FeedbackValue = "up" | "down" | null;

/** `EmptyState` shape. offline and first-run are the same shape because both
 * are states the user can fix. */
export type EmptyVariant = "caught_up" | "no-results" | "offline" | "first-run" | "quiet";

/** `EmptyState`'s six. No blue: no empty state means "a company". */
export type EmptyTone = "amber" | "gold" | "teal" | "purple" | "red" | "neutral";

/* ── Wave 4: agent views, chrome and desktop ────────────────────────────── */

/** What a run is doing. `waiting` is YOUR turn, not the agent's — the two are
 * different colours for that reason. */
export type RunState = "running" | "waiting" | "done" | "failed";

/** A named tool inside a run's strip. `idle` has not been reached yet. */
export type RunToolState = "done" | "active" | "failed" | "idle";

/** `ScreenHeader` shape. title = a destination, nav = a pushed detail view,
 * hero = a decision screen that opens with a sentence. */
export type ScreenHeaderVariant = "title" | "nav" | "hero";

/** `ScreenHeader`'s subtitle line. Three, not seven: a status line under a
 * title is fine, ok or broken. */
export type SubtitleTone = "neutral" | "teal" | "red";

/** `Composer` shape. send = a thread you are in, voice = the composer as
 * primary navigation, plain = read-only surfaces. */
export type ComposerVariant = "send" | "voice" | "plain";

/** Who is speaking. `brain` is not a bubble at all — the answer is the page. */
export type MessageRole = "user" | "brain";
