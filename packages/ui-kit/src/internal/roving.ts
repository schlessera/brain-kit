import { useState } from "react";

/**
 * Roving tabindex: the state a `tablist` / `radiogroup` needs to be ONE tab
 * stop instead of one per item.
 *
 * The ARIA pattern for a composite widget is that Tab reaches the group and the
 * arrow keys move inside it. Waves 2-4 shipped the arrow keys but left every
 * item at `tabIndex={0}`, so the arrows were redundant with Tab and a screen
 * carrying both nav components cost **ten tab presses before any content**
 * (`docs/decisions/design-feedback.md` §11, measured in `stories/rules/Keyboard.stories`).
 *
 * ## The hazard this module exists to make unreachable
 *
 * A group whose items are all `tabIndex={-1}` is not "harder to reach", it is
 * **completely unreachable from the keyboard** — and that is what you get from
 * the obvious implementation the moment the selected item is not eligible to be
 * the stop. So the stop is never derived from selection alone:
 *
 *   1. the last item inside the group that actually took focus, if it is still
 *      eligible — which is what makes Tab return you to where you were;
 *   2. otherwise the selected item, if IT is eligible;
 *   3. otherwise **the first eligible item**, which is the clause that keeps a
 *      group with nothing selected, or whose selected item carries no handler,
 *      reachable.
 *
 * Eligibility is the kit's existing per-item gate: an item with no handler gets
 * no role and no tab stop, so it cannot be the group's one stop either. When
 * NOTHING is eligible the stop is `-1` and no item is a stop — which is the
 * correct answer, not a fallback failure: a group of decorative items has no
 * tab stops at all and `NothingIsReachableWithoutAHandler` asserts it.
 *
 * `ChoiceOption` does not use this hook and cannot: it is a single option and
 * the group belongs to its caller. Its answer is a `tabStop` prop, driven by
 * {@link AskUserCard}, and it is documented on the component.
 */
export interface Roving {
  /** `0` for the group's one tab stop, `-1` for every other eligible item. */
  tabIndexFor: (index: number) => 0 | -1;
  /** Wire to each item's `onFocus` so the stop follows the caret. */
  onItemFocus: (index: number) => void;
  /** The index that currently holds the stop, or `-1` when nothing is eligible. */
  stop: number;
}

export function useRoving(eligible: readonly boolean[], selected: number): Roving {
  const [focused, setFocused] = useState<number | null>(null);
  const stop =
    focused !== null && eligible[focused]
      ? focused
      : eligible[selected]
        ? selected
        : eligible.indexOf(true);
  return {
    stop,
    tabIndexFor: (index) => (index === stop ? 0 : -1),
    onItemFocus: setFocused,
  };
}

/**
 * Moves focus to the previous or next item of a composite widget, wrapping at
 * both ends — `→` on the last item returns to the first rather than silently
 * doing nothing.
 *
 * The walk is over the DOM rather than over the props array on purpose: the
 * items that carry a role are exactly the eligible ones, so a mixed group skips
 * its decorative items for free. It also means **the index into this list is
 * not the index into `items`** — the returned element is what a caller should
 * act on, never a positional guess.
 *
 * `group` is a selector for the enclosing container when the items are not
 * siblings of one parent (`ChoiceOption` lives inside its caller's markup); it
 * falls back to the element's own parent so a bare column still works.
 */
export function focusSibling(
  from: HTMLElement,
  delta: number,
  item: string,
  group?: string,
): HTMLElement | null {
  const scope = (group ? from.closest(group) : null) ?? from.parentElement;
  if (!scope) return null;
  const items = [...scope.querySelectorAll<HTMLElement>(item)];
  const here = items.indexOf(from);
  if (here === -1 || items.length < 2) return null;
  const next = items[(here + delta + items.length) % items.length]!;
  next.focus();
  return next;
}

/**
 * Home / End: focus the first or last item of the composite widget, over the
 * same DOM walk as {@link focusSibling}. "Every composite widget with arrow-key
 * movement also takes Home and End for first and last … they were missing
 * from the table rather than deliberately absent" (the fourth drop's answer to
 * design-feedback §11).
 */
export function focusEdge(from: HTMLElement, edge: "first" | "last", item: string, group?: string): HTMLElement | null {
  const scope = (group ? from.closest(group) : null) ?? from.parentElement;
  if (!scope) return null;
  const items = [...scope.querySelectorAll<HTMLElement>(item)];
  if (items.length === 0) return null;
  const next = edge === "first" ? items[0]! : items[items.length - 1]!;
  next.focus();
  return next;
}

/** `Home` / `End` → the edge they name, or null for any other key. */
export function edgeFor(key: string): "first" | "last" | null {
  return key === "Home" ? "first" : key === "End" ? "last" : null;
}
