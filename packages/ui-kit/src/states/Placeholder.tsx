import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

import { GhostText, INCOMING, useArrival, type GhostSpec } from "../internal/GhostText.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * The three states every list and card needs, in one place so they cannot
 * diverge — the design's words:
 *
 *   loading = ghost text in the replaced content's type role, the spectrum
 *             sweeping through it, and a 600ms cross-fade to the real
 *             content when it lands (#1116) — never a spinner, never bars;
 *   empty   = dashed hairline, mono sentence saying what would be here and why
 *             it isn't;
 *   error   = red hairline with the failure named and, where one exists, a way
 *             to retry.
 *
 *   "Never a spinner: a spinner says 'wait' without saying what for."
 *
 * Ported first, because `ActionCard` (via `state`) and
 * `QueueItemRow`/`SearchResultCard`/`FileRow` (via `view`) all delegate their
 * loading, empty and error rendering here and supply their own copy.
 *
 * **The retry became a real control in wave 1b.** It takes `.bk-control` — the
 * +2 ring offset — because it is a small bordered pill with padding around it,
 * not a full-width row. Its hover moves the background only: `--hv-bd` is set
 * to the rest border deliberately rather than to D20's `#3a3e47`, because this
 * control's border is TONED and swapping it for neutral grey on hover would
 * change what the control means, which is the one thing D20 says hover must
 * never do. `--hv-bd` still has to be written: `.bk-control:hover` substitutes
 * it unconditionally, and an unset custom property there is invalid at
 * computed-value time, which resets `border-color` to `currentColor`.
 *
 * Gated on `onAction`, like every other affordance in the kit — a retry with
 * nobody listening stays the label the design draws.
 *
 * **Loading is ghost text** (#1116). `ghost` describes the content being
 * waited for, one entry per text block, each in its own type role and length;
 * a block wraps where the real text of that length would. Without `ghost`,
 * `lines` draws neutral one-line ghosts at the old bar widths, so a caller
 * that never said what it was waiting for still gets the new state.
 *
 * `arrived` makes the Placeholder the owner of the handoff: pass the real
 * content as children and flip `arrived` when it lands. The box stays, the
 * children fade in over 600ms and the ghost fades out on top of them, laid
 * over rather than beside, so it leaves no space behind. Until then the box
 * says `aria-busy`.
 */
export interface PlaceholderProps {
  variant?: "loading" | "empty" | "error";
  /** Overrides the per-variant sentence. Empty and error only. */
  message?: string;
  /** A second mono line under the message. */
  detail?: string;
  /** Error only; rendered as the retry affordance. */
  actionLabel?: string;
  icon?: IconName;
  tone?: Tone;
  /** Neutral ghost lines when no `ghost` is given, 1-5. */
  lines?: number;
  /** Loading only: the content being waited for, as ghost text. */
  ghost?: GhostSpec[];
  /** The seed for the ghost glyphs — the item's key, so they never flicker. */
  seed?: string;
  /** Loading only: the data has landed. Children are the real content. */
  arrived?: boolean;
  children?: ReactNode;
  bordered?: boolean;
  /** Set false to hold the ghost still: a static fill, still blurred. */
  animate?: boolean;
  pad?: number;
  onAction?: () => void;
  /* The four below are read by the source's renderVals() but absent from its
   * data-props, so they are real props with no editor control. Kept, because
   * dropping them would narrow the component's API during a port. */
  iconSize?: number;
  /** @deprecated Ignored since loading became ghost text (#1116). */
  barHeight?: number;
  gap?: number;
  radius?: number;
}

/** Two values per tone: the accent itself, and the hairline the retry
 * affordance borders in. The source writes that second one as the 8-digit hex
 * suffix `59`; it is a token now, resolved in `theme.css`. */
const TONES: Record<Tone, { fg: string; edge: string }> = {
  amber: { fg: accent.amber.ink, edge: token("placeholder-action-border-amber") },
  gold: { fg: accent.gold.ink, edge: token("placeholder-action-border-gold") },
  teal: { fg: accent.teal.ink, edge: token("placeholder-action-border-teal") },
  purple: { fg: accent.purple.ink, edge: token("placeholder-action-border-purple") },
  blue: { fg: accent.blue.ink, edge: token("placeholder-action-border-blue") },
  red: { fg: accent.red.ink, edge: token("placeholder-action-border-red") },
  neutral: { fg: accent.neutral.ink, edge: token("placeholder-action-border-neutral") },
};

/** Neutral ghost line widths, cycled. The first line is the short one. */
const WIDTHS = ["46%", "88%", "64%", "78%", "52%"];

/** Line height per role, so a ghost block wraps into the lines the content
 * would. The caller's own content sets the real ones. */
const LINE_HEIGHT = { sans: 1.55, mono: 1.4, title: 1.25 } as const;

export function Placeholder(p: PlaceholderProps) {
  const v = p.variant || "loading";
  const loading = v === "loading";
  const arrived = loading && p.arrived === true;
  const arriving = useArrival(loading && !arrived);
  const err = v === "error";
  const empty = v === "empty";
  const skin = TONES[p.tone || (err ? "red" : "neutral")] || TONES.neutral;
  const accent = skin.fg;
  const lines = Math.max(1, Number(p.lines) || 2);
  const bordered = p.bordered !== false;

  const message = empty || err ? (p.message ?? (err ? "Could not load this" : "Nothing here yet")) : null;
  const actionLabel = err ? p.actionLabel : null;
  const icon = p.icon || (err ? "failed" : "fyi");
  const iconSize = Number(p.iconSize) || 14;

  const seed = p.seed ?? "placeholder";
  const still = p.animate === false;
  // Lines inside one card are offset by +0.1s each, so the sweep travels down
  // the card rather than flashing every line at once.
  const ghosts = p.ghost?.length
    ? p.ghost.map((g, i) => (
        <div key={i} style={{ lineHeight: LINE_HEIGHT[g.role] }}>
          <GhostText role={g.role} size={g.size} length={g.length} seed={`${seed}:${i}`} delay={i * 0.1} animate={!still} />
        </div>
      ))
    : Array.from({ length: lines }).map((_, i) => (
        <div key={i} style={{ lineHeight: LINE_HEIGHT.sans }}>
          <GhostText
            role="sans"
            length={120}
            seed={`${seed}:${i}`}
            width={i === 0 && lines > 1 ? WIDTHS[0] : WIDTHS[(i + 1) % WIDTHS.length]}
            delay={i * 0.1}
            animate={!still}
          />
        </div>
      ));

  const box: CSSProperties = {
    boxSizing: "border-box",
    width: "100%",
    flex: "none",
    padding: Number(p.pad ?? 12),
    borderRadius: Number(p.radius) || 13,
    background: err ? token("placeholder-error-tint") : empty ? "transparent" : color.surface,
    border: bordered
      ? empty
        ? `1px dashed ${color.edge}`
        : `1px solid ${err ? token("placeholder-error-border") : color.line}`
      : "none",
  };

  const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: Number(p.gap) || 4 };
  const overlay: CSSProperties = { ...stack, position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" };
  const messageRow: CSSProperties = { display: "flex", alignItems: "center", gap: 9 };
  const textWrap: CSSProperties = {
    flex: 1,
    minWidth: 0,
    font: `500 11px/1.5 ${font.mono}`,
    color: err ? accent : color.inkMute,
  };
  const detailStyle: CSSProperties = {
    display: "block",
    marginTop: 3,
    font: `400 10.5px/1.5 ${font.mono}`,
    color: color.inkMute,
  };
  const actionStyle: CSSProperties = {
    flex: "none",
    border: `1px solid ${skin.edge}`,
    color: accent,
    borderRadius: 7,
    padding: "4px 9px",
    font: `600 10px/1.3 ${font.mono}`,
    cursor: p.onAction ? "pointer" : "default",
    ...({
      // A hue-free lift, so the tone survives the hover. See the note above for
      // why the border is restated rather than moved.
      "--hv-bg": token("hover-veil-firm"),
      "--hv-bd": skin.edge,
      "--hv-fg": accent,
    } as CSSProperties),
  };

  const act = Boolean(p.onAction);

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    p.onAction?.();
  }

  return (
    <div style={box} aria-busy={loading && !arrived ? true : undefined}>
      {loading && !arrived ? <div style={stack}>{ghosts}</div> : null}
      {arrived ? (
        // One tree from arrival on: ending the handoff drops the overlay and a
        // class, so stateful children never remount. The overlay comes first
        // and the content is positioned, so the content paints over it.
        <div style={{ position: "relative" }}>
          {arriving ? (
            <div aria-hidden="true" className="bk-ghost-out" style={overlay}>
              {ghosts}
            </div>
          ) : null}
          <div className={arriving ? "bk-ghost-in" : undefined} style={INCOMING}>
            {p.children}
          </div>
        </div>
      ) : null}
      {message ? (
        <div style={messageRow}>
          <Icon icon={icon} size={iconSize} color={accent} />
          <span style={textWrap}>
            {message}
            {p.detail ? <span style={detailStyle}>{p.detail}</span> : null}
          </span>
          {actionLabel ? (
            <span
              style={actionStyle}
              className={act ? "bk-control" : undefined}
              role={act ? "button" : undefined}
              tabIndex={act ? 0 : undefined}
              onClick={p.onAction}
              onKeyDown={act ? onKeyDown : undefined}
            >
              {actionLabel}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
