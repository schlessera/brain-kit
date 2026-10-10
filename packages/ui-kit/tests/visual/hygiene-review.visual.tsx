/// <reference types="@vitest/browser/matchers" />
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import * as cards from "../../stories/decisions/HygieneCard.stories.js";
import * as ends from "../../stories/decisions/HygieneEnd.stories.js";
import * as blockers from "../../stories/decisions/HygieneBlocker.stories.js";
const cases = {
  configuration: blockers.Configuration,
  brokenLink: cards.BrokenLink,
  requiredField: cards.RequiredField,
  manual: cards.Manual,
  applying: cards.Applying,
  stale: cards.Stale,
  refused: cards.Refused,
  checkFailed: cards.CheckFailed,
  connectionLost: cards.ConnectionLost,
  stillDetected: cards.StillDetected,
  fixed: cards.Fixed,
  compact: cards.Compact,
  complete: ends.Complete,
  noOpen: ends.NoOpenFindings,
};
for (const theme of ["dark", "light"])
  for (const width of [320, 1280])
    for (const [name, story] of Object.entries(cases)) {
      test(`hygiene ${name} ${theme} ${width}`, async () => {
        await page.viewport(width, 1000);
        await story.run({ globals: { theme } });
        expect(document.documentElement.dataset.theme).toBe(theme);
        const content = document.querySelector<HTMLElement>(
          "[data-hygiene-card], [data-hygiene-end], [data-hygiene-blocker]"
        )!;
        expect(content).toBeTruthy();
        const card = content.hasAttribute("data-hygiene-card") && content.getAttribute("role") !== "status"
          ? content.parentElement!.parentElement!
          : content;
        if (width === 1280) card.parentElement!.style.maxWidth = "none";
        if (content.getAttribute("role") !== "status" && content.hasAttribute("data-hygiene-card"))
          expect(card.textContent).toContain(name === "compact" ? "Open finding" : "why this one");
        expect(card.scrollWidth <= card.clientWidth + 1, "card content fits the approved widths").toBe(true);
        // A preceding file can leave the pointer over the wide card's header.
        // These references capture the resting state, never inherited hover.
        await userEvent.unhover(card);
        await expect(card).toMatchScreenshot(`hygiene-${name}-${theme}-${width}`);
      });
    }
