import type { CSSProperties } from "react";

import { Button } from "../primitives/Button.js";
import { Chip } from "../primitives/Chip.js";
import { Icon } from "../primitives/Icon.js";
import { ChoiceOption } from "../rows/ChoiceOption.js";
import { accent, color, font, token } from "../tokens.js";

/**
 * The inline "Brain needs your input" card.
 *
 * Teal throughout by default: the agent has stopped and the next move is the
 * user's. The same component serves chat inline UI, share intake and Choose
 * actions — only the option list and the button labels change.
 *
 * **It renders the `radiogroup` its options need.** `ChoiceOption` is a `radio`
 * and a radio outside a group is invalid ARIA with no announced set size or
 * position; this is the group. `aria-labelledby` points at the question, so the
 * group is announced by what it is asking. The group appears only when the
 * options are interactive — a list of options with no callbacks is a record of
 * a choice already made, and reads as one.
 *
 * No interaction states of its own. It is a container; the things inside it are
 * the controls, and each brings its own.
 */
export interface AskUserOption {
  title: string;
  subtitle?: string;
  selected?: boolean;
  mono?: boolean;
  italic?: boolean;
  dim?: boolean;
  onClick?: () => void;
}

export interface AskUserCardProps {
  /** The uppercase mono line above the question. */
  prompt?: string;
  question?: string;
  /** A soft caps chip between the prompt and the question. */
  tag?: string;
  tone?: "teal" | "amber" | "purple";
  options?: AskUserOption[];
  showActions?: boolean;
  primaryLabel?: string;
  secondaryLabel?: string;
  onPrimary?: () => void;
  onSecondary?: () => void;
  /** Distinguishes two cards on one screen for the `aria-labelledby` wiring. */
  id?: string;
}

const BORDERS = {
  teal: token("ask-border-teal"),
  amber: token("ask-border-amber"),
  purple: token("ask-border-purple"),
};

const HEADS = {
  teal: token("ask-head-teal"),
  amber: token("ask-head-amber"),
  purple: token("ask-head-purple"),
};

const ACCENTS = { teal: accent.teal.ink, amber: accent.amber.ink, purple: accent.purple.ink };

const FALLBACK: AskUserOption[] = [
  {
    title: "life/health/appointments.md",
    subtitle: "Appends to the running list. 2 similar notes went here.",
    selected: true,
    mono: false,
  },
  { title: "calendar only, drop the note", subtitle: "Nothing to keep once it happened.", mono: false },
  { title: "Other", subtitle: "Provide a custom answer.", mono: false, italic: true, dim: true },
];

export function AskUserCard(p: AskUserCardProps) {
  const tone = p.tone || "teal";
  const hue = ACCENTS[tone] || ACCENTS.teal;
  const options = p.options || FALLBACK;
  const interactive = options.some((o) => Boolean(o.onClick));
  const questionId = `${p.id ?? "ask"}-question`;

  const box: CSSProperties = {
    border: `1px solid ${BORDERS[tone] || BORDERS.teal}`,
    background: color.surface,
    borderRadius: 14,
    padding: "13px 13px 12px",
    boxSizing: "border-box",
    width: "100%",
  };
  const head: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 11,
    font: `500 10px/1 ${font.mono}`,
    letterSpacing: ".08em",
    textTransform: "uppercase",
    // The one foreground in the kit that comes from alpha — the accent at 85%.
    // The design's value, flagged for the a11y wave rather than quietly fixed.
    color: HEADS[tone] || HEADS.teal,
  };
  const tagWrap: CSSProperties = { display: "inline-flex", marginBottom: 8 };
  // No colour: the question inherits ink from the screen, as the source does.
  const questionStyle: CSSProperties = { font: `400 13px/1.55 ${font.body}`, margin: "0 0 10px" };
  const optionsWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 7 };
  const actions: CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 };

  return (
    <div style={box}>
      <div style={head}>
        <Icon icon="ask" size={13} color={hue} />
        {p.prompt ?? "Brain needs your input"}
      </div>
      {p.tag ? (
        <span style={tagWrap}>
          <Chip label={p.tag} tone={tone} variant="soft" caps />
        </span>
      ) : null}
      <div id={questionId} style={questionStyle}>
        {p.question ?? "Where should “dentist moved to Thursday” live?"}
      </div>
      <div
        style={optionsWrap}
        role={interactive ? "radiogroup" : undefined}
        aria-labelledby={interactive ? questionId : undefined}
      >
        {options.map((o, i) => (
          <ChoiceOption
            key={`${o.title}-${i}`}
            title={o.title}
            subtitle={o.subtitle}
            selected={o.selected}
            mono={o.mono}
            italic={o.italic}
            dim={o.dim}
            onClick={o.onClick}
          />
        ))}
      </div>
      {p.showActions !== false ? (
        <div style={actions}>
          <Button
            label={p.secondaryLabel || "Dismiss"}
            tone="quiet"
            size="sm"
            block={false}
            onClick={p.onSecondary}
          />
          <Button label={p.primaryLabel || "Submit"} tone="affirm" size="sm" block={false} onClick={p.onPrimary} />
        </div>
      ) : null}
    </div>
  );
}
