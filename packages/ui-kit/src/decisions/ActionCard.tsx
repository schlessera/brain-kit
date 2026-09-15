import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

import { Chip } from "../primitives/Chip.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { StatusDot } from "../primitives/StatusDot.js";
import { Placeholder } from "../states/Placeholder.js";
import { accent, color, font, token } from "../tokens.js";
import type { ActionEmphasis, ActionKind, Tone, ViewState } from "../types.js";

/**
 * One item in the Actions list.
 *
 * `kind` decides icon, accent, border weight and kind label together, so
 * "decide this" never looks like "something broke". Approvals carry the heavy
 * border because they block a queue item. `rightChip` is for PROVENANCE
 * (untrusted · relayed); `rightMeta` is for machine facts (blocks a queue item,
 * 3 / 3 attempts) — the design keeps those two apart deliberately.
 *
 * `children` is the card's evidence slot: a `Receipt`, a `DiffBlock`, a
 * `TraceSteps` rail, a row of `Button`s. It renders between the body and the
 * footer, which is where the source's `{{ children }}` hole sits.
 *
 * `state` swaps the whole card for a `Placeholder` at card size with this
 * component's own copy — "Nothing waiting", "Actions unavailable" — overridable
 * through `stateMessage` / `stateDetail`.
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
 * Interaction states are ROW states (`.bk-row`): hover lifts by a translucent
 * veil rather than to `raised`, because two of the four emphases are already
 * tinted and lifting to an opaque colour would erase the tint that says what
 * kind of card this is. Focus is drawn at -2 so a list container cannot clip it.
 * All of it is gated on a handler.
 */
export interface ActionCardProps {
  state?: ViewState;
  kind?: ActionKind;
  title?: string;
  body?: string;
  /** Overrides the kind's icon. */
  icon?: IconName;
  /** Overrides the kind's uppercase label. */
  kindLabel?: string;
  /** Overrides the kind's border weight. */
  emphasis?: ActionEmphasis;
  /** Provenance, as an outline chip. */
  rightChip?: string;
  rightChipTone?: Tone;
  /** Machine facts, as mono text. Mutually exclusive with `rightChip` in
   * practice — both claim `margin-left: auto`. */
  rightMeta?: string;
  rightMetaTone?: "neutral" | "red";
  /** The footer line: when it was escalated, which run it came from. */
  footMeta?: string;
  footDot?: Tone;
  footPulse?: boolean;
  chevron?: boolean;
  /** A premise that has gone stale strikes the title through. */
  struck?: boolean;
  stateMessage?: string;
  stateDetail?: string;
  stateAction?: string;
  /** Makes the error state's retry real. See the note above. */
  onStateAction?: () => void;
  children?: ReactNode;
  onClick?: () => void;
}

/** The seven kinds resolve to five accents, so the ramp is five rows wide. */
type ActionTone = "amber" | "gold" | "teal" | "red" | "neutral";

interface KindSkin {
  icon: IconName;
  tone: ActionTone;
  label: string;
  em: ActionEmphasis;
}

/**
 * Each accent's four values, named rather than built by string concatenation —
 * an interpolated token name is a name TypeScript cannot check, and an
 * undefined custom property renders nothing at all rather than the wrong
 * colour, which is the failure this whole indirection exists to make loud.
 */
const RAMP: Record<ActionTone, { tint: string; bold: string; tinted: string; dashed: string }> = {
  amber: {
    tint: token("action-tint-amber"),
    bold: token("action-border-bold-amber"),
    tinted: token("action-border-tinted-amber"),
    dashed: token("action-border-dashed-amber"),
  },
  gold: {
    tint: token("action-tint-gold"),
    bold: token("action-border-bold-gold"),
    tinted: token("action-border-tinted-gold"),
    dashed: token("action-border-dashed-gold"),
  },
  teal: {
    tint: token("action-tint-teal"),
    bold: token("action-border-bold-teal"),
    tinted: token("action-border-tinted-teal"),
    dashed: token("action-border-dashed-teal"),
  },
  red: {
    tint: token("action-tint-red"),
    bold: token("action-border-bold-red"),
    tinted: token("action-border-tinted-red"),
    dashed: token("action-border-dashed-red"),
  },
  neutral: {
    tint: token("action-tint-neutral"),
    bold: token("action-border-bold-neutral"),
    tinted: token("action-border-tinted-neutral"),
    dashed: token("action-border-dashed-neutral"),
  },
};

const KINDS: Record<ActionKind, KindSkin> = {
  approval: { icon: "approval", tone: "amber", label: "Approval", em: "bold" },
  choose: { icon: "choose", tone: "teal", label: "Choose", em: "plain" },
  "dead-letter": { icon: "failed", tone: "red", label: "Dead letter", em: "plain" },
  quarantined: { icon: "quarantined", tone: "red", label: "Quarantined", em: "tinted" },
  unverified: { icon: "unverified", tone: "gold", label: "Premise unverified", em: "dashed" },
  fyi: { icon: "fyi", tone: "neutral", label: "FYI", em: "plain" },
  suggestion: { icon: "suggestion", tone: "amber", label: "Suggestion", em: "tinted" },
};

export function ActionCard(p: ActionCardProps) {
  const kind = p.kind || "approval";
  const k = KINDS[kind] || KINDS.approval;
  const em = p.emphasis || k.em;
  const st = p.state || "ready";
  const act = Boolean(p.onClick);

  if (st !== "ready") {
    return (
      <Placeholder
        variant={st}
        message={p.stateMessage ?? (st === "empty" ? "Nothing waiting" : st === "error" ? "Actions unavailable" : undefined)}
        detail={
          p.stateDetail ??
          (st === "empty"
            ? "Brain will escalate here when it needs you."
            : st === "error"
              ? "The queue could not be reached."
              : undefined)
        }
        actionLabel={st === "error" ? (p.stateAction ?? "Retry") : undefined}
        icon={st === "empty" ? "resolved" : "failed"}
        lines={3}
        radius={14}
        onAction={p.onStateAction}
      />
    );
  }

  const kindColor = accent[k.tone].ink;
  const ramp = RAMP[k.tone];
  const skins: Record<ActionEmphasis, CSSProperties> = {
    bold: { border: `2px solid ${ramp.bold}`, background: ramp.tint },
    tinted: { border: `1px solid ${ramp.tinted}`, background: color.surface },
    dashed: { border: `1px dashed ${ramp.dashed}`, background: ramp.tint },
    plain: { border: `1px solid ${color.line}`, background: color.surface },
  };
  const skin = skins[em] || skins.plain;

  const box: CSSProperties = {
    borderRadius: 14,
    padding: 12,
    boxSizing: "border-box",
    width: "100%",
    flex: "none",
    cursor: act ? "pointer" : "default",
    // A custom property is not in React's CSSProperties, so the entry is cast.
    ...({ "--hv-bg": act ? token("hover-veil") : (skin.background as string) } as CSSProperties),
    ...skin,
  };
  const head: CSSProperties = { display: "flex", alignItems: "center", gap: 7, marginBottom: 7 };
  const kindStyle: CSSProperties = {
    font: `600 10px/1 ${font.mono}`,
    letterSpacing: ".06em",
    textTransform: "uppercase",
    color: kindColor,
  };
  const rightWrap: CSSProperties = { marginLeft: "auto", display: "flex" };
  const rightMetaStyle: CSSProperties = {
    marginLeft: "auto",
    font: `500 9.5px/1 ${font.mono}`,
    color: p.rightMetaTone === "red" ? accent.red.ink : color.inkMute,
  };
  const titleStyle: CSSProperties = {
    font: `400 13px/1.55 ${font.body}`,
    color: p.struck ? color.inkMute : color.ink,
    textDecoration: p.struck ? "line-through" : "none",
  };
  const bodyStyle: CSSProperties = { marginTop: 7, font: `400 11.5px/1.55 ${font.body}`, color: color.inkMute };
  const foot: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 9,
    font: `500 9.5px/1 ${font.mono}`,
    color: color.inkMute,
  };
  const chevWrap: CSSProperties = { marginLeft: "auto", display: "flex" };

  // The design's key table gives ActionCard a / d / s — allow, deny, snooze —
  // on top of the role's own keys. This component has ONE callback, so only the
  // role's keys are wired here; a/d/s belong to whatever renders the three
  // buttons, because a shortcut has to reach a specific action and this card
  // does not know which of its children is "allow".
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
      <div style={head}>
        <Icon icon={p.icon || k.icon} size={14} color={kindColor} />
        <span style={kindStyle}>{p.kindLabel || k.label}</span>
        {p.rightChip ? (
          <span style={rightWrap}>
            <Chip label={p.rightChip} tone={p.rightChipTone || "purple"} variant="outline" />
          </span>
        ) : null}
        {p.rightMeta ? <span style={rightMetaStyle}>{p.rightMeta}</span> : null}
      </div>
      <div style={titleStyle}>{p.title ?? "Write the corrected seat count into talks/lisbon-2026.md?"}</div>
      {p.body ? <div style={bodyStyle}>{p.body}</div> : null}
      {p.children ?? null}
      {p.footMeta ? (
        <div style={foot}>
          {p.footDot ? <StatusDot tone={p.footDot} pulse={p.footPulse === true} size={6} /> : null}
          {p.footMeta}
          {p.chevron !== false ? (
            <span style={chevWrap}>
              <Icon icon="next" size={12} color={color.inkMute} />
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
