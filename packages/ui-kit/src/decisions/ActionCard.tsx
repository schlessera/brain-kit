import { GhostBand } from "../internal/GhostBand.js";
import { useId, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { Chip } from "../primitives/Chip.js";
import {
  GhostDot,
  GhostIconSlot,
  Ghosted,
  ghostLength,
  useArrival,
  useLastLengths,
  useLoadingValue,
  type GhostRole,
  type GhostTextProps,
} from "../internal/GhostText.js";
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
 * Loading is the card itself in ghost text (#1116): the kind line and foot
 * are mono ghosts, the title and body sans ghosts at their own sizes, in a
 * plain 1px frame with a 14px outline slot for the icon. The kind's skin —
 * bold, tinted, dashed — is data, so it arrives with the data. The plain
 * frame pads by one more pixel when the kind it is waiting for draws a 2px
 * border, so the text sits where it will land. Slots the caller already
 * passes while loading — a chip, machine facts, children, a foot link — keep
 * their space, invisibly, so their arrival moves nothing either.
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
  /** Finding severity may differ from the decision kind. */
  kindLabelTone?: Tone;
  /** An inline disclosure or control beside the kind label. */
  headAction?: ReactNode;
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
  /**
   * A real link in the foot line, separate from the card's own `onClick`:
   * "blocks queue item ▸" opens the Queue while the card itself stays a
   * container of controls. It is a native button with its own name, so a card
   * with no handler still offers this one target and nothing else. It
   * replaces the chevron, which would otherwise claim the whole card opens.
   */
  footLink?: { label: string; onClick: () => void; name?: string };
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
  const loading = st === "loading";
  const arriving = useArrival(loading);
  // The ghost's seed is this instance — kept per item key, not per list
  // position — so re-ranking a row never regenerates its glyphs.
  const id = useId();
  const title = p.title ?? "Write the corrected seat count into talks/lisbon-2026.md?";
  const kindLabel = p.kindLabel || k.label;
  const last = useLastLengths(st === "ready", {
    kind: kindLabel.length,
    title: title.length,
    body: p.body?.length ?? 0,
    foot: p.footMeta?.length ?? 0,
    dot: p.footDot ? 1 : 0,
  });
  // A card with no history ghosts a typical card: a body and a foot line.
  const lengths = useLoadingValue(loading, {
    kind: ghostLength(last.kind, p.kindLabel?.length, 8),
    title: ghostLength(last.title, p.title?.length, 58),
    body: ghostLength(last.body, p.body?.length, 44),
    foot: ghostLength(last.foot, p.footMeta?.length, 24),
    dot: ghostLength(last.dot, p.footDot ? 1 : undefined, 1),
  });
  const act = Boolean(p.onClick) && !loading;

  if (st !== "ready" && !loading) {
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
  const skin = loading
    ? { border: `1px solid ${color.line}`, background: color.surface, padding: em === "bold" ? 13 : 12 }
    : skins[em] || skins.plain;

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
    color: p.kindLabelTone ? accent[p.kindLabelTone].ink : kindColor,
  };
  const rightWrap: CSSProperties = { marginLeft: "auto", display: "flex" };
  const rightMetaStyle: CSSProperties = {
    marginLeft: "auto",
    font: `500 9.5px/1 ${font.mono}`,
    color: p.rightMetaTone === "red" ? accent.red.ink : color.inkMute,
  };
  const titleStyle: CSSProperties = {
    position: "relative",
    font: `400 13px/1.55 ${font.body}`,
    color: p.struck ? color.inkMute : color.ink,
    textDecoration: p.struck ? "line-through" : "none",
  };
  const bodyStyle: CSSProperties = { position: "relative", marginTop: 7, font: `400 11.5px/1.55 ${font.body}`, color: color.inkMute };
  const foot: CSSProperties = {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 9,
    font: `500 9.5px/1 ${font.mono}`,
    color: color.inkMute,
  };
  const chevWrap: CSSProperties = { marginLeft: "auto", display: "flex" };
  // Lines inside the card are offset by +0.1s each, top to bottom.
  const ghost = (slot: string, role: GhostRole, size: number, length: number, _line: number): GhostTextProps => ({
    role,
    size,
    length,
    seed: `${id}:${slot}`,
  });
  const showBody = loading ? lengths.body > 0 : Boolean(p.body);
  const showFoot = loading ? lengths.foot > 0 || Boolean(p.footLink) : Boolean(p.footMeta || p.footLink);
  // Known while loading, invisible until the data says what it holds — and
  // inert, so nothing inside it can be focused or pressed, even a descendant
  // that sets its own visibility back.
  const reserved: CSSProperties | undefined = loading ? { visibility: "hidden" } : undefined;
  // 44px tall like every other touch target; the visible text stays the
  // foot's mono size, so the line does not grow a button look.
  const footLinkStyle: CSSProperties = {
    marginLeft: "auto",
    minHeight: 44,
    minWidth: 44,
    padding: "0 4px",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    font: `500 10px/1.3 ${font.mono}`,
    color: accent.teal.ink,
    textAlign: "right",
    overflowWrap: "anywhere",
    ...({ "--hv-bg": "transparent", "--hv-fg": color.ink } as CSSProperties),
  };

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
      style={{ ...box, position: "relative" }}
      aria-busy={loading ? true : undefined}
      className={act ? "bk-row" : undefined}
      role={act ? "button" : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={act ? p.onClick : undefined}
      onKeyDown={act ? onKeyDown : undefined}
    >
      <div style={head}>
        {loading ? (
          <GhostIconSlot size={14} />
        ) : (
          <span className={arriving ? "bk-ghost-in" : undefined} style={{ display: "flex" }}>
            <Icon icon={p.icon || k.icon} size={14} color={kindColor} />
          </span>
        )}
        <span style={{ ...kindStyle, position: "relative" }}>
          <Ghosted loading={loading} arriving={arriving} ghost={ghost("kind", "mono", 10, lengths.kind, 0)}>
            {kindLabel}
          </Ghosted>
        </span>
        {p.headAction ? <span style={{ marginLeft: "auto", flex: "none" }}>{p.headAction}</span> : null}
        {p.rightChip ? (
          <span style={{ ...rightWrap, ...reserved }} inert={loading || undefined}>
            <Chip label={p.rightChip} tone={p.rightChipTone || "purple"} variant="outline" />
          </span>
        ) : null}
        {p.rightMeta ? (
          <span style={{ ...rightMetaStyle, ...reserved }} inert={loading || undefined}>
            {p.rightMeta}
          </span>
        ) : null}
      </div>
      <div style={titleStyle}>
        <Ghosted loading={loading} arriving={arriving} ghost={ghost("title", "sans", 13, lengths.title, 1)}>
          {title}
        </Ghosted>
      </div>
      {showBody ? (
        <div style={bodyStyle}>
          <Ghosted loading={loading} arriving={arriving} ghost={ghost("body", "sans", 11.5, lengths.body, 2)}>
            {p.body}
          </Ghosted>
        </div>
      ) : null}
      {/* Children get their own band. `body` sets `margin-top: 7` and `foot`
       * sets 9; children were the one slot with nothing, so a button row passed
       * in by a caller sat flush against the last line of the body and read as
       * part of the sentence above it. Wave 5's suggestion card is where that
       * showed up, and the caller could not fix it without putting a one-off
       * margin in a screen — which is the thing §11 says a screen must never
       * need. */}
      {p.children ? (
        <div style={{ marginTop: 10, ...reserved }} inert={loading || undefined}>
          {p.children}
        </div>
      ) : null}
      {showFoot ? (
        <div style={foot}>
          {loading ? (
            lengths.dot ? <GhostDot size={6} /> : null
          ) : p.footDot ? (
            <StatusDot tone={p.footDot} pulse={p.footPulse === true} size={6} />
          ) : null}
          {loading || (arriving && p.footMeta) ? (
            <span style={{ position: "relative" }}>
              <Ghosted loading={loading} arriving={arriving} ghost={ghost("foot", "mono", 9.5, lengths.foot, 3)}>
                {p.footMeta}
              </Ghosted>
            </span>
          ) : (
            p.footMeta
          )}
          {p.footLink ? (
            <button
              type="button"
              className="bk-control"
              style={{ ...footLinkStyle, ...reserved }}
              inert={loading || undefined}
              aria-label={p.footLink.name}
              onClick={(event) => {
                // The link is not the card: a card with its own handler must
                // not also open from the same tap.
                event.stopPropagation();
                if (loading) return;
                p.footLink!.onClick();
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {p.footLink.label}
            </button>
          ) : null}
          {p.chevron !== false && !p.footLink ? (
            <span style={chevWrap}>
              <Icon icon="next" size={12} color={color.inkMute} />
            </span>
          ) : null}
        </div>
      ) : null}
      <GhostBand loading={loading} arriving={arriving} />
    </div>
  );
}
