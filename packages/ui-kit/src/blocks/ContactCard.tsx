import type { CSSProperties } from "react";

import { warnOnce } from "../internal/dev.js";
import { Button } from "../primitives/Button.js";
import { Chip } from "../primitives/Chip.js";
import type { IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { ButtonTone, ContactKind, ContactTone } from "../types.js";

/**
 * An entity the corpus knows about — a person, a company, a project — surfaced
 * inside an answer.
 *
 * Colour follows the entity language: teal person, blue company, purple
 * project. Facts are things the corpus can PROVE (last contact, open threads),
 * never enrichment fetched from the web, which is why they are mono and
 * key-aligned rather than prose.
 *
 * The tone union is the component's own five, not `Tone`. Its fact colours
 * have no fallback in the source, so a `gold` fact renders with no colour at
 * all — a value the component silently discards, which is what the narrowing
 * exists to make impossible.
 */
export interface ContactFact {
  k: string;
  v: string;
  tone?: ContactTone;
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
  keyWidth?: number;
}

const INKS: Record<ContactTone, string> = {
  teal: accent.teal.ink,
  blue: accent.blue.ink,
  purple: accent.purple.ink,
  amber: accent.amber.ink,
  neutral: accent.neutral.ink,
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
  const initials =
    p.initials ||
    label
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  const facts = p.facts || FALLBACK_FACTS;
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
  const factRow: CSSProperties = { display: "flex", gap: 10, font: `500 10.5px/1.5 ${font.mono}` };

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
            {p.role ?? "Wife · holding Ithaca"}
          </span>
        </div>
        {p.badge ? <Chip label={p.badge} tone={tone} variant="soft" /> : null}
      </div>
      {facts.length ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 5,
            paddingTop: 10,
            borderTop: `1px solid ${color.line}`,
          }}
        >
          {facts.map((f, i) => (
            <div key={i} style={factRow}>
              <span
                style={{ width: Number(p.keyWidth) || 84, flex: "none", color: accent.neutral.ink }}
              >
                {f.k}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  // No fallback: an untoned fact is dim ink, and a toned one is
                  // its accent. Both are the source's.
                  color: f.tone ? INKS[f.tone] : color.inkDim,
                  fontWeight: 500,
                }}
              >
                {f.v}
              </span>
            </div>
          ))}
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
