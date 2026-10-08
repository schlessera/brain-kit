/**
 * @schlessera/brain-ui-kit — the brain-kit design kit.
 *
 * Presentational React components only: props in, callbacks out. No stores, no
 * fetch, no ambient configuration, no browser globals (D13, enforced by
 * `scripts/check-kit-purity.ts`). Everything stateful lives in
 * `@schlessera/brain-ui-react`, which consumes this package.
 *
 * The tokens ship as CSS, in two forms:
 *   `@schlessera/brain-ui-kit/theme.css`  — the @theme block, for a consumer
 *                                           with its own Tailwind v4 build
 *   `@schlessera/brain-ui-kit/styles.css` — precompiled, for one without
 *
 * LOADING ONE OF THEM IS MANDATORY. Every colour a component renders resolves
 * through a `--bk-*` custom property with no fallback, so without the
 * stylesheet the components render with no colour at all — as do the `breathe`
 * keyframe, the three font families and the interaction states.
 *
 * That is deliberate. A fallback would let a consumer who forgot the stylesheet
 * render in the DARK palette whatever theme they asked for, which is a failure
 * that looks deliberate and ships; no colour is a failure that gets fixed in
 * minutes. See `src/tokens.ts` for the full reasoning.
 */

/* Tokens and shared unions. */
export { color, font } from "./tokens.js";
// The token tables, their `TokenName` keys and the canvas palettes are
// first-party only, in `./internal` (#1053): ui-react reads them where there
// is no document. A consumer references the `--bk-*` custom properties.
export type {
  ActionEmphasis,
  ActionKind,
  AttachmentKind,
  AttachmentTone,
  ButtonTone,
  CalloutVariant,
  ChipVariant,
  ContactKind,
  ContactTone,
  DeltaTone,
  Emphasis,
  EmptyTone,
  EmptyVariant,
  ComposerVariant,
  FeedbackValue,
  FileKind,
  InkTone,
  LabelTone,
  ListRowVariant,
  MessageRole,
  QuoteTone,
  QueueState,
  RunState,
  RunToolState,
  ScreenHeaderVariant,
  StepListVariant,
  StepState,
  StreamPhase,
  SubtitleTone,
  SuggestionTone,
  ToastTone,
  Tone,
  ToggleTone,
  TraceState,
  ValueTone,
  ViewState,
} from "./types.js";

/* Primitives. */
export { Button, type ButtonProps } from "./primitives/Button.js";
export { Callout, type CalloutProps } from "./primitives/Callout.js";
export { Chip, type ChipProps } from "./primitives/Chip.js";
export { DiffBlock, type DiffBlockProps } from "./primitives/DiffBlock.js";
export { ICONS, Icon, type IconName, type IconProps } from "./primitives/Icon.js";
export { Label, type LabelProps } from "./primitives/Label.js";
export { Meter, type MeterProps } from "./primitives/Meter.js";
export { PathRef, type PathRefProps } from "./primitives/PathRef.js";
export { StatusDot, type StatusDotProps } from "./primitives/StatusDot.js";
export { Surface, type SurfaceProps } from "./primitives/Surface.js";
export { Toggle, type ToggleProps } from "./primitives/Toggle.js";

/* Rows and lists. */
export { ChoiceOption, type ChoiceOptionProps } from "./rows/ChoiceOption.js";
export { FileRow, type FileRowProps } from "./rows/FileRow.js";
export { FilterRow, type FilterItem, type FilterRowProps } from "./rows/FilterRow.js";
export { ListRow, type ListRowProps } from "./rows/ListRow.js";
export { QueueItemRow, type QueueItemRowProps } from "./rows/QueueItemRow.js";

/* Evidence and data. */
export { BarList, type BarListProps, type BarListRow } from "./evidence/BarList.js";
export {
  DataTable,
  type DataTableCell,
  type DataTableColumn,
  type DataTableProps,
  type DataTableRow,
} from "./evidence/DataTable.js";
export { Receipt, type ReceiptProps, type ReceiptRow } from "./evidence/Receipt.js";
export { SearchResultCard, type SearchResultCardProps } from "./evidence/SearchResultCard.js";
export { TraceSteps, type TraceStep, type TraceStepsProps } from "./evidence/TraceSteps.js";

/* Decision surfaces. */
export { ActionCard, type ActionCardProps } from "./decisions/ActionCard.js";
export { EffectPreview, effectLineCount, type EffectPreviewProps } from "./decisions/EffectPreview.js";
export { DispositionBar, type DispositionBarProps, type DispositionControl } from "./decisions/DispositionBar.js";
export { ApprovalCard, type ApprovalCardProps } from "./decisions/ApprovalCard.js";
export { AskUserCard, type AskUserCardProps, type AskUserOption, type AskUserState } from "./decisions/AskUserCard.js";
export { AskUserGroupCard, type AskUserGroupCardProps, type AskUserGroupQuestion } from "./decisions/AskUserGroupCard.js";
export {
  AskUserListCard,
  type AskUserListCardProps,
  type AskUserListItem,
  type AskUserListOption,
  type AskUserListState,
  type AskUserListSubmission,
} from "./decisions/AskUserListCard.js";
export {
  NotificationCard,
  type NotificationAction,
  type NotificationCardProps,
} from "./decisions/NotificationCard.js";

/* States. */
export { Placeholder, type PlaceholderProps } from "./states/Placeholder.js";
export type { GhostRole, GhostSpec } from "./internal/GhostText.js";

/* In-chat content blocks — the shapes an answer can take inside a transcript. */
export { CodeBlock, type CodeBlockProps } from "./blocks/CodeBlock.js";
export { ContactCard, type ContactAction, type ContactCardProps, type ContactFact } from "./blocks/ContactCard.js";
export { Disclosure, type DisclosureProps } from "./blocks/Disclosure.js";
export { FeedbackRow, type FeedbackRowProps } from "./blocks/FeedbackRow.js";
export { LinkPreviewCard, type LinkPreviewCardProps } from "./blocks/LinkPreviewCard.js";
export {
  TrackerPillList,
  type TrackerAction,
  type TrackerEvent,
  type TrackerPillListProps,
} from "./blocks/TrackerPillList.js";
/* `mercY` and `step` are exported from the module but deliberately NOT from
 * here: they are the projection's internals, `tests/mapview-projection.test.ts`
 * imports them directly, and `step` is far too generic a name to put into a
 * published package's top-level namespace. */
export {
  MapView,
  type MapCluster,
  type MapLand,
  type MapPath,
  type MapPin,
  type MapViewProps,
} from "./blocks/MapView.js";
export {
  PlaceList,
  PlaceMap,
  type PlaceListProps,
  type PlaceListRow,
  type PlaceMapFrame,
  type PlaceMapProps,
} from "./blocks/PlaceMap.js";
export { QuoteCard, type QuoteCardProps } from "./blocks/QuoteCard.js";
export {
  ScheduleList,
  type ScheduleGroup,
  type ScheduleItem,
  type ScheduleListProps,
} from "./blocks/ScheduleList.js";
export { StatTiles, type StatTile, type StatTilesProps } from "./blocks/StatTiles.js";
export { StepList, type Step, type StepListProps } from "./blocks/StepList.js";
export {
  TimelineList,
  type TimelineItem,
  type TimelineListProps,
} from "./blocks/TimelineList.js";
export { TrendChart, type TrendChartProps } from "./blocks/TrendChart.js";

/* Conversation lifecycle — what wraps an answer, before and after it lands. */
export { AttachmentRow, type AttachmentRowProps } from "./conversation/AttachmentRow.js";
export {
  ComparisonTable,
  type ComparisonCell,
  type ComparisonColumn,
  type ComparisonRow,
  type ComparisonTableProps,
} from "./conversation/ComparisonTable.js";
export {
  DigestCard,
  type DigestCardProps,
  type DigestGroup,
  type DigestItem,
} from "./conversation/DigestCard.js";
export { EmptyState, type EmptyStateProps } from "./conversation/EmptyState.js";
export { InlineToast, type InlineToastProps } from "./conversation/InlineToast.js";
export { TurnErrorCard, type TurnErrorCardProps, type TurnErrorAction } from "./conversation/TurnErrorCard.js";
export {
  RelatedFiles,
  type RelatedFileItem,
  type RelatedFilesProps,
} from "./conversation/RelatedFiles.js";
export { StreamingAnswer, type StreamingAnswerProps } from "./conversation/StreamingAnswer.js";
export {
  SuggestionChips,
  type SuggestionChipsProps,
  type SuggestionItem,
} from "./conversation/SuggestionChips.js";

/* Agent and corpus views — what a run looks like from outside it. */
export {
  AgentOrbit,
  type AgentOrbitProps,
  type OrbitAgent,
} from "./agents/AgentOrbit.js";
export {
  AgentRunCard,
  type AgentRunCardProps,
  type AgentRunTool,
} from "./agents/AgentRunCard.js";
export {
  GraphView,
  type GraphEdge,
  type GraphLegendItem,
  type GraphNode,
  type GraphViewProps,
} from "./agents/GraphView.js";
export {
  HATCH_GLYPH,
  LaneChart,
  type Lane,
  type LaneChartProps,
  type LaneLegendItem,
  type LaneSegment,
} from "./agents/LaneChart.js";

/* Chrome — the frame a screen is assembled inside. */
export { BottomSheet, type BottomSheetProps } from "./chrome/BottomSheet.js";
export { DiscButton, DiscRow, type DiscButtonProps, type DiscRowProps } from "./chrome/DiscButton.js";
export { Composer, type ComposerProps, type ComposerRecall, type ComposerState } from "./chrome/Composer.js";
export { ComposerRow, type ComposerRowProps } from "./chrome/ComposerRow.js";
export {
  PendingFollowUps,
  followUpLabel,
  type PendingFollowUp,
  type PendingFollowUpsProps,
} from "./chrome/PendingFollowUps.js";
export {
  SessionStrip,
  WORKING_STATES,
  describeWorkingSession,
  type SessionStripProps,
  type WorkingSession,
  type WorkingSessionView,
  type WorkingState,
} from "./chrome/SessionStrip.js";
export { ModelPicker, type ModelPickerProps } from "./chrome/ModelPicker.js";
export { MessageBubble, type MessageBubbleProps } from "./chrome/MessageBubble.js";
export { ScreenBody, type ScreenBodyProps } from "./chrome/ScreenBody.js";
export { ScreenHeader, type ScreenHeaderProps } from "./chrome/ScreenHeader.js";
export { TabBar, type TabBarProps, type TabItem } from "./chrome/TabBar.js";

/* Desktop (D22). Same component files as mobile above them; only the frame and
 * the density change. `PhoneFrame` is deliberately NOT here — it is a device
 * mock for presenting screens, so it lives in `stories/` as furniture (D16). */
export {
  CommandPalette,
  type CommandPaletteProps,
  type PaletteGroup,
  type PaletteItem,
} from "./desktop/CommandPalette.js";
export { SideRail, type RailAct, type RailItem, type SideRailProps } from "./desktop/SideRail.js";
export { AskUserRankCard } from "./decisions/AskUserRankCard.js";
export type { AskUserRankCardProps, AskUserRankSubmission } from "./decisions/AskUserRankCard.js";

export { ScaleList } from "./decisions/AskUserListCard.js";
export type { ScaleListProps } from "./decisions/AskUserListCard.js";
export { RankList } from "./decisions/AskUserRankCard.js";
export type { RankListProps } from "./decisions/AskUserRankCard.js";

export { AskUserFormCard } from "./decisions/AskUserFormCard.js";
export type { AskUserFormCardProps, AskUserFormSubmission, FormNodeBase, FormNode, FormOption, FormAnswer, FormAnswers } from "./decisions/AskUserFormCard.js";

export { TrackMap, type TrackMapProps } from "./blocks/TrackMap.js";
export { RecordingRow, type RecordingRowProps, type RecordingRowState } from "./rows/RecordingRow.js";
