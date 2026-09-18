import type { CSSProperties, KeyboardEvent } from "react";

import { Icon } from "../primitives/Icon.js";
import { StatusDot } from "../primitives/StatusDot.js";
import { Placeholder } from "../states/Placeholder.js";
import { accent, color, font, token } from "../tokens.js";
import type { QueueState, Tone, ViewState } from "../types.js";

/**
 * The agent's side of the loop, shown as fact. The states are the queue's real
 * states and are never softened: claimed, blocked, ready, scheduled, failed,
 * superseded.
 *
 * `view` swaps the row for a `Placeholder` at card size with this component's
 * own copy — "Queue drained", "Queue unreachable" — overridable through
 * `stateMessage` / `stateDetail`.
 *
 * The error variant's retry becomes a real control when the caller passes
 * `onStateAction`, and stays the label the source draws when they do not. The
 * source has no such prop — it relies on its editor to wire buttons — so this
 * is the one place this port widens the API, and it widens it in the direction
 * the design's own gating rule already points: a control with no handler is
 * not a control. `onClick` is NOT reused for it, because "open this" and "try
 * the fetch again" are different actions and a callback that means both is a
 * bug waiting for its first caller.
 *
 * Only two of the six states colour their own shell. `blocked` is amber
 * because it is waiting on you; `failed` is red. The rest take the plain card
 * hairline, which is what keeps the two that matter visible.
 */
export interface QueueItemRowProps {
  view?: ViewState;
  state?: QueueState;
  /** The work, as `verb · target`. */
  subject?: string;
  /** Age or lease, right-aligned. */
  meta?: string;
  /** A second line saying why it is where it is. */
  note?: string;
  /** A teal link line with a chevron: what it is waiting on. */
  link?: string;
  stateMessage?: string;
  stateDetail?: string;
  stateAction?: string;
  /** Makes the error state's retry real. See the note above. */
  onStateAction?: () => void;
  onClick?: () => void;
}

interface StateSkin {
  dot: Tone;
  pulse: boolean;
  fg: string;
  border: string;
  bg: string;
}

const STATES: Record<QueueState, StateSkin> = {
  claimed: { dot: "amber", pulse: true, fg: color.ink, border: color.line, bg: color.surface },
  blocked: {
    dot: "amber",
    pulse: false,
    fg: accent.amber.ink,
    border: token("queue-border-blocked"),
    bg: token("queue-tint-blocked"),
  },
  ready: { dot: "teal", pulse: false, fg: color.ink, border: color.line, bg: color.surface },
  scheduled: { dot: "neutral", pulse: false, fg: color.ink, border: color.line, bg: color.surface },
  failed: { dot: "red", pulse: false, fg: accent.red.ink, border: token("queue-border-failed"), bg: color.surface },
  superseded: { dot: "neutral", pulse: false, fg: color.inkDim, border: color.line, bg: color.surface },
};

export function QueueItemRow(p: QueueItemRowProps) {
  const state = p.state || "claimed";
  const s = STATES[state] || STATES.claimed;
  const view = p.view || "ready";
  const act = Boolean(p.onClick);

  if (view !== "ready") {
    return (
      <Placeholder
        variant={view}
        message={p.stateMessage ?? (view === "empty" ? "Queue drained" : view === "error" ? "Queue unreachable" : undefined)}
        detail={
          p.stateDetail ??
          (view === "empty"
            ? "Nothing claimed, blocked or scheduled."
            : view === "error"
              ? "Last successful drain 14m ago."
              : undefined)
        }
        actionLabel={view === "error" ? (p.stateAction ?? "Retry") : undefined}
        icon={view === "empty" ? "resolved" : "failed"}
        lines={2}
        radius={12}
        onAction={p.onStateAction}
      />
    );
  }

  const box: CSSProperties = {
    border: `1px solid ${s.border}`,
    background: s.bg,
    borderRadius: 12,
    padding: "10px 12px",
    boxSizing: "border-box",
    width: "100%",
    flex: "none",
    // A superseded item is still shown — it is evidence that the queue did the
    // right thing — and it is NOT faded: `opacity: .7` took its meta ink to
    // 3.08:1 (design-feedback §4). It reads as superseded from its state word,
    // its dim ink and its still neutral dot, at full contrast.
    cursor: act ? "pointer" : "default",
    // A custom property is not in React's CSSProperties, so the entry is cast.
    ...({ "--hv-bg": act ? color.raised : s.bg } as CSSProperties),
  };
  const topRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8, font: `500 11px/1 ${font.mono}` };
  const stateStyle: CSSProperties = { fontWeight: 600, color: s.fg, flex: "none" };
  const subjectStyle: CSSProperties = {
    color: color.inkMute,
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
  const metaStyle: CSSProperties = { flex: "none", color: color.inkMute };
  const noteStyle: CSSProperties = { marginTop: 6, font: `400 11px/1.5 ${font.body}`, color: color.inkMute };
  const linkRow: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 7,
    marginTop: 7,
    font: `500 10.5px/1 ${font.mono}`,
    color: accent.teal.ink,
  };
  const linkChevron: CSSProperties = { marginLeft: "auto", display: "flex" };

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    p.onClick?.();
  }

  return (
    <div
      style={box}
      className={act ? "bk-row" : undefined}
      role={act ? "button" : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={p.onClick}
      onKeyDown={act ? onKeyDown : undefined}
    >
      <div style={topRow}>
        <StatusDot tone={s.dot} pulse={s.pulse} size={7} />
        <b style={stateStyle}>{state}</b>
        <span style={subjectStyle}>{p.subject ?? "triage · share-9f2"}</span>
        {p.meta ? <span style={metaStyle}>{p.meta}</span> : null}
      </div>
      {p.note ? <div style={noteStyle}>{p.note}</div> : null}
      {p.link ? (
        <div style={linkRow}>
          <Icon icon="link" size={12} />
          {p.link}
          <span style={linkChevron}>
            <Icon icon="next" size={12} color={color.inkMute} />
          </span>
        </div>
      ) : null}
    </div>
  );
}
