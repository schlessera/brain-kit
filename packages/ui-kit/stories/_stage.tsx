import type { Decorator } from "@storybook/react-vite";

/**
 * The one decorator every story file uses.
 *
 * It exists to make D16 visible rather than assumed. The design is drawn at
 * one phone width and the ported components are fluid, so each component's
 * stories render inside a phone-ish column by default and every block-level
 * component carries a `Wide` story that widens the same column to the canvas.
 * A component that only works at 390px fails that story loudly.
 *
 * Width comes from `parameters.stageWidth` because `Story.extend()` DEEP-merges
 * parameters but CONCATENATES decorators — so a second decorator could only
 * wrap the first, never replace it.
 *
 * `alignItems: flex-start` is the sc-host decision made visible (recorded in
 * `docs/decisions/design-kit.md`). Ported components render no wrapper, so the
 * component's own root is the flex item: a block component declaring
 * `width: 100%` fills the column, and an `inline-flex` primitive shrink-wraps.
 * Both are the design's own declarations, now load-bearing.
 */
export const stage: Decorator = (Story, context) => (
  <div
    style={{
      width: "100%",
      maxWidth: (context.parameters.stageWidth as number | string | undefined) ?? 360,
      boxSizing: "border-box",
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      gap: 10,
    }}
  >
    <Story />
  </div>
);

/** `parameters` for the desktop half of D16: the same column, unconstrained. */
export const wide = { stageWidth: "none" };

/** A labelled row, for the grid stories that show a whole variant x tone set. */
export function Row({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", flexWrap: "wrap" }}>
      <span
        style={{
          width: 62,
          flex: "none",
          font: "500 9px/1.3 'JetBrains Mono',ui-monospace,monospace",
          color: "var(--color-ink-mute)",
        }}
      >
        {caption}
      </span>
      {children}
    </div>
  );
}

/**
 * Every way `container`'s content escapes `container`, as sentences.
 *
 * This exists because of a real bug that typechecked, passed every unit test,
 * passed the DC parity harness, and was still visibly broken: two `Button`s in
 * a flex row, each defaulting to `block` (`width: 100%`) and each refusing to
 * shrink (`flex: none`), so the row came out 200% wide and the second button
 * rendered outside its card. Nothing that inspects props or computed styles
 * catches that — only measuring the laid-out boxes does.
 *
 * Two checks, because they fail on different things. `scrollWidth` catches
 * content wider than its box however it got that way; the per-element edge
 * comparison names WHICH element escaped, which is what makes the failure
 * readable. Assert `toEqual([])` so the message is the list.
 *
 * A 1px tolerance absorbs sub-pixel layout rounding, which is real and is not
 * a bug.
 */
export function overflowing(container: HTMLElement, selector = "*"): string[] {
  const box = container.getBoundingClientRect();
  const out: string[] = [];
  if (container.scrollWidth > container.clientWidth + 1) {
    out.push(`content is ${container.scrollWidth}px wide inside a ${container.clientWidth}px box`);
  }
  for (const el of container.querySelectorAll<HTMLElement>(selector)) {
    // Content inside an <svg> is clipped to the svg's own viewport by default,
    // so a polyline whose geometry runs past the map card cannot escape the
    // frame; the <svg> element itself is still measured. MapView's paths are
    // fetched wider than the card on purpose (the 1.5 x 1.0 envelope).
    if ((el as unknown as { ownerSVGElement?: unknown }).ownerSVGElement) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) continue;
    const name = `<${el.tagName.toLowerCase()}>${(el.textContent ?? "").trim().slice(0, 24)}`;
    if (rect.right > box.right + 1) {
      out.push(`${name} overflows the right edge by ${Math.round(rect.right - box.right)}px`);
    }
    if (rect.left < box.left - 1) {
      out.push(`${name} overflows the left edge by ${Math.round(box.left - rect.left)}px`);
    }
  }
  return out;
}

/**
 * The one sanctioned way to let a story past the a11y gate, and the reason it
 * is a function rather than a literal: every call site has to name the
 * `docs/decisions/design-feedback.md` entry that explains itself.
 *
 * Wave 1b put `parameters.a11y.test` at `'error'`. Four contrast failures
 * survived that flip, and all four are DESIGN decisions rather than port bugs —
 * the ink ramp is the design's, the opacity that de-emphasises a superseded row
 * is the design's, and the paper theme is a known gap the design itself
 * records. Adjusting the palette here would silence the finding and quietly
 * fork the kit from its source, so the palette is untouched and each one is
 * written down instead.
 *
 * What this disables is ONE RULE on ONE STORY. Every other axe rule still runs
 * on that story, and `color-contrast` still runs on all 470-odd others. The
 * measured ratios live in `tests/contrast.test.ts` rather than in a comment, so
 * the day a token moves, that test fails and names the number that changed —
 * which is the whole point of recording a gap instead of hiding it.
 *
 * `reason` is prose, not an id, and it is here so a reviewer reading the story
 * never has to open another file to learn why the gate let this one through.
 */
export function knownContrastGap(reason: string) {
  return {
    a11y: { options: { rules: { "color-contrast": { enabled: false } } } },
    designFeedbackReason: reason,
  } as const;
}

/**
 * The focus ring as the browser actually computed it, after a real Tab.
 *
 * Asserting the CLASS would only prove the component asked for a ring; this
 * proves it got one, at the offset its class specifies. That matters because
 * the +2 / −2 split is the whole reason the design states two offsets: an
 * outline at +2 on a full-width row is drawn OUTSIDE the row and clipped by the
 * first `overflow: hidden` ancestor, which in this kit is every `Surface`, so
 * the wrong offset produces a ring that is present in the stylesheet, correct
 * in the computed style and invisible on screen.
 *
 * `:focus-visible` cannot be read through `getComputedStyle`'s pseudo argument
 * — that argument only takes pseudo-ELEMENTS — so the element has to actually
 * be focused, and it has to be focused FROM THE KEYBOARD, since a pointer tap
 * deliberately leaves no ring behind.
 */
export function ring(el: Element): { width: string; offset: string; style: string } {
  const computed = getComputedStyle(el);
  return { width: computed.outlineWidth, offset: computed.outlineOffset, style: computed.outlineStyle };
}

/** The ring a `.bk-control` should have: drawn outside, clear of the paint. */
export const CONTROL_RING = { width: "2px", offset: "2px", style: "solid" };

/** The ring a `.bk-row` should have: drawn inside, so nothing clips it. */
export const ROW_RING = { width: "2px", offset: "-2px", style: "solid" };

/**
 * Content a screen renders and no one can reach.
 *
 * `ScreenBody` defaults to `overflow: hidden` because that is what the design's
 * mockups do — a static mockup has nothing to scroll — and the default is
 * right for a specimen. On an assembled SCREEN it is a trap: the body clips,
 * the clip looks like the end of the content, and the screen quietly loses
 * everything below the fold. Wave 5 shipped exactly that on the morning digest
 * — 420px of schedule, one card and the closing banner, rendered and
 * unreachable — and nothing in the suite could see it, because clipped content
 * overflows nothing and measures fine.
 *
 * So the rule is not "screens must scroll", it is **a screen may not render
 * more than it can reach**: either the content fits, or the body scrolls.
 */
export function unreachable(body: HTMLElement): string[] {
  const hidden = body.scrollHeight - body.clientHeight;
  if (hidden <= 1) return [];
  const overflowY = getComputedStyle(body).overflowY;
  if (overflowY === "auto" || overflowY === "scroll") return [];
  return [`${hidden}px of content below the fold, and overflow-y is ${overflowY}`];
}
