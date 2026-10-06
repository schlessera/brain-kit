import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, KeyboardEvent, MouseEvent, ReactElement } from "react";

import { SheetDialog } from "../internal/sheet-dialog.js";
import { edgeFor, focusEdge, focusSibling, useRoving } from "../internal/roving.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { ListRow } from "../rows/ListRow.js";
import { accent, color } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * The nine tracker states of D52 §4, in display order: the order IS urgency.
 * `unknown` and `cant-check` sit above `done` because they may be hiding work.
 */
export const WORKING_STATES = [
  "needs-you",
  "failed",
  "unconfirmed",
  "running",
  "queued",
  "unknown",
  "cant-check",
  "done",
  "cancelled",
] as const;
export type WorkingState = (typeof WORKING_STATES)[number];

/**
 * One working session, as the caller has already proven it.
 *
 * The kit derives nothing: the state, its proof and the order inside a state
 * (D52: newest `revision` first) are the caller's. Pass sessions in that
 * order; the strip only sorts them stably by state. The kit owns the
 * vocabulary instead (the printed word, the second line, the tone, the icon and
 * the accessible name), so every surface that draws a tracker prints the same
 * words for the same facts.
 *
 * Times are the host's `startedAt` / `endedAt`, in epoch milliseconds, and
 * nothing else. When one is null or absent, no age and no clock time is
 * printed: an unknown timestamp is never guessed.
 */
export interface WorkingSession {
  id: string;
  /** #1004's few-word label; the caller falls back to the session title or
   * the start of the prompt. It may truncate, because activating a pill or a
   * sheet row opens the session it names; the state word never does. */
  label: string;
  state: WorkingState;
  /** `needs-you`: what is pending, printed as the second line. */
  need?: "approval" | "question";
  /** `failed`: `failed` (default), `interrupted` or `timed out`.
   * `cancelled`: `cancelled` (default) or `denied`. Ignored otherwise. */
  outcome?: "failed" | "interrupted" | "timed out" | "cancelled" | "denied";
  /** `queued`: the host's queue note, printed verbatim as the second line.
   * Its presence is what makes the queue `busy`, in red. */
  queueNote?: string;
  /** `cant-check`: why the read could not answer. */
  reason?: "host unreachable" | "host too old" | "session not found";
  /** `running` prints its age from this. */
  startedAt?: number | null;
  /** `done` prints its age from this; `failed`, `done` and `cancelled` print
   * its clock time as the second line. */
  endedAt?: number | null;
  /** Open the session. The caller moves focus as D52 §4 rules on opening. */
  onOpen: () => void;
}

export interface WorkingSessionView {
  /** The printed state word: `running · 2m`, `queued · busy`, `interrupted`. */
  word: string;
  /** The second line, when the state has one. */
  detail?: string;
  tone: Tone;
  icon: IconName;
  /** `{label}, {state}{, second line}. Open session.` */
  name: string;
}

const STATE_LOOK: Record<WorkingState, { tone: Tone; icon: IconName; count: string }> = {
  "needs-you": { tone: "red", icon: "attention", count: "needs you" },
  failed: { tone: "red", icon: "stopped", count: "failed" },
  unconfirmed: { tone: "amber", icon: "unheard", count: "unconfirmed" },
  running: { tone: "amber", icon: "working", count: "running" },
  queued: { tone: "amber", icon: "later", count: "queued" },
  unknown: { tone: "neutral", icon: "unproven", count: "unknown" },
  "cant-check": { tone: "neutral", icon: "unreachable", count: "can't check" },
  done: { tone: "teal", icon: "finished", count: "done" },
  cancelled: { tone: "neutral", icon: "withdrawn", count: "cancelled" },
};

const TONE_INK: Record<Tone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
};

/** `HH:MM` on a 24-hour clock in the reader's zone, the design's `ended 09:41`. */
export function defaultWorkingClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** A compact age: `<1m`, `4m`, `2h`, `3d`. A clock that runs behind reads `<1m`. */
export function workingAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (!(minutes >= 1)) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** The strip's roving items: each pill's ListRow and each summary button. */
const ITEM = '[data-pill][role="button"], [data-strip-summary]';

const known = (t: number | null | undefined): t is number => typeof t === "number" && Number.isFinite(t);

/**
 * The words, tone, icon and accessible name for one session: D52 §4's table.
 * Exported so the ≥1280 Sessions pane's Working rows print exactly what the
 * strip and its sheet print.
 */
export function describeWorkingSession(
  s: WorkingSession,
  now: number,
  clock: (ms: number) => string = defaultWorkingClock,
): WorkingSessionView {
  const look = STATE_LOOK[s.state] ?? STATE_LOOK.unknown;
  let tone = look.tone;
  let word: string;
  let detail: string | undefined;
  switch (s.state) {
    case "needs-you":
      word = "needs you";
      detail = s.need;
      break;
    case "failed":
      word = s.outcome === "interrupted" || s.outcome === "timed out" ? s.outcome : "failed";
      if (known(s.endedAt)) detail = `ended ${clock(s.endedAt)}`;
      break;
    case "unconfirmed":
      word = "unconfirmed";
      detail = "didn't hear back";
      break;
    case "running":
      word = known(s.startedAt) ? `running · ${workingAge(now - s.startedAt)}` : "running";
      break;
    case "queued":
      if (s.queueNote) {
        word = "queued · busy";
        detail = s.queueNote;
        tone = "red";
      } else word = "queued";
      break;
    case "cant-check":
      word = "can't check";
      detail = s.reason;
      break;
    case "done":
      word = known(s.endedAt) ? `done · ${workingAge(now - s.endedAt)}` : "done";
      if (known(s.endedAt)) detail = `finished ${clock(s.endedAt)}`;
      break;
    case "cancelled":
      word = s.outcome === "denied" ? "denied" : "cancelled";
      if (known(s.endedAt)) detail = `ended ${clock(s.endedAt)}`;
      break;
    default:
      word = "unknown";
      detail = "host can't confirm the latest turn";
  }
  const spoken = word.split(" · ").join(", ");
  return { word, detail, tone, icon: look.icon, name: `${s.label}, ${spoken}${detail ? `, ${detail}` : ""}. Open session.` };
}

const rank = (s: WorkingSession) => {
  const i = WORKING_STATES.indexOf(s.state);
  return i === -1 ? WORKING_STATES.indexOf("unknown") : i;
};

/** Stable: within a state, the caller's order (newest revision first) stands. */
function byUrgency(sessions: readonly WorkingSession[]): WorkingSession[] {
  return sessions.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(({ s }) => s);
}

interface Count { state: WorkingState; n: number; text: string; tone: Tone }

function counts(sessions: readonly WorkingSession[]): Count[] {
  const out: Count[] = [];
  for (const state of WORKING_STATES) {
    const of = sessions.filter((s) => s.state === state);
    if (!of.length) continue;
    // A busy queue is red on the pill, so its count is red too.
    const tone = state === "queued" && of.some((s) => s.queueNote) ? "red" : STATE_LOOK[state].tone;
    out.push({ state, n: of.length, text: `${of.length} ${STATE_LOOK[state].count}`, tone });
  }
  return out;
}

export interface SessionStripProps {
  /** The tracked sessions; none draws nothing at all. */
  sessions: readonly WorkingSession[];
  /** The caller's clock, in epoch milliseconds, for the ages. */
  now: number;
  /** The composer is focused with the soft keyboard up: one 44px summary. */
  keyboardOpen?: boolean;
  /** Formats a host time as the second line's clock. Defaults to `HH:MM`. */
  formatClock?: (ms: number) => string;
}

interface OpenSheet {
  /** Where focus goes when the sheet is dismissed. */
  returnTo: HTMLElement | null;
  /** The composer's caret, when the keyboard-open summary opened the sheet. */
  selection: [number, number] | null;
  /** The nearest `data-theme` around the strip, for a subtree-themed embed. */
  theme?: string;
}

/**
 * Working sessions: the left half of the shared row above the composer
 * (D52 §3–4, #949). Presentational: the caller owns tracking, persistence,
 * announcements and what opening a session does.
 *
 * - **None** draws nothing, so the {@link ComposerRow} half stays empty.
 * - **One or two** draw one 44px pill each, 6px apart: 44 or 94px.
 * - **Three or more** draw the most urgent pill and a summary of the rest
 *   (`+2 more` over `1 needs you`, or `+2 more · 1 needs you · 1 done` in a
 *   wide half). The summary opens the `Working` sheet listing every session.
 *   94px is the cap at every count.
 * - **`keyboardOpen`** collapses the strip to one 44px summary,
 *   `● 3 working`, adding `· 1 needs you` where the half is 240px or wider.
 *   A 32px summary is the rejected alternative, not a smaller variant.
 *
 * **Keyboard.** The strip is one tab stop, `role="group"` named
 * `Working sessions`. ←→ / ↑↓ move inside it (wrapping), Home / End go to the
 * ends, and Enter or Space activates. Sessions not drawn as pills are not in
 * the tab order at all; the sheet is their route.
 *
 * **The sheet** follows the kit's modal rule (`ModelPicker`, the handoff
 * sheet): it moves focus to its first row, traps Tab, and closes on Esc or a
 * tap on the scrim. Dismissing returns focus to the summary that opened it.
 * From the keyboard-open summary it returns to the element that held focus
 * when it was pressed (the composer) with its caret restored; the press does
 * not move focus, so a caller that derives `keyboardOpen` from the composer's
 * focus cannot redraw the summary away before the click, and the click then
 * blurs the composer so the soft keyboard drops. If the focused row's session
 * leaves while the sheet is open, focus moves to a remaining row. Opening a
 * session from the sheet closes it and leaves focus to the caller, whose
 * focus rule for an opened session (D52 §4) applies. The sheet is portalled
 * to `<body>` and carries the strip's nearest `data-theme` with it.
 *
 * Nothing animates: there is no progress bar, no breathing and no transition,
 * because D22's one ambient animation is the filament.
 */
export function SessionStrip(p: SessionStripProps) {
  const sorted = byUrgency(p.sessions);
  const clock = p.formatClock ?? defaultWorkingClock;
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  const group = useRef<HTMLDivElement>(null);
  // Set by a dismissal, consumed once the sheet has unmounted, so the trap
  // cannot take focus back and the target is the element that is now drawn.
  const restore = useRef<OpenSheet | null>(null);
  useEffect(() => {
    const to = restore.current;
    if (sheet || !to) return;
    restore.current = null;
    const target = to.returnTo && to.returnTo.isConnected
      ? to.returnTo
      : group.current?.querySelector<HTMLElement>(`:is(${ITEM})[tabindex="0"]`) ?? null;
    target?.focus();
    if (target && to.selection && (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) {
      target.setSelectionRange(to.selection[0], to.selection[1]);
    }
  }, [sheet]);

  const mode = sorted.length === 0 ? "none" : p.keyboardOpen ? "keyboard" : sorted.length <= 2 ? "pills" : "overflow";
  const itemCount = mode === "none" ? 0 : mode === "keyboard" ? 1 : mode === "pills" ? sorted.length : 2;
  const roving = useRoving(Array.from({ length: itemCount }, () => true), 0);

  // The last session left while the sheet was open: nothing is left to list.
  // It closes as a dismissal does, so focus still goes back where it came from.
  const empty = sorted.length === 0;
  useEffect(() => {
    if (!empty || !sheet) return;
    restore.current = sheet;
    setSheet(null);
  }, [empty, sheet]);

  // Shift+Tab from the composer is meant to land on the keyboard summary. A
  // caller that derives `keyboardOpen` from the composer's focus redraws the
  // strip as the composer blurs, before focus arrives, so the summary is gone
  // and focus falls to <body>. A Tab pressed while the summary is drawn, then
  // a redraw that leaves focus on <body>, hands focus to the group's stop.
  const tabbed = useRef(false);
  const keyboard = mode === "keyboard";
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Tab") return;
      tabbed.current = true;
      setTimeout(() => {
        tabbed.current = false;
      }, 100);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [keyboard]);
  useEffect(() => {
    if (keyboard || sheet || !tabbed.current) return;
    tabbed.current = false;
    if (document.activeElement !== document.body) return;
    group.current?.querySelector<HTMLElement>(`:is(${ITEM})[tabindex="0"]`)?.focus();
  }, [keyboard, sheet]);

  // Live updates replace drawn items: a more urgent session takes the pill,
  // or the summary goes when the count drops to two. A focused item that is
  // removed takes focus to <body>, so while focus was in the group, the
  // group's stop takes it back.
  const inGroup = useRef(false);
  const drawn = `${mode}:${(mode === "pills" ? sorted : sorted.slice(0, 1)).map((s) => s.id).join("\n")}`;
  useEffect(() => {
    if (!inGroup.current || sheet || document.activeElement !== document.body) return;
    group.current?.querySelector<HTMLElement>(`:is(${ITEM})[tabindex="0"]`)?.focus();
  }, [drawn, sheet]);

  // The roving stop is an index, and a live reorder can move the focused
  // session to another one while React keeps its node focused. Re-anchor the
  // stop on the focused item after every render, so Tab still leaves the group
  // in one step and re-entry returns to the same session.
  useLayoutEffect(() => {
    const here = group.current;
    const active = document.activeElement;
    if (!here || !(active instanceof HTMLElement) || !here.contains(active)) return;
    const at = [...here.querySelectorAll<HTMLElement>(ITEM)].indexOf(active);
    if (at !== -1 && at !== roving.stop) roving.onItemFocus(at);
  });

  if (mode === "none") return null;

  function item(e: KeyboardEvent<HTMLDivElement>) {
    const from = e.target as HTMLElement;
    if (!from.matches(ITEM)) return;
    const edge = edgeFor(e.key);
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!edge && !delta) return;
    e.preventDefault();
    if (edge) focusEdge(from, edge, ITEM, "[data-session-strip]");
    else focusSibling(from, delta, ITEM, "[data-session-strip]");
  }

  const themeOf = (el: HTMLElement) => el.closest<HTMLElement>("[data-theme]")?.dataset.theme;

  function openFromSummary(el: HTMLElement) {
    setSheet({ returnTo: el, selection: null, theme: themeOf(el) });
  }

  // The press must not move focus. A caller that derives `keyboardOpen` from
  // the composer's focus would otherwise redraw the strip between press and
  // click, and the summary that was pressed would be gone before it is clicked.
  function holdFocus(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
  }

  // The composer still has focus here: note it and its caret, then blur it
  // so the soft keyboard drops.
  function openFromKeyboardSummary(el: HTMLElement) {
    const active = document.activeElement;
    let returnTo: HTMLElement = el;
    let selection: [number, number] | null = null;
    if (active instanceof HTMLElement && active !== el && active !== document.body) {
      returnTo = active;
      if ((active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && active.selectionStart !== null && active.selectionEnd !== null) {
        selection = [active.selectionStart, active.selectionEnd];
      }
      active.blur();
    }
    setSheet({ returnTo, selection, theme: themeOf(el) });
  }

  function dismiss() {
    restore.current = sheet;
    setSheet(null);
  }

  const all = counts(sorted);
  const urgent = sorted[0]!;

  let items: ReactElement[];
  if (mode === "keyboard") {
    const n = sorted.length;
    const top = all[0]!;
    items = [
      <button
        key="summary"
        type="button"
        className="bk-row bk-pill"
        data-strip-summary="keyboard"
        aria-haspopup="dialog"
        aria-expanded={sheet !== null}
        aria-label={`${n} working ${n === 1 ? "session" : "sessions"}: ${all.map((c) => c.text).join(", ")}. Open list.`}
        tabIndex={roving.tabIndexFor(0)}
        onFocus={() => roving.onItemFocus(0)}
        onMouseDown={holdFocus}
        onClick={(e) => openFromKeyboardSummary(e.currentTarget)}
        style={{ "--hv-bg": color.raised } as CSSProperties}
      >
        <span className="bk-pill-dot" style={{ background: accent[top.tone].mark }} />
        <span className="bk-pill-text" style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-start", gap: 0 }}>
          <span className="bk-pill-title" style={{ flex: "none" }}>{n} working</span>
          <span className="bk-pill-wide bk-pill-value" style={{ marginLeft: 6, color: TONE_INK[top.tone], overflow: "hidden", textOverflow: "ellipsis" }}>
            · {top.text}
          </span>
        </span>
        <Icon icon="next" size={14} color={color.inkMute} />
      </button>,
    ];
  } else {
    const shown = mode === "pills" ? sorted : [urgent];
    items = shown.map((s, i) => {
      const view = describeWorkingSession(s, p.now, clock);
      return (
        <div key={s.id} data-session={s.id} data-state={s.state} style={{ minWidth: 0 }}>
          <ListRow
            density="pill"
            icon={view.icon}
            iconTone={view.tone}
            title={s.label}
            value={view.word}
            valueTone={view.tone}
            name={view.name}
            tabStop={roving.stop === i}
            onFocus={() => roving.onItemFocus(i)}
            onClick={s.onOpen}
          />
        </div>
      );
    });
    if (mode === "overflow") {
      const rest = counts(sorted.slice(1));
      const n = sorted.length - 1;
      items.push(
        <button
          key="summary"
          type="button"
          className="bk-row bk-pill"
          data-strip-summary="overflow"
          aria-haspopup="dialog"
          aria-expanded={sheet !== null}
          aria-label={`${n} more working sessions: ${rest.map((c) => c.text).join(", ")}. Open list.`}
          tabIndex={roving.tabIndexFor(1)}
          onFocus={() => roving.onItemFocus(1)}
          onClick={(e) => openFromSummary(e.currentTarget)}
          style={{ "--hv-bg": color.raised } as CSSProperties}
        >
          <span className="bk-pill-text">
            <span className="bk-pill-title bk-pill-narrow">+{n} more</span>
            <span className="bk-pill-value bk-pill-narrow" style={{ color: TONE_INK[rest[0]!.tone] }}>{rest[0]!.text}</span>
            <span className="bk-pill-title bk-pill-wide">
              +{n} more
              {rest.map((c) => (
                <span key={c.state} style={{ color: TONE_INK[c.tone], fontWeight: 600 }}> · {c.text}</span>
              ))}
            </span>
          </span>
        </button>,
      );
    }
  }

  return (
    <>
      <div
        ref={group}
        role="group"
        aria-label="Working sessions"
        className="bk-pill-group"
        data-session-strip=""
        onKeyDown={item}
        onFocus={() => {
          inGroup.current = true;
        }}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          // A removed item can blur on its way out; that is the case the
          // effect above repairs, so it does not count as focus leaving.
          const from = e.target;
          queueMicrotask(() => {
            if (from.isConnected) inGroup.current = false;
          });
        }}
      >
        {items}
      </div>
      {/* Portalled: each half is a size container, and its layout containment
          would otherwise make it the fixed-position sheet's containing block. */}
      {sheet ? createPortal(
        <WorkingSheet
          sessions={sorted}
          now={p.now}
          clock={clock}
          theme={sheet.theme}
          onDismiss={dismiss}
          onOpen={(s) => {
            setSheet(null);
            s.onOpen();
          }}
        />,
        document.body,
      ) : null}
    </>
  );
}

interface WorkingSheetProps {
  sessions: readonly WorkingSession[];
  now: number;
  clock: (ms: number) => string;
  onDismiss: () => void;
  onOpen: (s: WorkingSession) => void;
  /** The `data-theme` of the subtree the strip sits in, carried past the portal. */
  theme?: string;
}

/**
 * Every tracked session, in urgency order, each a two-line row with its state
 * word, second line and the same accessible name as its pill. The modal rule
 * is the kit's own (`ModelPicker`, the handoff sheet): focus moves to the first
 * row, Tab is trapped, and Esc or a tap on the scrim dismisses.
 */
function WorkingSheet(p: WorkingSheetProps) {
  return (
    <SheetDialog
      title="Working"
      subtitle="Sessions you left while they were busy."
      stops='[role="button"]'
      itemsKey={p.sessions.map((s) => s.id).join("\n")}
      theme={p.theme}
      onDismiss={p.onDismiss}
      scrimAttr="data-working-scrim"
      sheetAttr="data-working-sheet"
      className="bk-working-sheet"
    >
      {p.sessions.map((s, i) => {
        const view = describeWorkingSession(s, p.now, p.clock);
        return (
          <div key={s.id} data-session={s.id} data-state={s.state}>
            <ListRow
              variant="group"
              icon={view.icon}
              iconTone={view.tone}
              title={s.label}
              subtitle={view.detail}
              subMono
              value={view.word}
              valueTone={view.tone}
              name={view.name}
              last={i === p.sessions.length - 1}
              onClick={() => p.onOpen(s)}
            />
          </div>
        );
      })}
    </SheetDialog>
  );
}
