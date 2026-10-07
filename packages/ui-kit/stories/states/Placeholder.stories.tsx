import { useState } from "react";
import preview from "#.storybook/preview";
import { expect, fn, waitFor } from "storybook/test";

import type { GhostRole } from "../../src/internal/GhostText.js";
import { Placeholder } from "../../src/states/Placeholder.js";
import type { Tone } from "../../src/types.js";
import { CONTROL_RING, ring, Row, stage, wide } from "../_stage.js";

const TONES: Tone[] = ["neutral", "red", "amber", "teal", "gold"];

const meta = preview.meta({
  title: "States/Placeholder",
  component: Placeholder,
  decorators: [stage],
  args: { variant: "loading", lines: 3, bordered: true, animate: true, pad: 12, onAction: fn() },
  argTypes: {
    variant: { control: "select", options: ["loading", "empty", "error"] },
    tone: { control: "select", options: TONES },
    lines: { control: { type: "number", min: 1, max: 5, step: 1 } },
    pad: { control: { type: "number", min: 0, max: 20, step: 1 } },
    icon: { control: "text" },
  },
});

/**
 * Ghost text (#1116): blurred text with the kit spectrum sweeping through it,
 * left to right. With no `ghost`, `lines` draws neutral one-line ghosts. Never
 * a spinner — "a spinner says 'wait' without saying what for" — and never
 * bars. It is a loading state, not ambient motion: it ends when the data does.
 */
export const Loading = meta.story({});

/** `animate: false` holds the same ghost still — the story a visual-regression
 * baseline can be taken from without racing an animation. */
export const LoadingStill = Loading.extend({ args: { animate: false } });

export const LoadingOneLine = Loading.extend({ args: { lines: 1 } });

/**
 * A dashed hairline and a mono sentence saying what would be here and why it
 * isn't. The message is the caller's; the fallback only applies when none is
 * given.
 */
export const Empty = Loading.extend({
  args: { variant: "empty", message: "No sightings logged since Aeaea" },
});

export const EmptyWithDetail = Empty.extend({
  args: { detail: "The last entry is 40 days old. Nothing has been filed from the raft." },
});

/** The fallback sentence, for a caller that supplied none. */
export const EmptyDefaultCopy = Loading.extend({ args: { variant: "empty" } });

/**
 * A red hairline with the failure named, and a way to retry where one exists.
 * The tone defaults to red for the error variant without being asked.
 */
export const Error = Loading.extend({
  args: {
    variant: "error",
    message: "Could not reach the oracle at Aeaea",
    detail: "Three attempts, no reply. The route stays unplanned.",
    actionLabel: "Retry",
  },
});

/** No `actionLabel`, so no retry affordance: the design does not offer a
 * button for something the caller cannot actually retry. */
export const ErrorWithoutRetry = Error.extend({ args: { actionLabel: undefined } });

export const Borderless = Loading.extend({ args: { bordered: false } });

export const Wide = Error.extend({ parameters: wide });

export const Retried = Error.extend({
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(await canvas.findByText("Retry"));
    await expect(args.onAction).toHaveBeenCalled();
  },
});

/**
 * THE CONTRACT, wave 1b. The retry is a small bordered pill with padding around
 * it, so it is a `.bk-control` and its ring sits OUTSIDE at +2 — the opposite
 * of a full-width row, and the reason the design states the two offsets side by
 * side.
 *
 * Its hover moves the background only. `--hv-bd` is deliberately set to the
 * rest border rather than to D20's neutral `#3a3e47`, because this control's
 * border is TONED: swapping it for grey would change what the control means,
 * which is the one thing D20 says hover must never do. It still has to be
 * written down — `.bk-control:hover` substitutes it unconditionally, and an
 * unset custom property there is invalid at computed-value time and resets
 * `border-color` to `currentColor`.
 */
export const RetryIsAControl = Error.extend({
  play: async ({ canvas, userEvent, args }) => {
    const retry = await canvas.findByRole("button", { name: "Retry" });
    await expect(retry.className).toBe("bk-control");

    await userEvent.tab();
    await expect(document.activeElement).toBe(retry);
    await expect(ring(retry)).toEqual(CONTROL_RING);

    await userEvent.keyboard("{Enter}");
    await expect(args.onAction).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    await expect(args.onAction).toHaveBeenCalledTimes(2);

    // The tone survives the hover: --hv-bd is the REST border, not D20's
    // neutral grey, so hovering a red retry does not turn it into a grey one.
    await expect(retry.style.getPropertyValue("--hv-bd")).toBe("var(--bk-placeholder-action-border-red)");
    await expect(retry.style.getPropertyValue("--hv-bg")).toBe("var(--bk-hover-veil-firm)");
  },
});

/** THE GATE. The design draws the retry label whether or not anything is
 * listening; without `onAction` it stays a label. */
export const RetryWithoutAHandler = Error.extend({
  args: { onAction: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByText("Retry")).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector(".bk-control")).toBeNull();
  },
});

/** The error tone is overridable; the other variants take neutral. */
export const Tones = meta.story({
  parameters: { stageWidth: "none" },
  render: () => (
    <>
      {TONES.map((tone) => (
        <Row key={tone} caption={tone}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Placeholder variant="error" tone={tone} message={`error · ${tone}`} actionLabel="Retry" />
          </div>
        </Row>
      ))}
    </>
  ),
});

/* ── Ghost text (#1116) ─────────────────────────────────────────────────── */

const ROLES: { role: GhostRole; size: number; length: number }[] = [
  { role: "sans", size: 13, length: 58 },
  { role: "mono", size: 11, length: 26 },
  { role: "title", size: 19, length: 22 },
];

/**
 * Every role at one to five lines. The story projects render it on dark and
 * on paper, so this is the roles × lines × themes matrix. A block of N lines
 * is one ghost of N measures' length, wrapping where text of that length would.
 */
export const GhostRoles = meta.story({
  parameters: wide,
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
      {ROLES.map(({ role, size, length }) =>
        [1, 2, 3, 4, 5].map((n) => (
          <Row key={`${role}-${n}`} caption={`${role} ×${n}`}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Placeholder variant="loading" seed={`${role}-${n}`} ghost={Array.from({ length: n }, () => ({ role, size, length }))} />
            </div>
          </Row>
        )),
      )}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const ghosts = [...canvasElement.querySelectorAll<HTMLElement>(".bk-ghost")];
    await expect(ghosts).toHaveLength(3 * 15);
    for (const g of ghosts) {
      await expect(g.getAttribute("aria-hidden")).toBe("true");
      // The glyphs are drawn by the gradient, through the text.
      await expect(getComputedStyle(g).color).toBe("rgba(0, 0, 0, 0)");
      await expect(getComputedStyle(g).filter).toMatch(/^blur\(/);
      await expect(getComputedStyle(g).animationName).toBe("ghost");
    }
  },
});

/**
 * `arrived` hands off: the real content fades in over 600ms while the ghost
 * fades out on top of it, then the ghost is gone. Toggle it with the button.
 */
export const Arrived = meta.story({
  render: () => {
    function Toggle() {
      const [arrived, setArrived] = useState(false);
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
          <button type="button" onClick={() => setArrived((a) => !a)}>
            {arrived ? "Reload" : "Arrive"}
          </button>
          <Placeholder variant="loading" seed="omens" ghost={[{ role: "sans", size: 12, length: 92 }]} arrived={arrived}>
            <div style={{ font: "400 12px/1.55 var(--font-body, 'Plus Jakarta Sans',sans-serif)", color: "var(--bk-color-ink)" }}>
              An eagle carrying a goose across the courtyard, reported by a guest at the second feast.
            </div>
          </Placeholder>
        </div>
      );
    }
    return <Toggle />;
  },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const box = () => canvasElement.querySelector<HTMLElement>("[aria-busy]");
    await expect(box()).not.toBeNull();
    await userEvent.click(await canvas.findByRole("button", { name: "Arrive" }));
    await expect(box()).toBeNull();
    const out = canvasElement.querySelector<HTMLElement>(".bk-ghost-out")!;
    await expect(getComputedStyle(out).position).toBe("absolute");
    await expect(getComputedStyle(out).animationName).toBe("ghost-out");
    await expect(getComputedStyle(canvasElement.querySelector(".bk-ghost-in")!).animationName).toBe("ghost-in");
    await waitFor(() => expect(canvasElement.querySelectorAll(".bk-ghost")).toHaveLength(0), { timeout: 1000 });
    await expect(await canvas.findByText(/An eagle carrying a goose/)).toBeVisible();
  },
});

/** Ghosts are not printed: the print theme paints them in nothing, and a
 * browser print hides them, keeping their box. */
export const NotPrinted = meta.story({
  render: () => (
    <div data-theme="print" style={{ width: "100%" }}>
      <Placeholder variant="loading" lines={3} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const ghosts = canvasElement.querySelectorAll<HTMLElement>(".bk-ghost");
    await expect(ghosts).toHaveLength(3);
    for (const g of ghosts) {
      // Every stop resolves to transparent: no opaque `rgb(` survives.
      await expect(getComputedStyle(g).backgroundImage).toContain("rgba(0, 0, 0, 0)");
      await expect(getComputedStyle(g).backgroundImage).not.toContain("rgb(");
    }
    let printRule = false;
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // a cross-origin sheet; none of ours are.
      }
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule && rule.conditionText === "print") {
          for (const inner of rule.cssRules) {
            if (inner instanceof CSSStyleRule && inner.selectorText === ".bk-ghost" && inner.style.visibility === "hidden") printRule = true;
          }
        }
      }
    }
    await expect(printRule).toBe(true);
  },
});
