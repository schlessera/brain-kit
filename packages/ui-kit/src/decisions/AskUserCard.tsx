import type { CSSProperties, KeyboardEvent } from "react";

import { useRoving } from "../internal/roving.js";
import { Button } from "../primitives/Button.js";
import { Chip } from "../primitives/Chip.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { ChoiceOption } from "../rows/ChoiceOption.js";
import { accent, color, font, token } from "../tokens.js";

/**
 * The inline "Brain needs your input" card.
 *
 * Teal throughout by default: the agent has stopped and the next move is the
 * user's. The same component serves chat inline UI, share intake and Choose
 * actions — only the option list and the button labels change.
 *
 * **A question is an exchange, not a tool call**, so the card has three
 * states and all three stay in the transcript at full contrast. Nothing fades:
 * the kit bans opacity de-emphasis, and a past question is not lower-contrast,
 * it is answered.
 *
 *   - `pending` — options plus Submit / Dismiss. One focus stop; the question
 *     stays reachable.
 *   - `answered` — the chosen answer, checked and in the accent, with when. The
 *     options are GONE, not dimmed: the alternatives were never the record, the
 *     decision was. The card keeps its tinted border so the exchange is still
 *     findable by scanning colour.
 *   - `typed` — the user answered in the composer instead of picking. The agent
 *     binds that message to the question and the card says so, quoting what it
 *     took as the answer. Silently dropping the card would leave the transcript
 *     claiming the question was never answered; leaving it pending would ask
 *     twice. The border goes neutral: this exchange closed, but not through
 *     this card.
 *
 * **"Other" opens a real field in place of the Submit row** (`otherOpen`)
 * rather than a modal — a free-text answer is the same exchange, not a new
 * one. Enter in that field fires `onOtherSubmit` with the text; the field is
 * only ever drawn while pending, because a closed exchange takes no answer.
 *
 * **It renders the `radiogroup` its options need.** `ChoiceOption` is a `radio`
 * and a radio outside a group is invalid ARIA with no announced set size or
 * position; this is the group. `aria-labelledby` points at the question, so the
 * group is announced by what it is asking. The group appears only when the
 * options are interactive — a list of options with no callbacks is a record of
 * a choice already made, and reads as one.
 *
 * **It also owns the group's roving tabindex.** A `radiogroup` is one tab stop
 * with ↑↓ inside it, and `ChoiceOption` cannot decide which option holds that
 * stop because it cannot see its siblings — so the card computes it and passes
 * `tabStop`. The stop is the selected option, or the last one focused, or the
 * first interactive one when nothing is selected, which is the clause that
 * keeps an unanswered question reachable. {@link useRoving} carries the
 * reasoning.
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
  /** The option took focus (↑↓ or pointer): a consumer that previews the
   * focused option — the app's `ask_user` contract does — listens here. */
  onFocus?: () => void;
}

export type AskUserState = "pending" | "answered" | "typed";

export interface AskUserCardProps {
  /** Which turn of the exchange this is. See the note above. */
  state?: AskUserState;
  /** The uppercase mono line above the question. Defaults per state. */
  prompt?: string;
  question?: string;
  /** A soft caps chip between the prompt and the question. */
  tag?: string;
  tone?: "teal" | "amber" | "purple";
  options?: AskUserOption[];
  /** Draws the free-text field in place of the Submit row. Pending only. */
  otherOpen?: boolean;
  otherPlaceholder?: string;
  /** Enter in the "Other" field. */
  onOtherSubmit?: (text: string) => void;
  /** What was taken as the answer: the chosen option, or the quoted message. */
  answer?: string;
  /** Who and when, under the answer. */
  answerMeta?: string;
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

const ANSWER_BORDERS = {
  teal: token("ask-answer-border-teal"),
  amber: token("ask-answer-border-amber"),
  purple: token("ask-answer-border-purple"),
};

const ACCENTS = { teal: accent.teal.ink, amber: accent.amber.ink, purple: accent.purple.ink };

const HEAD_ICONS: Record<AskUserState, IconName> = { pending: "ask", answered: "resolved", typed: "thread" };

const PROMPTS: Record<AskUserState, string> = {
  pending: "Brain needs your input",
  answered: "Answered",
  typed: "Answered in the composer",
};

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
  const state: AskUserState = p.state || "pending";
  const pending = state === "pending";
  const answered = state === "answered";
  const typed = state === "typed";
  const tone = p.tone || "teal";
  const base = ACCENTS[tone] || ACCENTS.teal;
  // Typed goes neutral: the exchange closed, but not through this card.
  const hue = typed ? accent.neutral.ink : base;
  const options = p.options || FALLBACK;
  const eligible = options.map((o) => Boolean(o.onClick));
  const interactive = pending && eligible.includes(true);
  const questionId = `${p.id ?? "ask"}-question`;
  // `selected` is a per-option flag rather than an index, and a caller can set
  // it on none of them — which is the common case for a question nobody has
  // answered yet. `-1` then falls through to `useRoving`'s first-eligible rule.
  const roving = useRoving(eligible, options.findIndex((o) => o.selected === true));

  const otherOpen = pending && p.otherOpen === true;
  const answerText = answered || typed
    ? (p.answer ?? (answered ? "life/health/appointments.md" : "“put it with the other appointments”"))
    : null;
  const answerMeta = p.answerMeta ?? (typed ? "taken from your next message · 2m ago" : "you chose this · 2m ago");
  // The field stands IN PLACE OF the Submit row (the README's ruling; the
  // DC's renderVals draws both, the ruling wins): Enter is the submit.
  const showActions = pending && !otherOpen && p.showActions !== false;

  const box: CSSProperties = {
    border: `1px solid ${typed ? token("ask-border-neutral") : BORDERS[tone] || BORDERS.teal}`,
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
    color: hue,
  };
  const tagWrap: CSSProperties = { display: "inline-flex", marginBottom: 8 };
  // No colour: the question inherits ink from the screen, as the source does.
  const questionStyle: CSSProperties = { font: `400 13px/1.55 ${font.body}`, margin: "0 0 10px" };
  const optionsWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 7 };
  // The field is a well like the answer row, so the two read as the same
  // slot at different moments of the exchange. Its ring is `.bk-field`'s.
  const otherField: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
    background: token("inset-well-bg"),
    border: `1px solid ${color.edge}`,
    borderRadius: 11,
    padding: "10px 12px",
  };
  const otherInput: CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: "block",
    width: "100%",
    margin: 0,
    padding: 0,
    border: 0,
    background: "none",
    font: `400 12.5px/1.4 ${font.body}`,
    color: color.ink,
  };
  const otherHint: CSSProperties = {
    flex: "none",
    border: `1px solid ${color.edge}`,
    borderRadius: 5,
    padding: "2px 6px",
    font: `500 9.5px/1.4 ${font.mono}`,
    color: color.inkMute,
  };
  const answerRow: CSSProperties = {
    display: "flex",
    alignItems: "flex-start",
    gap: 9,
    background: token("inset-well-bg"),
    border: `1px solid ${typed ? color.edge : ANSWER_BORDERS[tone] || ANSWER_BORDERS.teal}`,
    borderRadius: 11,
    padding: "10px 12px",
  };
  const answerWrap: CSSProperties = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 };
  // A chosen option is a machine fact and sets in mono; a quoted message is
  // something a human wrote, so it is Jakarta in dim ink.
  const answerStyle: CSSProperties = typed
    ? { font: `400 12.5px/1.45 ${font.body}`, color: color.inkDim }
    : { font: `500 12px/1.4 ${font.mono}`, color: base };
  const answerMetaStyle: CSSProperties = { font: `400 9.5px/1.4 ${font.mono}`, color: color.inkMute };
  const actions: CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 };

  function onOtherKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    p.onOtherSubmit?.(event.currentTarget.value);
  }

  return (
    <div style={box}>
      <div style={head}>
        <Icon icon={HEAD_ICONS[state]} size={13} color={hue} />
        {p.prompt ?? PROMPTS[state]}
      </div>
      {p.tag ? (
        <span style={tagWrap}>
          <Chip label={p.tag} tone={tone} variant="soft" caps />
        </span>
      ) : null}
      <div id={questionId} style={questionStyle}>
        {p.question ?? "Where should “dentist moved to Thursday” live?"}
      </div>
      {pending ? (
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
              tabStop={interactive ? roving.stop === i : undefined}
              onClick={o.onClick}
              onFocus={
                o.onClick
                  ? () => {
                      roving.onItemFocus(i);
                      o.onFocus?.();
                    }
                  : undefined
              }
            />
          ))}
        </div>
      ) : null}
      {otherOpen ? (
        <div style={otherField} className="bk-field">
          <input
            className="bk-ask-other"
            style={otherInput}
            type="text"
            aria-label="Your own answer"
            placeholder={p.otherPlaceholder ?? "Type where it should go…"}
            onKeyDown={onOtherKeyDown}
          />
          <span style={otherHint} aria-hidden="true">⏎</span>
        </div>
      ) : null}
      {answerText ? (
        <div style={answerRow}>
          <Icon icon={typed ? "chat" : "confirm"} size={14} color={hue} />
          <span style={answerWrap}>
            <span style={answerStyle}>{answerText}</span>
            <span style={answerMetaStyle}>{answerMeta}</span>
          </span>
        </div>
      ) : null}
      {showActions ? (
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
