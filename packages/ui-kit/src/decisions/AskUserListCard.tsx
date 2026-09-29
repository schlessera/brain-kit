import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

import { edgeFor } from "../internal/roving.js";
import { classifyLink, refusalSentence } from "../links.js";
import { Button } from "../primitives/Button.js";
import { Icon } from "../primitives/Icon.js";
import { InlineToast } from "../conversation/InlineToast.js";
import { accent, color, font, token } from "../tokens.js";

/**
 * One scale over many items, answered in one card — the `ask_user_list`
 * exchange (#583, spec on the issue).
 *
 * `AskUserCard`'s lesson applied to rows: **one exchange gets one header, one
 * scale, one action row and one record.** Rows are the only thing that
 * repeats, and a row is one line of text plus one line of choices.
 *
 * **The per-row control is inline chips in a fixed grid**, at every scale size
 * from 2 to 8. Speed comes from position: once "not seen" sits in the same
 * spot on every row the thumb stops reading, so the grid's columns are the same
 * on every row of a card. At a narrow card 2–4 options take one row, 5–6 take
 * two rows of three and 7–8 two rows of four, always balanced. From a 560px
 * card up to six options sit beside the label and seven or eight under it. The
 * grid is `tokens.css`'s `.bk-asklist-*` rules, because the switch is a
 * container query and an inline style cannot hold one. A chip is 44px tall
 * and at least 60px wide, so it needs no reach past its paint (D34), and its
 * hairline is an inset shadow, never a border. A label that does not fit
 * wraps inside its chip; it is never abbreviated.
 *
 * **The chosen answer shows in the chip**: accent fill, `on-fill` ink and a
 * leading ✓, so it reads without colour. The row's gutter agrees: its index
 * becomes ✓ once answered and ! when flagged.
 *
 * **Submit is never a silent no-op** (#541). Its label says what a tap does —
 * `Submit 10`, `Submit 4 · skip 6`, or, when skipping is off and rows are
 * open, `6 left to answer`. That last one is `aria-disabled` but still
 * focusable and tappable: a tap flags every open row, moves focus to the first,
 * and says so through the live region. A flag clears as soon as its row is
 * answered.
 *
 * **"Set the other N to …" fills only open rows** and never overwrites a chosen
 * answer or a note. The fill is a receipt with Undo (D38 §4).
 *
 * **Keyboard (D36).** Each row is a `radiogroup` with one tab stop and ←→ /
 * Home / End inside it. While a row holds focus, `1`–`8` pick an option, `0`
 * or Backspace clear the row, `j` / `k` move rows and `n` opens its note — only
 * while `singleKeys` is on, which is the Settings switch's to decide. A pick by
 * key hands focus to the next open row; a pick by pointer moves nothing. The
 * digits and the footer hint print only under a fine pointer (D36 addendum).
 *
 * **The answered record is grouped by option, in scale order**, with empty
 * options left out and skipped items last. Above twelve items each group is
 * a disclosure row under one count line, so thirty answers do not dominate
 * the transcript. Nothing fades, in any state.
 *
 * The pending card keeps its own working state: which chip is picked, which
 * rows are flagged, which notes are open. That is the card's job, the same way
 * a text field keeps its caret. What leaves the card is `onSubmit`, once, with
 * the answers keyed by item id — a skipped item is absent, never `""`.
 */
export interface AskUserListOption {
  label: string;
  description?: string;
}

export interface AskUserListItem {
  id: string;
  label: string;
  detail?: string;
  link?: string;
}

export type AskUserListState = "pending" | "answered" | "dismissed";

export interface AskUserListSubmission {
  answers: Record<string, string>;
  notes: Record<string, string>;
}

export interface AskUserListCardProps {
  state?: AskUserListState;
  /** The uppercase line above the question. Defaults per state. */
  prompt?: string;
  question: string;
  scale: AskUserListOption[];
  items: AskUserListItem[];
  /** Submit may leave items open. Default true. */
  allowSkip?: boolean;
  /** Each row may carry a note. Default false. */
  notes?: boolean;
  /** What the items are, for the counters: "films". Default "items". */
  noun?: string;
  /** Answers already recorded (answered state), or picked (a pending story). */
  answers?: Record<string, string>;
  /** Notes already recorded, keyed by item id. */
  itemNotes?: Record<string, string>;
  /** Who and when, under the answered record. */
  answerMeta?: string;
  /** The lapsed row's note on a `dismissed` card. */
  lapsedNote?: string;
  /** "Ask again" on a `dismissed` card. No handler, no button (D20). */
  onAskAgain?: () => void;
  onSubmit?: (submission: AskUserListSubmission) => void;
  onDismiss?: () => void;
  /** Single-key shortcuts bind. The Settings switch; default on. */
  singleKeys?: boolean;
  /** Distinguishes two cards on one screen for the id wiring. */
  id?: string;
}

/** Above this many items the answered record collapses its groups. */
export const ASK_LIST_COLLAPSE_AT = 12;

/** How many chips sit in one grid row at a narrow card, for `n` options. */
export function narrowColumns(n: number): number {
  if (n <= 4) return n;
  if (n <= 6) return 3;
  return 4;
}

/** The Submit label for the state the card is in. */
export function submitLabel(answered: number, total: number, allowSkip: boolean): string {
  const open = total - answered;
  if (open === 0) return `Submit ${total}`;
  if (!allowSkip) return `${open} left to answer`;
  return answered === 0 ? `Submit · skip ${open}` : `Submit ${answered} · skip ${open}`;
}

/**
 * The fill: every open row set to `label`, every answered row kept. Pure, so
 * the one rule that matters — never overwrite a choice — is testable without
 * a DOM.
 */
export function fillOpen(
  items: readonly Pick<AskUserListItem, "id">[],
  answers: Readonly<Record<string, string>>,
  label: string
): Record<string, string> {
  const next: Record<string, string> = { ...answers };
  for (const item of items) if (!Object.hasOwn(next, item.id)) next[item.id] = label;
  return next;
}

/** The answered record's groups: one per option that got answers, in scale
 * order, then the skipped items. */
export function groupAnswers(
  scale: readonly AskUserListOption[],
  items: readonly AskUserListItem[],
  answers: Readonly<Record<string, string>>
): { label: string; items: AskUserListItem[]; skipped?: true }[] {
  const groups = scale
    .map((o) => ({ label: o.label, items: items.filter((i) => answers[i.id] === o.label) }))
    .filter((g) => g.items.length > 0);
  const skipped = items.filter((i) => !scale.some((o) => o.label === answers[i.id]));
  return skipped.length ? [...groups, { label: "skipped", items: skipped, skipped: true as const }] : groups;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function AskUserListCard(p: AskUserListCardProps) {
  const state: AskUserListState = p.state ?? "pending";
  if (state === "answered") return <Answered {...p} />;
  if (state === "dismissed") return <Dismissed {...p} />;
  return <Pending {...p} />;
}

// ---------------------------------------------------------------------------
// Shared frame
// ---------------------------------------------------------------------------

const box = (border: string): CSSProperties => ({
  border: `1px solid ${border}`,
  background: color.surface,
  borderRadius: 14,
  boxSizing: "border-box",
  width: "100%",
});

const headStyle = (hue: string): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 6,
  font: `500 10px/1 ${font.mono}`,
  letterSpacing: ".08em",
  textTransform: "uppercase",
  color: hue,
});

const questionStyle: CSSProperties = { font: `400 13px/1.55 ${font.body}`, margin: 0, minWidth: 0, flex: 1 };
const monoMeta: CSSProperties = { font: `400 10.5px/1.4 ${font.mono}`, color: color.inkMute };
const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/** The option descriptions, once, under the question — only when any exists. */
function Legend({ scale }: { scale: AskUserListOption[] }) {
  const described = scale.filter((o) => o.description);
  if (described.length === 0) return null;
  return (
    <p style={{ margin: "4px 0 0", font: `400 11px/1.5 ${font.body}`, color: color.inkDim }}>
      {described.map((o, i) => (
        <span key={o.label}>
          {i ? " · " : ""}
          <span style={{ fontWeight: 600 }}>{o.label}</span> — {o.description}
        </span>
      ))}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Pending
// ---------------------------------------------------------------------------

function Pending(p: AskUserListCardProps) {
  const uid = useId();
  const base = p.id ?? `asklist${uid.replace(/:/g, "")}`;
  const allowSkip = p.allowSkip !== false;
  const noun = p.noun ?? "items";
  const singleKeys = p.singleKeys !== false;
  const { items, scale } = p;

  const [answers, setAnswers] = useState<Record<string, string>>(() => ({ ...(p.answers ?? {}) }));
  const [notes, setNotes] = useState<Record<string, string>>(() => ({ ...(p.itemNotes ?? {}) }));
  const [openNotes, setOpenNotes] = useState<Set<string>>(() => new Set(Object.keys(p.itemNotes ?? {})));
  const [flagged, setFlagged] = useState<Set<string>>(() => new Set());
  const [fillOpenPanel, setFillOpenPanel] = useState(false);
  const [receipt, setReceipt] = useState<{ count: number; label: string; before: Record<string, string> } | null>(null);
  const [live, setLive] = useState("");
  // Where focus goes once React has committed the change that moved it: a
  // row's stop is computed from the new answers, so it cannot be read before.
  const [focusTarget, setFocusTarget] = useState<{ row?: string; note?: string; submit?: true } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const answered = items.filter((i) => Object.hasOwn(answers, i.id)).length;
  const open = items.length - answered;
  const blocked = !allowSkip && open > 0;
  const single = items.length === 1;

  function rowEl(id: string): HTMLElement | null {
    return rootRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`) ?? null;
  }

  useEffect(() => {
    if (!focusTarget) return;
    setFocusTarget(null);
    if (focusTarget.submit) {
      const buttons = rootRef.current?.querySelectorAll<HTMLElement>('[data-submit] [role="button"]');
      buttons?.[buttons.length - 1]?.focus();
    } else if (focusTarget.note) {
      rowEl(focusTarget.note)?.querySelector<HTMLInputElement>("input")?.focus();
    } else if (focusTarget.row) {
      rowEl(focusTarget.row)?.scrollIntoView?.({ block: "nearest" });
      focusRow(focusTarget.row);
    }
  }, [focusTarget]);

  function focusRow(id: string) {
    const row = rowEl(id);
    const stop =
      row?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') ??
      row?.querySelector<HTMLElement>('[role="radio"]');
    stop?.focus();
  }

  function pick(id: string, label: string | null) {
    setAnswers((prev) => {
      const next = { ...prev };
      if (label === null || next[id] === label) delete next[id];
      else next[id] = label;
      return next;
    });
    if (label !== null) {
      setFlagged((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  /** After a keyboard pick: the next open row, else Submit. */
  function advanceFrom(id: string, justPicked: string) {
    const index = items.findIndex((i) => i.id === id);
    const isOpen = (i: AskUserListItem) => i.id !== justPicked && !Object.hasOwn(answers, i.id);
    const next = items.slice(index + 1).find(isOpen) ?? items.slice(0, index).find(isOpen);
    setFocusTarget(next ? { row: next.id } : { submit: true });
  }

  function fill(label: string) {
    const before = answers;
    const after = fillOpen(items, answers, label);
    const count = items.length - answered;
    setAnswers(after);
    setFlagged(new Set());
    setFillOpenPanel(false);
    setReceipt({ count, label, before });
    setLive(`${count} ${noun} set to ${label}.`);
  }

  function undoFill() {
    if (!receipt) return;
    setAnswers(receipt.before);
    setReceipt(null);
    setLive("Fill undone.");
  }

  function submit() {
    if (blocked) {
      const missing = items.filter((i) => !Object.hasOwn(answers, i.id));
      setFlagged(new Set(missing.map((i) => i.id)));
      const first = missing[0]!;
      setLive(`${missing.length} ${noun} still need an answer. Moved to ${first.label}.`);
      setFocusTarget({ row: first.id });
      return;
    }
    const kept: Record<string, string> = {};
    for (const item of items) {
      const note = notes[item.id]?.trim();
      if (p.notes && note) kept[item.id] = note;
    }
    const chosen: Record<string, string> = {};
    for (const item of items) if (Object.hasOwn(answers, item.id)) chosen[item.id] = answers[item.id]!;
    p.onSubmit?.({ answers: chosen, notes: kept });
  }

  function onRowKey(event: KeyboardEvent<HTMLDivElement>, item: AskUserListItem, index: number) {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    const radios = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
    const here = radios.indexOf(target);
    const edge = edgeFor(event.key);
    if (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "ArrowUp" || edge) {
      if (here === -1) return;
      event.preventDefault();
      const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      const to = edge === "first" ? 0 : edge === "last" ? radios.length - 1 : (here + delta + radios.length) % radios.length;
      radios[to]!.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      if (here === -1) return;
      event.preventDefault();
      pick(item.id, scale[here]!.label);
      return;
    }
    if (!singleKeys || event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^[1-8]$/.test(event.key)) {
      const option = scale[Number(event.key) - 1];
      if (!option) return;
      event.preventDefault();
      pick(item.id, option.label);
      advanceFrom(item.id, item.id);
    } else if (event.key === "0" || event.key === "Backspace") {
      event.preventDefault();
      pick(item.id, null);
    } else if (event.key === "j" || event.key === "k") {
      const next = items[index + (event.key === "j" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      focusRow(next.id);
    } else if (event.key === "n" && p.notes) {
      event.preventDefault();
      setOpenNotes((prev) => new Set(prev).add(item.id));
      setFocusTarget({ note: item.id });
    }
  }

  // A fill's receipt belongs to that fill: a later pick makes Undo a lie
  // about what it would restore, so any change to answers after it retires it.
  const receiptAnswers = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    if (!receipt) {
      receiptAnswers.current = null;
      return;
    }
    if (receiptAnswers.current === null) receiptAnswers.current = answers;
    else if (receiptAnswers.current !== answers) setReceipt(null);
  }, [answers, receipt]);

  const flaggedCount = flagged.size;
  const counter = flaggedCount
    ? `${flaggedCount} need${flaggedCount === 1 ? "s" : ""} an answer`
    : `${answered} of ${items.length}`;
  const fillLabel = answered === 0 ? `Set all ${items.length} to …` : `Set the other ${open} to …`;
  const hint = `1–${scale.length} rate · j k move`;

  const sticky: CSSProperties = {
    position: "sticky",
    zIndex: 1,
    background: color.surface,
    padding: "12px 13px",
  };

  return (
    <div
      ref={rootRef}
      style={box(token("ask-border-teal"))}
      className="bk-asklist"
      data-cols={narrowColumns(scale.length)}
      data-count={scale.length}
      role="group"
      aria-labelledby={`${base}-q`}
    >
      <div
        style={{ ...sticky, top: 0, borderRadius: "14px 14px 0 0", borderBottom: `1px solid ${color.line}` }}
        data-list-head=""
      >
        <div style={headStyle(accent.teal.ink)}>
          <Icon icon="ask" size={13} color={accent.teal.ink} />
          {p.prompt ?? "Brain needs your input"}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 10 }}>
          <p id={`${base}-q`} style={questionStyle}>
            {p.question}
          </p>
          {single ? null : (
            <span
              data-counter=""
              style={{ ...monoMeta, flex: "none", color: flaggedCount ? accent.red.ink : color.inkMute }}
            >
              {counter}
            </span>
          )}
        </div>
        <Legend scale={scale} />
        {!single && open >= 2 ? (
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="bk-asklist-text"
              aria-expanded={fillOpenPanel}
              aria-controls={`${base}-fill`}
              aria-label={answered === 0 ? `Set all ${items.length} ${noun} to…` : `Set the ${open} unanswered ${noun} to…`}
              onClick={() => setFillOpenPanel((v) => !v)}
            >
              {fillLabel}
            </button>
            {fillOpenPanel ? (
              <div id={`${base}-fill`} style={{ marginTop: 8 }}>
                <div className="bk-asklist-chips" role="group" aria-label={`Set ${open} to`}>
                  {scale.map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      className="bk-asklist-chip"
                      aria-label={`Set ${open} to ${o.label}`}
                      onClick={() => fill(o.label)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <p style={{ ...monoMeta, margin: "6px 0 0" }}>Rows you have already answered are kept.</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div style={{ padding: "4px 13px" }}>
        {items.map((item, index) => (
          <Row
            key={item.id}
            base={base}
            item={item}
            index={index}
            scale={scale}
            chosen={answers[item.id]}
            flagged={flagged.has(item.id)}
            notesOn={p.notes === true}
            note={notes[item.id] ?? ""}
            noteOpen={openNotes.has(item.id)}
            onPick={(label) => pick(item.id, label)}
            onOpenNote={() => {
              setOpenNotes((prev) => new Set(prev).add(item.id));
              setFocusTarget({ note: item.id });
            }}
            onNote={(text) => setNotes((prev) => ({ ...prev, [item.id]: text }))}
            onCloseNote={() => {
              if (!(notes[item.id] ?? "").trim()) {
                setOpenNotes((prev) => {
                  const next = new Set(prev);
                  next.delete(item.id);
                  return next;
                });
              }
            }}
            onEscapeNote={() => focusRow(item.id)}
            onKeyDown={(event) => onRowKey(event, item, index)}
          />
        ))}
      </div>

      <div
        style={{
          ...sticky,
          bottom: 0,
          borderRadius: "0 0 14px 14px",
          borderTop: `1px solid ${color.line}`,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
        data-list-foot=""
      >
        {receipt ? (
          <InlineToast
            text={`${receipt.count} set`}
            target={`to ${receipt.label}`}
            tone="teal"
            icon="confirm"
            onUndo={undoFill}
          />
        ) : null}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {singleKeys ? (
            <span className="bk-asklist-key" style={{ ...monoMeta, flex: 1, minWidth: 0 }} aria-hidden="true">
              {hint}
            </span>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginLeft: "auto" }} data-submit="">
            <Button label="Dismiss" tone="quiet" size="sm" block={false} onClick={p.onDismiss} />
            <Button
              label={submitLabel(answered, items.length, allowSkip)}
              tone={blocked ? "quiet" : "affirm"}
              size="sm"
              block={false}
              ariaDisabled={blocked}
              onClick={submit}
            />
          </div>
        </div>
      </div>
      <div aria-live="polite" style={srOnly} data-live="">
        {live}
      </div>
    </div>
  );
}

function Row(r: {
  base: string;
  item: AskUserListItem;
  index: number;
  scale: AskUserListOption[];
  chosen: string | undefined;
  flagged: boolean;
  notesOn: boolean;
  note: string;
  noteOpen: boolean;
  onPick: (label: string) => void;
  onOpenNote: () => void;
  onNote: (text: string) => void;
  onCloseNote: () => void;
  onEscapeNote: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const { item, scale, chosen, flagged } = r;
  const [focused, setFocused] = useState<number | null>(null);
  const selectedIndex = scale.findIndex((o) => o.label === chosen);
  const stop = focused ?? (selectedIndex >= 0 ? selectedIndex : 0);
  const labelId = `${r.base}-l-${r.index}`;
  const detailId = `${r.base}-d-${r.index}`;
  const flagId = `${r.base}-f-${r.index}`;
  const verdict = item.link ? classifyLink(item.link) : null;

  const gutter: CSSProperties = {
    font: `500 10.5px/1.6 ${font.mono}`,
    color: flagged ? accent.red.ink : chosen ? accent.teal.ink : color.inkMute,
    textAlign: "left",
  };

  return (
    <div className="bk-asklist-row" data-row={item.id} data-flagged={flagged ? "" : undefined}>
      <span style={gutter} aria-hidden="true">
        {flagged ? "!" : chosen ? "✓" : pad2(r.index + 1)}
      </span>
      <div className="bk-asklist-text-col" style={{ minWidth: 0 }}>
        <div id={labelId} style={{ font: `600 13px/1.45 ${font.body}`, color: color.ink, overflowWrap: "anywhere" }}>
          {item.label}
        </div>
        {item.detail || verdict || r.notesOn ? (
          <div
            id={detailId}
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "baseline",
              columnGap: 8,
              font: `400 11px/1.5 ${font.body}`,
              color: color.inkMute,
            }}
          >
            {item.detail ? <span style={{ overflowWrap: "anywhere" }}>{item.detail}</span> : null}
            {verdict?.ok ? (
              <a
                href={verdict.href}
                target="_blank"
                rel="noopener noreferrer"
                className="bk-asklist-link"
                aria-label={`${item.label} on ${verdict.host} (${verdict.host}), new tab`}
                style={{ font: `400 10.5px/1.5 ${font.mono}`, color: color.inkMute }}
              >
                {verdict.hostUnicode ?? verdict.host}
              </a>
            ) : verdict ? (
              <span style={{ font: `400 10.5px/1.5 ${font.mono}` }}>[link withheld — {refusalSentence(verdict)}]</span>
            ) : null}
            {r.notesOn && !r.noteOpen ? (
              <button
                type="button"
                className="bk-asklist-text"
                aria-label={`${r.note ? "Edit" : "Add"} note, ${item.label}`}
                onClick={r.onOpenNote}
              >
                {r.note ? "✎ note" : "+ note"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div
        className="bk-asklist-chips"
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={[item.detail ? detailId : "", flagged ? flagId : ""].filter(Boolean).join(" ") || undefined}
        aria-invalid={flagged ? true : undefined}
        onKeyDown={r.onKeyDown}
      >
        {scale.map((o, i) => {
          const on = chosen === o.label;
          return (
            <div
              key={o.label}
              role="radio"
              aria-checked={on}
              aria-label={`${o.label}, ${item.label}`}
              tabIndex={i === stop ? 0 : -1}
              className="bk-asklist-chip"
              data-on={on ? "" : undefined}
              onFocus={() => setFocused(i)}
              onClick={() => r.onPick(o.label)}
            >
              <span className="bk-asklist-key bk-asklist-digit" aria-hidden="true">
                {i + 1}
              </span>
              {on ? "✓ " : ""}
              {o.label}
            </div>
          );
        })}
      </div>
      {r.notesOn && r.noteOpen ? (
        <div className="bk-asklist-note bk-field">
          <input
            type="text"
            maxLength={280}
            value={r.note}
            aria-label={`Note on ${item.label}`}
            placeholder="A short note…"
            onChange={(event) => r.onNote(event.currentTarget.value)}
            onBlur={r.onCloseNote}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                r.onEscapeNote();
              }
            }}
          />
        </div>
      ) : null}
      {flagged ? (
        <span id={flagId} className="bk-asklist-flag" style={{ font: `400 10.5px/1.4 ${font.mono}`, color: accent.red.ink }}>
          needs an answer
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Answered
// ---------------------------------------------------------------------------

function Answered(p: AskUserListCardProps) {
  const answers = p.answers ?? {};
  const notes = p.itemNotes ?? {};
  const groups = groupAnswers(p.scale, p.items, answers);
  const collapse = p.items.length > ASK_LIST_COLLAPSE_AT;
  const rated = p.items.length - (groups.find((g) => g.skipped)?.items.length ?? 0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const well: CSSProperties = {
    marginTop: 10,
    background: token("inset-well-bg"),
    border: `1px solid ${token("ask-answer-border-teal")}`,
    borderRadius: 11,
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  };

  const names = (items: AskUserListItem[]) =>
    items.map((item, i) => (
      <span key={item.id}>
        {i ? " · " : ""}
        {item.label}
        {notes[item.id] ? (
          <span style={{ fontStyle: "italic", color: color.inkDim }}> — “{notes[item.id]}”</span>
        ) : null}
      </span>
    ));

  return (
    <div style={{ ...box(token("ask-border-teal")), padding: "13px 13px 12px" }} data-state="answered">
      <div style={headStyle(accent.teal.ink)}>
        <Icon icon="resolved" size={13} color={accent.teal.ink} />
        {p.prompt ?? `Answered · ${rated} of ${p.items.length}`}
      </div>
      <p style={{ ...questionStyle, marginTop: 10 }}>{p.question}</p>
      {collapse ? (
        <p style={{ ...monoMeta, margin: "8px 0 0" }} data-count-line="">
          {groups.map((g) => `${g.label} ${g.items.length}`).join(" · ")}
        </p>
      ) : null}
      <div style={well}>
        {groups.map((g) => {
          const labelCol: CSSProperties = {
            font: `500 11.5px/1.45 ${font.mono}`,
            color: g.skipped ? color.inkMute : accent.teal.ink,
            overflowWrap: "anywhere",
          };
          const namesStyle: CSSProperties = {
            font: `400 12px/1.45 ${font.body}`,
            color: color.ink,
            overflowWrap: "anywhere",
            minWidth: 0,
          };
          const heading = `${g.label} (${g.items.length})`;
          if (!collapse) {
            return (
              <div key={g.label} className="bk-asklist-group" data-group={g.label}>
                <span style={labelCol}>{heading}</span>
                <span style={namesStyle}>{names(g.items)}</span>
              </div>
            );
          }
          const isOpen = expanded.has(g.label);
          return (
            <div key={g.label} data-group={g.label}>
              <button
                type="button"
                className="bk-asklist-group bk-asklist-disclosure"
                aria-expanded={isOpen}
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.label)) next.delete(g.label);
                    else next.add(g.label);
                    return next;
                  })
                }
              >
                <span style={labelCol}>
                  {isOpen ? "▾" : "▸"} {heading}
                </span>
                {isOpen ? null : (
                  <span style={{ ...namesStyle, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {g.items[0]!.label}
                    {g.items.length > 1 ? ` +${g.items.length - 1}` : ""}
                  </span>
                )}
              </button>
              {isOpen ? (
                <ul style={{ margin: "4px 0 2px", padding: 0, listStyle: "none", ...namesStyle }}>
                  {g.items.map((item) => (
                    <li key={item.id}>
                      {item.label}
                      {notes[item.id] ? (
                        <span style={{ fontStyle: "italic", color: color.inkDim }}> — “{notes[item.id]}”</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
        <span style={{ font: `400 9.5px/1.4 ${font.mono}`, color: color.inkMute }}>
          {p.answerMeta ?? `you answered ${rated}`}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dismissed
// ---------------------------------------------------------------------------

function Dismissed(p: AskUserListCardProps) {
  return (
    <div style={{ ...box(token("ask-border-gold")), padding: "13px 13px 12px" }} data-state="dismissed">
      <div style={headStyle(accent.gold.ink)}>
        <Icon icon="later" size={13} color={accent.gold.ink} />
        {p.prompt ?? "Unanswered — the turn ended"}
      </div>
      <p style={{ ...questionStyle, margin: "10px 0" }}>{p.question}</p>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          background: token("ask-lapsed-tint"),
          border: `1px solid ${token("ask-lapsed-border")}`,
          borderRadius: 11,
          padding: "9px 10px 9px 12px",
        }}
      >
        <Icon icon="later" size={13} color={accent.gold.ink} />
        <span style={{ flex: 1, minWidth: 0, font: `400 11px/1.5 ${font.mono}`, color: color.inkDim, overflowWrap: "anywhere" }}>
          {p.lapsedNote ?? `${p.items.length} ${p.noun ?? "items"} · dismissed`}
        </span>
        {p.onAskAgain ? <Button label="Ask again" tone="quiet" size="sm" block={false} onClick={p.onAskAgain} /> : null}
      </div>
    </div>
  );
}
