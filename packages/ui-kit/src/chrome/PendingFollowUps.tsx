import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, ReactElement } from "react";

import { edgeFor, focusEdge, focusSibling, useRoving } from "../internal/roving.js";
import { SheetDialog } from "../internal/sheet-dialog.js";
import { Icon } from "../primitives/Icon.js";
import { ListRow } from "../rows/ListRow.js";
import { accent, color } from "../tokens.js";

/**
 * One message the open session has queued and the agent has not received yet
 * (#1002), as the caller knows it. `text` is the message in full; `label` is
 * #1004's few-word label, and without one the pill prints the start of the
 * text ({@link followUpLabel}).
 */
export interface PendingFollowUp {
  id: string;
  text: string;
  label?: string;
}

export interface PendingFollowUpsProps {
  /** In send order, oldest first; none draws no pill at all. */
  followUps: readonly PendingFollowUp[];
  /** The composer is focused with the soft keyboard up: one 44px summary. */
  keyboardOpen?: boolean;
  /**
   * The group's polite announcement: `Follow-up queued`, `Follow-up sent to
   * the agent`, `Follow-up dropped: {reason}`. A new `announcementKey`
   * repeats the same words.
   */
  announcement?: string;
  announcementKey?: number | string;
}

/** A label that is the start of the prompt: its first few words. */
export function followUpLabel(text: string, words: number = 5): string {
  const all = text.trim().split(/\s+/).filter(Boolean);
  if (all.length === 0) return "Follow-up";
  const head = all.slice(0, words).join(" ");
  return all.length > words ? `${head}…` : head;
}

const labelOf = (f: PendingFollowUp) => f.label?.trim() || followUpLabel(f.text);

/** The group's roving items: each pill's ListRow and each summary button. */
const ITEM = '[data-pill][role="button"], [data-pending-summary]';

type Reveal = { id: string; via: "hover" | "focus" | "tap" } | null;

interface OpenSheet {
  returnTo: HTMLElement | null;
  selection: [number, number] | null;
}

/**
 * Pending follow-ups: the right half of the shared row above the composer
 * (D52 §3, #1002). A message sent while its session is busy waits here, not in
 * the transcript, until the agent takes it. Presentational: the caller owns
 * the list, what "taken" means and the words it announces.
 *
 * - **None** draws no pill, so the {@link ComposerRow} half stays empty.
 * - **One or two** draw one 44px pill each, 6px apart, oldest on top: 44 or
 *   94px. Each prints its label and `pending`, neutral, with the `◷` icon:
 *   waiting is not a problem, so it is neither amber nor red.
 * - **Three or more** draw the oldest pill and a `+3 pending` summary that
 *   opens the `Pending follow-ups` sheet: every queued message in full, in
 *   send order, numbered `1 of 4`, read-only.
 * - **`keyboardOpen`** collapses the half to one 44px summary, `◷ 2 pending`
 *   (a single one reads `1 pending`), which opens the same sheet.
 *
 * **A pill's full text** is a popover above it, at most 280px wide and never
 * wider than its half, selectable, `ink` on `raised`. With a pointer it opens
 * on hover or keyboard focus and closes on leave or blur; on touch a tap opens
 * it, and another tap, a tap outside or Esc closes it; Enter or Space toggles
 * it. The text is always the pill's `aria-describedby`. It reveals content,
 * never state, effect or cost, and nothing in it sends, cancels or navigates.
 *
 * **Keyboard.** One tab stop, `role="group"` named `Pending follow-ups`: arrows
 * rove (wrapping, never across the gutter), Home and End go to the ends. The
 * sheet follows the kit's modal rule and returns focus to its summary, or,
 * from the keyboard-open summary, to the composer with its caret restored.
 *
 * **Announcements** go through the group's own polite live region, portalled
 * to `<body>` so it outlives the row: the last pill leaving still announces.
 *
 * Nothing animates and nothing has a transition (D22's one ambient animation
 * is the filament).
 */
export function PendingFollowUps(p: PendingFollowUpsProps) {
  const total = p.followUps.length;
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  const [reveal, setReveal] = useState<Reveal>(null);
  const group = useRef<HTMLDivElement>(null);
  const pointer = useRef<string | null>(null);
  const restore = useRef<OpenSheet | null>(null);
  const base = useId();

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

  const mode = total === 0 ? "none" : p.keyboardOpen ? "keyboard" : total <= 2 ? "pills" : "overflow";
  const itemCount = mode === "none" ? 0 : mode === "keyboard" ? 1 : mode === "pills" ? total : 2;
  const roving = useRoving(Array.from({ length: itemCount }, () => true), 0);

  // The last follow-up left while the sheet was open: close as a dismissal.
  const empty = total === 0;
  useEffect(() => {
    if (!empty || !sheet) return;
    restore.current = sheet;
    setSheet(null);
  }, [empty, sheet]);

  // A revealed follow-up that leaves takes its popover with it.
  const shownIds = (mode === "pills" ? p.followUps : p.followUps.slice(0, 1)).map((f) => f.id);
  const revealedGone = reveal !== null && (mode === "keyboard" || !shownIds.includes(reveal.id));
  useEffect(() => {
    if (revealedGone) setReveal(null);
  }, [revealedGone]);

  // A tap outside closes a popover a tap opened. Blur covers most of it, but
  // a tap on something that cannot take focus moves no focus at all.
  const tapped = reveal?.via === "tap" ? reveal.id : null;
  useEffect(() => {
    if (!tapped) return;
    const outside = (e: globalThis.PointerEvent) => {
      const wrap = group.current?.querySelector(`[data-follow-up="${CSS.escape(tapped)}"]`);
      if (wrap && e.target instanceof Node && wrap.contains(e.target)) return;
      setReveal(null);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [tapped]);

  // A follow-up the agent takes removes its pill; a focused item that goes
  // takes focus to <body>, so while focus was in the group its stop takes it
  // back.
  const inGroup = useRef(false);
  const drawn = `${mode}:${shownIds.join("\n")}`;
  useEffect(() => {
    if (!inGroup.current || sheet || document.activeElement !== document.body) return;
    group.current?.querySelector<HTMLElement>(`:is(${ITEM})[tabindex="0"]`)?.focus();
  }, [drawn, sheet]);
  useLayoutEffect(() => {
    const here = group.current;
    const active = document.activeElement;
    if (!here || !(active instanceof HTMLElement) || !here.contains(active)) return;
    const at = [...here.querySelectorAll<HTMLElement>(ITEM)].indexOf(active);
    if (at !== -1 && at !== roving.stop) roving.onItemFocus(at);
  });

  // The live region is portalled once mounted: there is no document to
  // portal into while rendering on a server.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const live = mounted ? createPortal(
    <div className="bk-sr-only" aria-live="polite" data-pending-live="">
      {p.announcement ? <span key={String(p.announcementKey ?? p.announcement)}>{p.announcement}</span> : null}
    </div>,
    document.body,
  ) : null;

  if (mode === "none") return live;

  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && reveal) {
      e.preventDefault();
      e.stopPropagation();
      setReveal(null);
      return;
    }
    const from = e.target as HTMLElement;
    if (!from.matches(ITEM)) return;
    const edge = edgeFor(e.key);
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!edge && !delta) return;
    e.preventDefault();
    if (edge) focusEdge(from, edge, ITEM, "[data-pending-follow-ups]");
    else focusSibling(from, delta, ITEM, "[data-pending-follow-ups]");
  }

  const holdFocus = (e: MouseEvent<HTMLButtonElement>) => e.preventDefault();
  function openFromSummary(el: HTMLElement) {
    setReveal(null);
    setSheet({ returnTo: el, selection: null });
  }
  // The composer still holds focus: note it and its caret, then blur it so
  // the soft keyboard drops.
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
    setSheet({ returnTo, selection });
  }
  function dismiss() {
    restore.current = sheet;
    setSheet(null);
  }

  let items: ReactElement[];
  if (mode === "keyboard") {
    items = [
      <button
        key="summary"
        type="button"
        className="bk-row bk-pill"
        data-pending-summary="keyboard"
        aria-haspopup="dialog"
        aria-expanded={sheet !== null}
        aria-label={`${total} pending ${total === 1 ? "follow-up" : "follow-ups"}. Open list.`}
        tabIndex={roving.tabIndexFor(0)}
        onFocus={() => roving.onItemFocus(0)}
        onMouseDown={holdFocus}
        onClick={(e) => openFromKeyboardSummary(e.currentTarget)}
        style={{ "--hv-bg": color.raised } as CSSProperties}
      >
        <Icon icon="later" size={15} color={accent.neutral.ink} />
        <span className="bk-pill-text">
          <span className="bk-pill-title">{total} pending</span>
        </span>
        <Icon icon="next" size={14} color={color.inkMute} />
      </button>,
    ];
  } else {
    const shown = mode === "pills" ? p.followUps : p.followUps.slice(0, 1);
    items = shown.map((f, i) => {
      const label = labelOf(f);
      const textId = `${base}-text-${i}`;
      const open = reveal?.id === f.id;
      const toggle = () => {
        const via = pointer.current;
        pointer.current = null;
        // A mouse already revealed it on hover; its click changes nothing.
        if (via === "mouse") return;
        setReveal(open ? null : { id: f.id, via: via ? "tap" : "focus" });
      };
      return (
        <div
          key={f.id}
          className="bk-follow-up"
          data-follow-up={f.id}
          onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
            pointer.current = e.pointerType;
          }}
          onPointerEnter={(e: PointerEvent<HTMLDivElement>) => {
            if (e.pointerType === "mouse") setReveal({ id: f.id, via: "hover" });
          }}
          onPointerLeave={(e: PointerEvent<HTMLDivElement>) => {
            if (e.pointerType === "mouse") setReveal((r) => (r?.id === f.id && r.via === "hover" ? null : r));
          }}
          onFocus={(e: FocusEvent<HTMLDivElement>) => {
            // Keyboard focus reveals; the focus a tap brings does not, or the
            // tap's own toggle would close what the focus opened.
            if ((e.target as HTMLElement).matches?.(":focus-visible")) setReveal({ id: f.id, via: "focus" });
          }}
          onBlur={(e: FocusEvent<HTMLDivElement>) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setReveal((r) => (r?.id === f.id && r.via !== "hover" ? null : r));
          }}
        >
          <ListRow
            density="pill"
            icon="later"
            iconTone="neutral"
            title={label}
            value="pending"
            valueTone="neutral"
            name={`Pending follow-up ${i + 1} of ${total}: ${label}. Not yet received by the agent.`}
            describedBy={textId}
            tabStop={roving.stop === i}
            onFocus={() => roving.onItemFocus(i)}
            onClick={toggle}
          />
          <div id={textId} className="bk-follow-up-text" data-follow-up-text="" hidden={!open}>
            <div className="bk-follow-up-box">{f.text}</div>
          </div>
        </div>
      );
    });
    if (mode === "overflow") {
      const rest = total - 1;
      items.push(
        <button
          key="summary"
          type="button"
          className="bk-row bk-pill"
          data-pending-summary="overflow"
          aria-haspopup="dialog"
          aria-expanded={sheet !== null}
          aria-label={`${rest} pending follow-ups. Open list.`}
          tabIndex={roving.tabIndexFor(1)}
          onFocus={() => roving.onItemFocus(1)}
          onClick={(e) => openFromSummary(e.currentTarget)}
          style={{ "--hv-bg": color.raised } as CSSProperties}
        >
          <span className="bk-pill-text">
            <span className="bk-pill-title">+{rest} pending</span>
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
        aria-label="Pending follow-ups"
        className="bk-pill-group"
        data-pending-follow-ups=""
        onKeyDown={keys}
        onFocus={() => {
          inGroup.current = true;
        }}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          const from = e.target;
          queueMicrotask(() => {
            if (from.isConnected) inGroup.current = false;
          });
        }}
      >
        {items}
      </div>
      {live}
      {sheet ? (
        <SheetDialog
          title="Pending follow-ups"
          subtitle="Not yet received by the agent."
          stops="[data-pending-row]"
          itemsKey={p.followUps.map((f) => f.id).join("\n")}
          onDismiss={dismiss}
          scrimAttr="data-pending-scrim"
          sheetAttr="data-pending-sheet"
          className="bk-pending-sheet"
        >
          <ol className="bk-pending-list" aria-label="Pending follow-ups, in send order">
            {p.followUps.map((f, i) => (
              <li key={f.id} className="bk-pending-row" data-pending-row="" tabIndex={0}>
                <span className="bk-pending-count">{i + 1} of {total}</span>
                <span className="bk-pending-full">{f.text}</span>
              </li>
            ))}
          </ol>
        </SheetDialog>
      ) : null}
    </>
  );
}
