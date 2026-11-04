import { useId, useState, type KeyboardEvent } from "react";

/**
 * The expansion state and toggle wiring shared by the kit's collapsibles:
 * `Disclosure`, `Tray` and `ItemCard` (#3253).
 *
 * Internal, and deliberately small. It owns the three things those components
 * genuinely share — the open value, how a toggle moves it, and the ARIA that
 * ties a toggle to its body — and nothing about layout or content lifecycle.
 * Each public component decides for itself whether a closed body unmounts
 * (`Disclosure`, `ItemCard`) or stays mounted and hidden (`Tray`, whose
 * recordings keep their playback). Do not add layout switches here.
 *
 * ── The three modes, unchanged from D27 ─────────────────────────────────
 *
 *   1. UNCONTROLLED — neither `open` nor `onOpenChange`. Starts closed.
 *   2. SEEDED — `open` alone. Read once on mount, ignored from the first
 *      toggle onward, exactly as the design's `Disclosure` did.
 *   3. CONTROLLED — `open` AND `onOpenChange`. The parent owns the value and
 *      no internal state is consulted.
 *
 * `onOpenChange` fires on every toggle in all three modes with the value the
 * component is moving TO. It is the presence of both props, and only both,
 * that hands control to the parent.
 */
interface ExpansionOptions {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface Expansion {
  open: boolean;
  toggle: () => void;
  /** The id the body element must carry; `aria-controls` points at it. */
  bodyId: string;
  /**
   * Props for a toggle that is a native `<button>`: Enter and Space are the
   * browser's, so only state and ARIA are added.
   */
  buttonProps: (o?: { bodyMounted?: boolean }) => {
    "aria-expanded": boolean;
    "aria-controls": string | undefined;
    onClick: () => void;
  };
  /**
   * Props for a toggle drawn as a `role="button"` element, which must supply
   * its own keyboard activation. `Disclosure` keeps this shape so its DOM is
   * unchanged for every existing consumer.
   */
  roleButtonProps: (o?: { bodyMounted?: boolean }) => {
    role: "button";
    tabIndex: 0;
    "aria-expanded": boolean;
    "aria-controls": string | undefined;
    onClick: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
}

export function useExpansion(o: ExpansionOptions): Expansion {
  const controlled = o.open !== undefined && o.onOpenChange !== undefined;
  const [internal, setInternal] = useState(o.open === true);
  const open = controlled ? o.open === true : internal;
  const bodyId = useId();

  function toggle() {
    const next = !open;
    // A controlled component must not also hold state, or the two disagree the
    // moment the parent refuses a change.
    if (!controlled) setInternal(next);
    o.onOpenChange?.(next);
  }

  // `aria-controls` must name an element that exists. A body that unmounts on
  // close passes `bodyMounted: open`; a hidden body is always present.
  const controls = (bodyMounted = open) => (bodyMounted ? bodyId : undefined);

  return {
    open,
    toggle,
    bodyId,
    buttonProps: (p) => ({ "aria-expanded": open, "aria-controls": controls(p?.bodyMounted), onClick: toggle }),
    roleButtonProps: (p) => ({
      role: "button",
      tabIndex: 0,
      "aria-expanded": open,
      "aria-controls": controls(p?.bodyMounted),
      onClick: toggle,
      onKeyDown: (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle();
      },
    }),
  };
}
