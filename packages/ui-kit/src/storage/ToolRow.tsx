import { Children, useId, useState, type ReactNode } from "react";

import { Button } from "../primitives/Button.js";
import { Chip } from "../primitives/Chip.js";
import { TextButton } from "../primitives/TextButton.js";
import { accent } from "../tokens.js";
import {
  HEADROOM_CAVEAT,
  TOOL_WORKING,
  toolAction,
  toolHeadroomView,
  toolResultLines,
  toolStateLine,
  type ToolChange,
  type ToolHeadroom,
  type ToolOutcomeCounts,
  type ToolRunState,
} from "./tool-row-model.js";

/**
 * One storage maintenance tool (#4545): what it does, its last run, the
 * measured change and the headroom it needs, with a quiet Run button and its
 * effect chip.
 *
 * Presentational: every figure arrives formatted, and the caller decides which
 * tools are shown and what their change was. The row decides only how a state
 * reads. An unknown is a mark (`?`, "not measured · reason"), never a zero and
 * never an empty bar, and every state carries a glyph and a word as well as a
 * colour.
 *
 * Layout follows the row's own width, not the viewport's: stacked below 720px
 * (name with the chip, description, state, result, headroom, then a full-width
 * button read after the evidence it depends on), three columns from 720px.
 */
export interface ToolRowProps {
  /** The tool's name, e.g. "Pack Git objects". */
  name: string;
  /** One plain line on what it does. Clamped to two lines. */
  description: string;
  state: ToolRunState;
  /** The receipt's time, formatted. Running reads it as "since {at}", waiting
   * as "queued {at}". */
  at?: string;
  /** False when the tool cannot run on this host at all. The row then drops
   * the button and the headroom and says why. Distinct from headroom. */
  available?: boolean;
  /** Why the tool is not available here, e.g. "Git not installed". */
  unavailableReason?: string | null;
  /** The receipt's reason, shown for refused and unknown outcomes. */
  reason?: string | null;
  /** The measured change for complete and partial runs. Absent reads as not
   * measured. */
  change?: ToolChange | null;
  /** Outcome counts for a partial run. */
  counts?: ToolOutcomeCounts | null;
  /** Leave out for a tool that frees space and has no estimate. */
  headroom?: ToolHeadroom | null;
  /** The effect chip's label. */
  effect?: string;
  /** Forces the cancelling state. The row also enters it by itself when
   * Cancel is pressed, until `state` changes. */
  cancelling?: boolean;
  onRun?: () => void;
  onCancel?: () => void;
}

export function ToolRow(p: ToolRowProps) {
  const id = useId();
  // Pressing Cancel holds the busy state until the receipt moves on. Reset
  // during render rather than in an effect, so no frame shows the stale state.
  const [cancelPressed, setCancelPressed] = useState(false);
  const [seenState, setSeenState] = useState(p.state);
  if (seenState !== p.state) {
    setSeenState(p.state);
    setCancelPressed(false);
  }
  const available = p.available !== false;
  const cancelling = p.cancelling === true || cancelPressed;
  const line = toolStateLine({ state: p.state, at: p.at, available, unavailableReason: p.unavailableReason, cancelling });
  const results = toolResultLines({ state: p.state, available, reason: p.reason, change: p.change, counts: p.counts });
  const action = toolAction({ state: p.state, available, cancelling });
  const running = available && p.state === "running";
  const headroom = available && p.state !== "running" ? toolHeadroomView(p.headroom) : ({ kind: "hidden" } as const);
  const handler = action.kind === "cancel" ? p.onCancel : action.kind === "none" ? undefined : p.onRun;

  return (
    <div className="bk-tool-row" data-tool-row="" data-state={available ? p.state : "unavailable"}>
      <div className="bk-tool-row-grid">
        <span className="bk-tool-name" id={`${id}-name`}>{p.name}</span>
        <span className="bk-tool-chip">
          <Chip variant="effect" label={p.effect ?? "maintain"} />
        </span>
        <span className="bk-tool-desc" title={p.description}>{p.description}</span>
        <div className="bk-tool-result">
          <span className="bk-tool-state" data-tool-state="">
            <span className="bk-tool-glyph" aria-hidden="true" style={{ color: accent[line.tone].ink }}>{line.glyph}</span>
            <span>{line.word}</span>
            {line.detail ? <span className="bk-tool-detail"> · {line.detail}</span> : null}
          </span>
          {running ? (
            <span className="bk-tool-working" data-tool-working="">
              <span className="bk-tool-stripe" aria-hidden="true" />
              <span>{TOOL_WORKING}</span>
            </span>
          ) : null}
          {running ? <span className="bk-tool-line bk-tool-wide-only">Result shown when it finishes</span> : null}
          {results.map((text) => (
            <span key={text} className="bk-tool-line" data-tool-result="">{text}</span>
          ))}
          {headroom.kind === "text" ? (
            <span className="bk-tool-headroom" data-tool-headroom={headroom.evidence}>
              <span className="bk-tool-label">Headroom</span> <span>{headroom.text}</span>
            </span>
          ) : null}
          {headroom.kind === "meter" ? (
            <span className="bk-tool-headroom" data-tool-headroom={headroom.short ? "short" : "enough"}>
              <span className="bk-tool-label">Headroom</span>
              <span
                className="bk-tool-meter"
                role="meter"
                aria-label={`Headroom for ${p.name}`}
                aria-valuemin={0}
                aria-valuemax={headroom.maxBytes}
                aria-valuenow={headroom.availableBytes}
                aria-valuetext={headroom.valueText}
                data-short={headroom.short ? "" : undefined}
              >
                <span className="bk-tool-meter-fill" data-tool-meter-fill="" style={{ width: `${headroom.availablePercent}%` }} />
                {headroom.short ? (
                  <span
                    className="bk-tool-meter-short"
                    data-tool-meter-short=""
                    style={{ left: `${headroom.availablePercent}%`, width: `${headroom.requiredPercent - headroom.availablePercent}%` }}
                  />
                ) : null}
                <span
                  className="bk-tool-meter-mark"
                  data-tool-meter-mark=""
                  style={{ left: `clamp(0px, calc(${headroom.requiredPercent}% - 1px), calc(100% - 2px))` }}
                />
              </span>
              <span className="bk-tool-caption">{headroom.caption}</span>
              <span className="bk-tool-caveat">{HEADROOM_CAVEAT}</span>
            </span>
          ) : null}
        </div>
        {action.kind !== "none" && handler ? (
          <span className="bk-tool-action">
            <Button
              tone="quiet"
              size="sm"
              center
              reach
              label={action.label}
              ariaLabel={`${action.label === "Cancelling…" ? "Cancelling" : action.label} ${p.name}`}
              disabled={action.disabled}
              onClick={() => {
                if (action.kind === "cancel") setCancelPressed(true);
                handler();
              }}
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}

const FOOTNOTE_LEAD = "Nothing else is safe to remove automatically. Use ";
const FOOTNOTE_TAIL = " to review the rest.";

/**
 * The maintenance section: a heading, the rows separated by a rule, and the
 * one footnote that replaces the old per-tool "Needs headroom…" paragraph.
 * State changes the caller words as `announcement` are read out politely.
 */
export interface ToolListProps {
  heading?: string;
  headingLevel?: 2 | 3 | 4;
  /** `ToolRow` elements, one per owner-supported tool. */
  children: ReactNode;
  /** Opens the breakdown's Find large files mode. Without it the footnote names
   * the mode as plain text. */
  onFindLargeFiles?: () => void;
  /** The latest state change in words, e.g. "Pack Git objects done. Available
   * up 1.8 gigabytes, unattributed." */
  announcement?: string;
}

export function ToolList(p: ToolListProps) {
  const id = useId();
  const Heading = `h${p.headingLevel ?? 2}` as "h2" | "h3" | "h4";
  return (
    <section className="bk-tool-list" aria-labelledby={`${id}-heading`} data-tool-list="">
      <Heading id={`${id}-heading`} className="bk-tool-list-heading">{p.heading ?? "Free up space"}</Heading>
      <ul className="bk-tool-list-rows">
        {Children.toArray(p.children).map((child, index) => (
          <li key={index}>{child}</li>
        ))}
      </ul>
      <p className="bk-tool-footnote" data-tool-footnote="">
        {FOOTNOTE_LEAD}
        {p.onFindLargeFiles ? <TextButton inline label="Find large files" onClick={() => p.onFindLargeFiles?.()} /> : "Find large files"}
        {FOOTNOTE_TAIL}
      </p>
      <span className="bk-sr-only" role="status" aria-live="polite" data-tool-live="">{p.announcement ?? ""}</span>
    </section>
  );
}
