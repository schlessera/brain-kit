import { useId, type CSSProperties, type KeyboardEvent } from "react";

import {
  GhostDot,
  Ghosted,
  ghostLength,
  useArrival,
  useLastLengths,
  useLoadingValue,
  type GhostTextProps,
} from "../internal/GhostText.js";
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
 * Loading is the row itself in ghost text (#1116): the frame is final, the
 * state word, subject and meta are ghosts on one mono line, and the dot is a
 * grey `edge` slot until the state is known. A blocked or failed row takes
 * its tinted shell on arrival, not before — that emphasis is data. Each row
 * hands off when its own data lands; `index` offsets its sweep 0.15s per item.
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
  /** Position in its list: staggers the loading sweep by 0.15s per item. */
  index?: number;
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
  const loading = view === "loading";
  const arriving = useArrival(loading);
  // The ghost's seed is this instance — kept per item key, not per list
  // position — so re-ranking a row never regenerates its glyphs.
  const id = useId();
  const last = useLastLengths(view === "ready", {
    state: state.length,
    subject: (p.subject ?? "triage · share-9f2").length,
    meta: p.meta?.length,
    note: p.note?.length,
    link: p.link?.length,
  });
  const lengths = useLoadingValue(loading, {
    state: ghostLength(last.state, undefined, 7),
    subject: ghostLength(last.subject, undefined, 22),
    meta: ghostLength(last.meta, p.meta?.length, 0),
    note: ghostLength(last.note, p.note?.length, 0),
    link: ghostLength(last.link, p.link?.length, 0),
  });
  const act = Boolean(p.onClick) && !loading;

  if (view !== "ready" && !loading) {
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
        radius={12}
        onAction={p.onStateAction}
      />
    );
  }

  const box: CSSProperties = {
    border: `1px solid ${loading ? color.line : s.border}`,
    background: loading ? color.surface : s.bg,
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
  const stateStyle: CSSProperties = { position: "relative", fontWeight: 600, color: s.fg, flex: "none" };
  const subjectStyle: CSSProperties = {
    position: "relative",
    color: color.inkMute,
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
  const metaStyle: CSSProperties = { position: "relative", flex: "none", color: color.inkMute };

  const stagger = (Number(p.index) || 0) * 0.15;
  const ghost = (slot: string, length: number, line: number): GhostTextProps => ({
    role: "mono",
    size: 11,
    length,
    seed: `${id}:${slot}`,
    delay: stagger + line * 0.1,
  });
  const noteStyle: CSSProperties = { position: "relative", marginTop: 6, font: `400 11px/1.5 ${font.body}`, color: color.inkMute };
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
      aria-busy={loading ? true : undefined}
      className={act ? "bk-row" : undefined}
      role={act ? "button" : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={act ? p.onClick : undefined}
      onKeyDown={act ? onKeyDown : undefined}
    >
      <div style={topRow}>
        {loading ? <GhostDot size={7} /> : <StatusDot tone={s.dot} pulse={s.pulse} size={7} />}
        <b style={stateStyle}>
          <Ghosted loading={loading} arriving={arriving} ghost={ghost("state", lengths.state, 0)}>
            {state}
          </Ghosted>
        </b>
        <span style={subjectStyle}>
          <Ghosted loading={loading} arriving={arriving} ghost={ghost("subject", lengths.subject, 0)}>
            {p.subject ?? "triage · share-9f2"}
          </Ghosted>
        </span>
        {(loading ? lengths.meta : p.meta) ? (
          <span style={metaStyle}>
            <Ghosted loading={loading} arriving={arriving} ghost={ghost("meta", lengths.meta, 0)}>
              {p.meta}
            </Ghosted>
          </span>
        ) : null}
      </div>
      {(loading ? lengths.note : p.note) ? (
        <div style={noteStyle}>
          <Ghosted
            loading={loading}
            arriving={arriving}
            ghost={{ role: "sans", size: 11, length: lengths.note, seed: `${id}:note`, delay: stagger + 0.1 }}
          >
            {p.note}
          </Ghosted>
        </div>
      ) : null}
      {(loading ? lengths.link : p.link) ? (
        <div style={linkRow}>
          <Icon icon="link" size={12} />
          <span style={{ position: "relative" }}>
            <Ghosted loading={loading} arriving={arriving} ghost={{ ...ghost("link", lengths.link, 2), size: 10.5 }}>
              {p.link}
            </Ghosted>
          </span>
          <span style={linkChevron}>
            <Icon icon="next" size={12} color={color.inkMute} />
          </span>
        </div>
      ) : null}
    </div>
  );
}
