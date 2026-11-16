import preview from "#.storybook/preview";
import { expect, waitFor, within } from "storybook/test";

import { MarkupResultCard, type MarkupResultCardProps } from "../../src/images/MarkupResultCard.js";
import { RAFT_PATH } from "./_raft.js";

/* ── Receipt and fallback ─────────────────────────────────────────────── */

const LAYER = ".brain/scratch/markup/raft-at-ithaca.3f9a1c2e.markup.png";
const LAYER_PNG = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><ellipse cx="96" cy="34" rx="22" ry="22" fill="none" stroke="#FF3B30" stroke-width="3"/><path d="M120 80 L84 70" stroke="#FFD60A" stroke-width="3"/></svg>',
);
const receipt: MarkupResultCardProps = {
  imagePath: RAFT_PATH,
  markupPath: LAYER,
  width: 3024,
  height: 4032,
  bytes: 212 * 1024,
  marks: { pen: 0, arrow: 2, ellipse: 1, text: 1 },
  notes: ["move the raft here"],
  markupSrc: LAYER_PNG,
  matchesSource: true,
};

const card = preview.meta({ title: "Images/Markup receipt", component: MarkupResultCard, args: receipt });
export const Rendered = card.story({
  play: async ({ canvasElement }) => {
    const overlay = canvasElement.querySelector<HTMLImageElement>("img[data-markup-overlay]")!;
    await waitFor(() => expect(overlay.hasAttribute("data-markup-shown")).toBe(true));
    await expect(within(canvasElement).queryByText("markup not rendered")).toBeNull();
  },
});
export const NotRendered = card.story({ args: { markupSrc: undefined } });
export const ManyNotes = card.story({
  args: { notes: ["make the sail red", "move the raft here", "add oars", "lash the logs", "the bow"], marks: { pen: 1, arrow: 2, ellipse: 1, text: 5 } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/\+2 more$/)).toBeTruthy();
  },
});
export const LongPath = card.story({
  args: {
    imagePath: "projects/active/raft/photos/the-raft-moored-by-the-harbour-wall-at-ithaca-at-dawn.jpg",
    markupPath: ".brain/scratch/markup/the-raft-moored-by-the-harbour-wall-at-ithaca-at-dawn.3f9a1c2e.markup.png",
  },
});
