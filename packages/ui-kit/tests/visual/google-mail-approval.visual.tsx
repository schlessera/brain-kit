/// <reference types="@vitest/browser/matchers" />
/**
 * The Gmail approval cards' claims that only a real browser can check
 * (#4215), and their pixels.
 *
 * - **A long body scrolls by keyboard.** The stories prove the region is a
 *   named tab stop and that the cue follows its scroll position; a story's
 *   `userEvent` is synthetic, so it cannot press a key the browser scrolls
 *   for. Here the input is real (CDP): PageDown and End scroll the focused
 *   region, the cue counts down and goes at the end, and Allow stays enabled
 *   throughout (M3: no gate).
 * - **Baselines.** The defining states, at 320px and at the 680px desktop
 *   column, in dark and paper: a lost Bcc row, a collapsed envelope column, a
 *   cue that stopped fading, a banner that lost its provenance colour, or a
 *   body that stopped drawing its syntax, blank lines and spacing as written.
 *   Geometry, targets, copy, keys and containment are the stories' own plays.
 * - **Review captures.** Every story, at its width, in both themes, written to
 *   `packages/ui-kit/.vitest-attachments/google-mail-approval/` for the maintainer's sign-off
 *   (M7). They are artifacts, not baselines.
 *
 * Each story runs as written, play included; the captures show the state its
 * play leaves (an expanded list stays expanded). Focus is cleared first, so
 * no capture carries a focus ring the play left behind.
 */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { clearAllMocks } from "storybook/test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import "../../src/styles.css";
import { longMessage, matchesFor } from "../../fixtures/gmail-approval.js";
import { GoogleMailApprovalCard } from "../../src/google/GoogleMailApprovalCard.js";
import * as stories from "../../stories/google/GoogleMailApprovalCard.stories.js";

interface Runnable {
  run: (context?: { globals?: Record<string, unknown> }) => Promise<void>;
}

const TOLERANCE = { comparatorOptions: { threshold: 0.01, allowedMismatchedPixelRatio: 0.001 } } as const;

let root: Root | undefined;
let host: HTMLElement | undefined;

beforeEach(() => {
  // A play asserts its own calls; Storybook clears the spies between stories, and `run()` alone does not.
  clearAllMocks();
});

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

/** The page at `width` × `height`, with the outer window grown to fit, so a tall card is captured at 1:1. */
async function inViewport(width: number, height: number, body: () => Promise<void>) {
  const frameBefore = { width: window.innerWidth, height: window.innerHeight };
  const outerBefore = await commands.formViewport(width, height);
  try {
    await page.viewport(width, height);
    await body();
  } finally {
    await page.viewport(frameBefore.width, frameBefore.height);
    await commands.formViewport(outerBefore.width - 100, outerBefore.height - 120);
  }
}

/** The story at its width, in a theme, with the ground asserted before anything is captured. */
async function runAt(story: Runnable, narrow: boolean, theme: "dark" | "light", body: (card: HTMLElement) => Promise<void>) {
  await inViewport(narrow ? 320 : 760, 2400, async () => {
    await story.run({ globals: { theme } });
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(getComputedStyle(document.documentElement).colorScheme).toBe(theme);
    (document.activeElement as HTMLElement | null)?.blur?.();
    const card = document.querySelector<HTMLElement>("[data-google-mail-approval]");
    expect(card, "the story drew its card").not.toBeNull();
    expect(card!.getBoundingClientRect().width, "the card drew at its width").toBeGreaterThan(narrow ? 280 : 679);
    await body(card!);
  });
}

const STORIES = (Object.entries(stories) as [string, unknown][]).filter((entry): entry is [string, Runnable] => typeof (entry[1] as Runnable | undefined)?.run === "function");

describe("a long body by keyboard", () => {
  test("PageDown and End scroll the focused body; the cue counts down and goes; Allow stays enabled", async () => {
    host = document.createElement("div");
    host.style.cssText = "width:680px;padding:16px;background:var(--bk-color-canvas);color:var(--bk-color-ink)";
    document.body.append(host);
    root = createRoot(host);
    flushSync(() =>
      root!.render(createElement(GoogleMailApprovalCard, {
        operation: "gmail.draft.send", tainted: false, sendAs: { address: "odysseus@example.com", displayName: "Odysseus" },
        message: longMessage, threadId: null, recipientMatches: matchesFor(longMessage), onAllow: () => {}, onDeny: () => {},
      })),
    );
    const region = host.querySelector<HTMLElement>("[data-google-body-region]")!;
    const more = () => Number(host!.querySelector<HTMLElement>("[data-google-more-lines]")?.dataset.googleMoreLines ?? 0);
    const allow = host.querySelector<HTMLElement>("[data-kit-approval-actions] [data-bk-button]")!;
    expect(region.scrollHeight, "the body is longer than its region").toBeGreaterThan(region.clientHeight + 100);
    const start = more();
    expect(start, "the cue counts what is below").toBeGreaterThan(10);
    region.focus();
    expect(document.activeElement).toBe(region);
    await userEvent.keyboard("{PageDown}");
    await expect.poll(() => region.scrollTop, { message: "PageDown scrolls the body" }).toBeGreaterThan(region.clientHeight / 2);
    await expect.poll(more, { message: "the cue counts down" }).toBeLessThan(start);
    expect(allow.getAttribute("aria-disabled"), "Allow is not gated on reading").toBeNull();
    await userEvent.keyboard("{End}");
    await expect.poll(() => region.scrollHeight - region.clientHeight - region.scrollTop, { message: "End reaches the end" }).toBeLessThanOrEqual(1);
    await expect.poll(more, { message: "the cue goes at the end" }).toBe(0);
    expect(host.querySelector("[data-google-more-lines]")).toBeNull();
    expect(allow.getAttribute("aria-disabled")).toBeNull();
  });
});

/** The baselines: each defining state at its width, in both themes. */
const BASELINES: [story: Runnable, name: string][] = [
  [stories.SendFullEnvelope as unknown as Runnable, "gmail-approval-send-full"],
  [stories.SendFullEnvelopeNarrow as unknown as Runnable, "gmail-approval-send-full-phone"],
  [stories.SendLongBodyNarrow as unknown as Runnable, "gmail-approval-send-long-phone"],
  [stories.SendHiddenCharsNarrow as unknown as Runnable, "gmail-approval-send-hidden-phone"],
  [stories.SendMarkdownLiteralNarrow as unknown as Runnable, "gmail-approval-send-markdown-phone"],
  [stories.SendSpacingLiteralNarrow as unknown as Runnable, "gmail-approval-send-spacing-phone"],
  [stories.DraftReplyNarrow as unknown as Runnable, "gmail-approval-draft-reply-phone"],
  [stories.DraftUpdate as unknown as Runnable, "gmail-approval-draft-update"],
  [stories.DraftDeleteNarrow as unknown as Runnable, "gmail-approval-draft-delete-phone"],
  [stories.Trash3Narrow as unknown as Runnable, "gmail-approval-trash-phone"],
  [stories.ModifyArchive12TaintedNarrow as unknown as Runnable, "gmail-approval-archive-tainted-phone"],
  [stories.ModifyMixedDelta as unknown as Runnable, "gmail-approval-mixed"],
  [stories.ModifyIrreversibleNarrow as unknown as Runnable, "gmail-approval-modify-irreversible-phone"],
];

describe("baselines", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const [story, name] of BASELINES) {
      test(`${name}${theme === "light" ? ", on paper" : ""}`, async () => {
        await runAt(story, name.endsWith("-phone"), theme, async (card) => {
          await expect(card).toMatchScreenshot(theme === "light" ? `${name}-light` : name, TOLERANCE);
        });
      });
    }
  }
});

describe("review captures", () => {
  test("every story is in the capture set, at both widths", () => {
    const names = STORIES.map(([name]) => name);
    expect(names.length, "the stories module has stories").toBeGreaterThan(20);
    expect(names.filter((name) => !name.endsWith("Narrow") && !names.includes(`${name}Narrow`)), "every story has its phone twin").toEqual([]);
  });

  for (const theme of ["dark", "light"] as const) {
    for (const [name, story] of STORIES) {
      const narrow = name.endsWith("Narrow");
      const base = narrow ? name.slice(0, -"Narrow".length) : name;
      test(`${base} at ${narrow ? 320 : 680}, ${theme === "light" ? "paper" : "dark"}`, async () => {
        await runAt(story, narrow, theme, async (card) => {
          const shot = (card.closest("[data-approval-host]") as HTMLElement | null) ?? card;
          await page.screenshot({ element: shot, path: `../../.vitest-attachments/google-mail-approval/${base}-${theme === "light" ? "paper" : "dark"}-${narrow ? 320 : 680}.png` });
        });
      });
    }
  }
});
