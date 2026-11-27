import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { useRoving } from "./roving.js";

type Roving = Pick<ReturnType<typeof useRoving>, "stop" | "onItemFocus">;

/** An open strip sheet and where focus goes when it is dismissed. */
interface OpenSheet {
  /** Where focus goes when the sheet is dismissed. */
  returnTo: HTMLElement | null;
  /** The composer's caret, when the keyboard-open summary opened the sheet. */
  selection: [number, number] | null;
}

/**
 * The sheet of a strip above the composer (`SessionStrip`, `PendingFollowUps`):
 * its state, the dismissal that restores focus and the caret once the sheet
 * has unmounted, and the keyboard-open summary's opener.
 *
 * Call it where the strip declares its sheet state: its restore effect then
 * runs before the strip's later focus effects, as each strip's did.
 */
export function useStripSheet({ group, item }: { group: RefObject<HTMLElement | null>; item: string }) {
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  // Set by a dismissal, consumed once the sheet has unmounted, so the trap
  // cannot take focus back and the target is the element that is now drawn.
  const restore = useRef<OpenSheet | null>(null);
  useEffect(() => {
    const to = restore.current;
    if (sheet || !to) return;
    restore.current = null;
    const target = to.returnTo && to.returnTo.isConnected
      ? to.returnTo
      : group.current?.querySelector<HTMLElement>(`:is(${item})[tabindex="0"]`) ?? null;
    target?.focus();
    if (target && to.selection && (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) {
      target.setSelectionRange(to.selection[0], to.selection[1]);
    }
  }, [sheet]);

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
    setSheet({ returnTo, selection });
  }

  /** Close as a dismissal: focus goes back where the sheet came from. */
  function dismiss() {
    restore.current = sheet;
    setSheet(null);
  }

  return { sheet, setSheet, openFromKeyboardSummary, dismiss };
}

/**
 * The strip's roving focus across live redraws. A focused item that is
 * removed takes focus to <body>, so while focus was in the group its stop
 * takes it back; and the roving stop is an index, so after every render it is
 * re-anchored on the focused item. Call it where the strip declared these two
 * effects; set `inGroup` from the group's focus handlers.
 */
export function useStripFocus({ group, item, drawn, sheet, roving }: { group: RefObject<HTMLElement | null>; item: string; drawn: string; sheet: OpenSheet | null; roving: Roving }) {
  const inGroup = useRef(false);
  useEffect(() => {
    if (!inGroup.current || sheet || document.activeElement !== document.body) return;
    group.current?.querySelector<HTMLElement>(`:is(${item})[tabindex="0"]`)?.focus();
  }, [drawn, sheet]);
  useLayoutEffect(() => {
    const here = group.current;
    const active = document.activeElement;
    if (!here || !(active instanceof HTMLElement) || !here.contains(active)) return;
    const at = [...here.querySelectorAll<HTMLElement>(item)].indexOf(active);
    if (at !== -1 && at !== roving.stop) roving.onItemFocus(at);
  });
  return inGroup;
}
