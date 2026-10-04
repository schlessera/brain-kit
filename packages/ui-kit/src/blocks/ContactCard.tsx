import { Fragment, type CSSProperties } from "react";

import { Cue } from "../internal/cue.js";
import { warnOnce } from "../internal/dev.js";
import { VALUE_CUE } from "../internal/tone-cue.js";
import { Button } from "../primitives/Button.js";
import { Chip } from "../primitives/Chip.js";
import type { IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { ButtonTone, ContactKind, ContactTone, ValueTone } from "../types.js";

/**
 * An entity the corpus knows about — a person, a company, a project — surfaced
 * inside an answer.
 *
 * Colour follows the entity language: teal person, blue company, purple
 * project. Facts are things the corpus can PROVE (last contact, open threads),
 * never enrichment fetched from the web, which is why they are mono and
 * key-aligned rather than prose.
 *
 * **Entity tone vs fact tone.** The avatar's tone names WHAT KIND OF THING
 * this is and is the component's own five. A fact names WHAT STATE it is in,
 * which is a different question, so facts take the full value set including
 * `gold` and `red`: a relationship twenty years cold is red, not amber. An
 * unlisted fact tone falls back to dim rather than inheriting. Both are the
 * 2026-09-18 drop's answer to design-feedback §2.
 *
 * **What survives grayscale (#309).** A person is a circle, which is already
 * a shape. A company and a project are both rounded squares told apart by
 * blue against purple, so a mono kind word leads the role line for those two
 * (`COMPANY ·`, `PROJECT ·`) in the 9px label style `StatTiles` uses. A word,
 * not a third avatar shape: squares with different corner radii do not
 * survive a 38px print, and a word cannot be misread. A judged fact draws its
 * tone's glyph leading the value (`internal/tone-cue.ts`).
 */
export interface ContactFact {
  k: string;
  v: string;
  tone?: ValueTone;
}

export interface ContactAction {
  label: string;
  icon?: IconName;
  tone?: ButtonTone;
  onClick?: () => void;
}

export interface ContactCardProps {
  /** The display name. `name` is reserved in the design's runtime, so the
   * source calls it `label` and the port keeps the design's name. */
  label?: string;
  role?: string;
  kind?: ContactKind;
  /** A soft chip beside the name — standing, not status. */
  badge?: string;
  tone?: ContactTone;
  facts?: ContactFact[];
  actions?: ContactAction[];
  /** Derived from `label` when absent. */
  initials?: string;
  /** Minimum shared fact-key column width in pixels. Finite positive values
   * are honored; absent, invalid or nonfinite values use 84. The column grows
   * to the widest key, capped at max(92, minimum), then complete keys wrap.
   * A supplied minimum above 92 is not clamped; oversized widths are the
   * caller's responsibility and may overflow a narrow card. */
  keyWidth?: number;
}

const INKS: Record<ContactTone, string> = {
  teal: accent.teal.ink,
  blue: accent.blue.ink,
  purple: accent.purple.ink,
  amber: accent.amber.ink,
  neutral: accent.neutral.ink,
};

/** Fact values: every accent's ink, plus the two inks themselves. */
const FACT_INKS: Record<ValueTone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
  ink: color.ink,
  dim: color.inkDim,
};

const AVATAR_TINTS: Record<ContactTone, string> = {
  teal: token("avatar-tint-teal"),
  blue: token("avatar-tint-blue"),
  purple: token("avatar-tint-purple"),
  amber: token("avatar-tint-amber"),
  neutral: token("avatar-tint-neutral"),
};

const AVATAR_BORDERS: Record<ContactTone, string> = {
  teal: token("avatar-border-teal"),
  blue: token("avatar-border-blue"),
  purple: token("avatar-border-purple"),
  amber: token("avatar-border-amber"),
  neutral: token("avatar-border-neutral"),
};

const FALLBACK_FACTS: ContactFact[] = [
  { k: "at", v: "Ithaca · the hall", tone: "teal" },
  { k: "last spoke", v: "20 years ago" },
  { k: "open threads", v: "2" },
];

export function ContactCard(p: ContactCardProps) {
  if (p.facts && !Array.isArray(p.facts)) warnOnce("ContactCard: `facts` is not an array; no facts will render.");
  if (p.actions && !Array.isArray(p.actions)) warnOnce("ContactCard: `actions` is not an array; no actions will render.");

  const kind = p.kind || "person";
  const tone = p.tone || (kind === "company" ? "blue" : kind === "project" ? "purple" : "teal");
  const ink = INKS[tone] || INKS.teal;
  const label = p.label ?? "Penelope";
  const role = p.role ?? "Wife · holding Ithaca";
  const initials =
    p.initials ||
    label
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  const facts = p.facts || FALLBACK_FACTS;
  const keyFloor = typeof p.keyWidth === "number" && Number.isFinite(p.keyWidth) && p.keyWidth > 0
    ? p.keyWidth : 84;
  // 288px card - 26px border/padding - 10px gutter - 160px value track.
  const keyCap = Math.max(92, keyFloor);
  // `actions` is genuinely optional: an entity card with nothing to do about it
  // is a normal card, so an absent or empty list renders no row at all.
  const actions = p.actions && p.actions.length ? p.actions : null;

  const box: CSSProperties = {
    border: `1px solid ${color.line}`,
    background: color.surface,
    borderRadius: 14,
    padding: 12,
    boxSizing: "border-box",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 11,
  };
  const avatar: CSSProperties = {
    width: 38,
    height: 38,
    // A person is a circle; anything else is a rounded square.
    borderRadius: kind === "person" ? "50%" : 11,
    flex: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: AVATAR_TINTS[tone] || AVATAR_TINTS.teal,
    border: `1px solid ${AVATAR_BORDERS[tone] || AVATAR_BORDERS.teal}`,
    font: `600 12.5px/1 ${font.body}`,
    color: ink,
  };
  return (
    <div style={box}>
      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        <span style={avatar}>{initials}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b style={{ display: "block", font: `600 13.5px/1.3 ${font.body}`, color: color.ink }}>
            {label}
          </b>
          <span
            style={{
              display: "block",
              marginTop: 2,
              font: `400 11px/1.4 ${font.body}`,
              color: accent.neutral.ink,
            }}
          >
            {kind !== "person" ? (
              <span
                data-kind={kind}
                style={{
                  font: `600 9px/1.2 ${font.mono}`,
                  letterSpacing: ".07em",
                  textTransform: "uppercase",
                  color: accent.neutral.ink,
                  marginRight: 4,
                }}
              >
                {kind}
                {role ? " ·" : null}
              </span>
            ) : null}
            {role}
          </span>
        </div>
        {p.badge ? <Chip label={p.badge} tone={tone} variant="soft" /> : null}
      </div>
      {facts.length ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `minmax(${keyFloor}px, max-content) minmax(0, 1fr)`,
            gap: "5px 10px",
            font: `500 10.5px/1.5 ${font.mono}`,
            paddingTop: 10,
            borderTop: `1px solid ${color.line}`,
          }}
        >
          {facts.map((f, i) => {
            // An untoned fact is dim ink; an unlisted tone falls back to the
            // same rather than inheriting.
            const factTone = f.tone || "dim";
            const cue = VALUE_CUE[factTone];
            return (
              <div key={i} style={{ display: "contents" }}>
                <span
                  style={{ maxWidth: keyCap, minWidth: 0, overflowWrap: "anywhere", color: accent.neutral.ink }}
                >
                  {f.k.split(/(?<=[_\-./])/).map((part, index) => (
                    <Fragment key={index}>{part}<wbr /></Fragment>
                  ))}
                </span>
                <span
                  data-tone={factTone}
                  style={{
                    minWidth: 0,
                    overflowWrap: "anywhere",
                    color: FACT_INKS[factTone] || FACT_INKS.dim,
                    fontWeight: 500,
                  }}
                >
                  {cue ? <Cue icon={cue} size={11} inline /> : null}
                  {f.v}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {actions ? (
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          {actions.map((a, i) => (
            <Button
              key={i}
              label={a.label}
              icon={a.icon}
              tone={a.tone}
              size="sm"
              block={false}
              onClick={a.onClick}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
