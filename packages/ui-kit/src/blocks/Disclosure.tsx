import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useState } from "react";

import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font } from "../tokens.js";

/**
 * Collapsed detail inside an answer — the tool trace, the long reasoning, the
 * other fourteen rows.
 *
 * The summary line always states WHAT is hidden and HOW MUCH of it, so
 * collapsing never hides the existence of evidence.
 *
 * ── The one stateful component in the kit, and it has three modes ─────────
 *
 * **DO NOT "RESTORE PARITY" BY DELETING `onOpenChange`.** The controlled mode
 * is a DELIBERATE divergence from the design, decided by the maintainer and
 * recorded as D27 in `docs/decisions/design-kit.md`. The reasoning is in that entry; the
 * short version is that two real cases in this app are unreachable without it.
 *
 *   1. UNCONTROLLED — neither prop. Starts closed, toggles itself.
 *   2. SEEDED — `open` alone. **Unchanged from the design**: `open` sets the
 *      initial value and is ignored from the first toggle onward, exactly as
 *      `state.open === null ? p.open === true : state.open` did. Every call
 *      site that passes only `open` behaves as it always has, and
 *      `OpenPropIsSeedOnly` still asserts it.
 *   3. CONTROLLED — `open` AND `onOpenChange`. Internal state steps aside and
 *      the parent owns the value.
 *
 * `onOpenChange` fires on every toggle in all three modes, so a parent can
 * observe without taking ownership. It is the PRESENCE OF BOTH PROPS that
 * hands over control — the standard React pattern, and the only one that lets
 * mode 2 keep the design's behaviour unchanged.
 *
 * What mode 3 buys, both of which are real here and neither reachable before:
 * a transcript that re-renders because the server said "expand the trace" can
 * now expand it; and a parent rendering several disclosures — the Run-detail
 * screen does — can collapse the others when one opens, which is the accordion
 * the `Accordion` story demonstrates.
 */
export interface DisclosureProps {
  /** Says what is hidden and how much of it. */
  label?: string;
  meta?: string;
  icon?: IconName;
  /**
   * A SEED on its own — read once, on mount, then ignored, which is the
   * design's behaviour. Paired with `onOpenChange` it becomes the live value
   * and the parent owns it. See the note above.
   */
  open?: boolean;
  /**
   * Fires on every toggle with the value the component is moving TO. Passing
   * it alongside `open` is what makes the component controlled; passing it
   * alone just lets a parent watch.
   */
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}

export function Disclosure(p: DisclosureProps) {
  // Both props, and only both, hand control to the parent. `open` alone has to
  // keep seeding local state or mode 2 would stop being the design's.
  const controlled = p.open !== undefined && p.onOpenChange !== undefined;
  const [internal, setInternal] = useState(p.open === true);
  const open = controlled ? p.open === true : internal;

  function toggle() {
    const next = !open;
    // A controlled component must not also hold state, or the two disagree the
    // moment the parent refuses a change.
    if (!controlled) setInternal(next);
    p.onOpenChange?.(next);
  }

  const summary: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 7,
    font: `500 11px/1.4 ${font.mono}`,
    color: accent.neutral.ink,
    cursor: "pointer",
    userSelect: "none",
    // Hover moves the text to primary ink and nothing else — the summary has
    // no background and no border to move, so both hover properties resolve to
    // where they already are.
    ...({
      "--hv-bg": "transparent",
      "--hv-bd": "transparent",
      "--hv-fg": color.ink,
    } as CSSProperties),
  };

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  }

  return (
    <div
      style={{
        boxSizing: "border-box",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 9,
      }}
    >
      {/* Unconditionally interactive, unlike every gated component in the kit:
          a disclosure with no toggle is not a disclosure, and the design gives
          it the role and the tab stop outright rather than behind a handler. */}
      <div
        style={summary}
        className="bk-control"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        {/* Not optional: the source's `icon` falls back to `steps`, so the
            guard around it can never be false. */}
        <Icon icon={p.icon || "steps"} size={13} color={accent.neutral.ink} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {p.label ?? "4 steps · 3 files touched · 2.1s"}
        </span>
        {p.meta ? <span style={{ flex: "none", color: accent.neutral.ink }}>{p.meta}</span> : null}
        <Icon icon={open ? "collapse" : "next"} size={13} color={accent.neutral.ink} />
      </div>
      {open ? (
        <div
          style={{
            borderLeft: `2px solid ${color.line}`,
            paddingLeft: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {p.children ?? null}
        </div>
      ) : null}
    </div>
  );
}
