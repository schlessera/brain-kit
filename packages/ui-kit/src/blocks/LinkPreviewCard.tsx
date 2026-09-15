import type { CSSProperties, KeyboardEvent } from "react";

import { Icon } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";

/**
 * An external thing that arrived from outside the corpus — a shared article, a
 * fetched page, something relayed second-hand.
 *
 * The hatched thumb is a deliberate placeholder: Brain does not render remote
 * images inline. When the origin is untrusted the purple provenance line is
 * not optional, and passing `trust` also turns the card's own border purple —
 * so a monochrome screenshot still parses, which is the design's first
 * non-negotiable rule.
 *
 * Opening one is NAVIGATION, never an effect, which is why the whole card is
 * one target and carries no effect chip.
 *
 * **Interaction states landed in wave 1b**, which is the wave D17 named for
 * them. The design still ships none for this component, so the states are the
 * SYSTEM'S rather than this component's invention: `.bk-row`, not
 * `.bk-control`, because a preview card is a full-width block and a ring at
 * +2 would be clipped by the first `overflow: hidden` ancestor. Opening one is
 * navigation, so the whole card is a single `role="button"` with one accessible
 * name — its title, meta and provenance line, read as one thing, which is what
 * a card that is one target should sound like.
 *
 * Gated on the handler like everything else: no `onClick`, no class, no role,
 * no tab stop, no ring.
 */
export interface LinkPreviewCardProps {
  title?: string;
  /** Source, reading time, when it was staged. Mono. */
  meta?: string;
  /** The provenance line. Its PRESENCE is what makes the card purple. */
  trust?: string;
  /** Title on one line with an ellipsis. On by default. */
  clamp?: boolean;
  thumbSize?: number;
  onClick?: () => void;
}

export function LinkPreviewCard(p: LinkPreviewCardProps) {
  const act = Boolean(p.onClick);
  const size = Number(p.thumbSize) || 44;

  const box: CSSProperties = {
    border: `1px solid ${p.trust ? token("provenance-border") : color.edge}`,
    background: color.surface,
    borderRadius: 13,
    padding: 11,
    boxSizing: "border-box",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 9,
    cursor: act ? "pointer" : "default",
    // A card's rest ground is `surface`; hover is the design's one step up.
    ...({ "--hv-bg": act ? color.raised : color.surface } as CSSProperties),
  };

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
      <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
        <span
          style={{
            width: size,
            height: size,
            borderRadius: 9,
            flex: "none",
            background: `repeating-linear-gradient(135deg,${color.raised} 0 6px,${token("hatch-stripe")} 6px 12px)`,
          }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <b
            style={{
              display: "block",
              font: `600 12.5px/1.35 ${font.body}`,
              color: color.ink,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: p.clamp === false ? "normal" : "nowrap",
            }}
          >
            {p.title ?? "What the hall is saying about the succession"}
          </b>
          <span
            style={{
              display: "block",
              marginTop: 3,
              font: `400 10px/1.4 ${font.mono}`,
              color: accent.neutral.ink,
            }}
          >
            {p.meta ?? "relayed second-hand · 4 min · staged 01:40"}
          </span>
        </div>
      </div>
      {p.trust ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            paddingTop: 9,
            borderTop: `1px solid ${color.line}`,
            font: `500 9.5px/1.4 ${font.mono}`,
            color: accent.purple.ink,
          }}
        >
          <Icon icon="trust" size={12} color={accent.purple.ink} />
          {p.trust}
        </div>
      ) : null}
    </div>
  );
}
