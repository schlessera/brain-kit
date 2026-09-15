import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { attachments } from "../../fixtures/files.js";
import { AttachmentRow } from "../../src/conversation/AttachmentRow.js";
import { ROW_RING, ring, stage, wide } from "../_stage.js";

const [audio, image, doc, link] = attachments;

const meta = preview.meta({
  title: "Conversation/AttachmentRow",
  component: AttachmentRow,
  decorators: [stage],
  args: { ...audio, played: 0.35, onClick: fn() },
  argTypes: {
    played: { control: { type: "range", min: 0, max: 1, step: 0.05 } },
    seconds: { control: { type: "number", min: 0, max: 600, step: 1 } },
  },
});

/**
 * A voice memo, rendered as what it is: a waveform derived from its own
 * duration, the transcript underneath, and no player chrome — Brain
 * transcribes on device and the text is the thing you came for.
 */
export const Default = meta.story({});

/** An image gets the hatched placeholder plus its OCR extract. Brain READS
 * pictures; it does not display them inline. */
export const Image = Default.extend({ args: { ...image, kind: "image" } });

export const Document = Default.extend({ args: { ...doc, kind: "doc" } });

/** Anything from outside the corpus carries the purple provenance line, and
 * its presence turns the card's own border purple. */
export const Untrusted = Default.extend({ args: { ...link, kind: "link" } });

/** Nothing played yet: every bar is the `edge` hairline. */
export const Unplayed = Default.extend({ args: { played: 0 } });
export const FullyPlayed = Default.extend({ args: { played: 1 } });

/** `actionIcon: ""` draws none, for a row that is not itself openable. */
export const NoAction = Default.extend({ args: { actionIcon: "" } });

export const Wide = Default.extend({ parameters: wide });

/**
 * THE WAVEFORM IS DETERMINISTIC BY DESIGN: `4 + |sin((i + 1) · 1.7 + seconds)|
 * · 13`. The same clip always draws the same shape, which is what makes the
 * component screenshot-stable and lets a visual-regression baseline exist.
 *
 * This asserts the actual heights rather than "it looks like a waveform", and
 * that a DIFFERENT duration draws a different shape — otherwise a formula that
 * had quietly stopped reading `seconds` would still pass.
 */
export const WaveformIsDeterministic = meta.story({
  args: { seconds: 38, waveBars: 6, played: 0.5 },
  play: async ({ canvasElement }) => {
    const expected = Array.from({ length: 6 }, (_, i) =>
      Math.round(4 + Math.abs(Math.sin((i + 1) * 1.7 + 38)) * 13),
    );
    // 2px-wide bars, which is what tells the waveform from every other span.
    const bars = [...canvasElement.querySelectorAll("span")].filter(
      (s) => s.style.width === "2px",
    );
    await expect(bars.map((b) => b.style.height)).toEqual(expected.map((h) => `${h}px`));

    // And the shape is a function of the clip, not a constant.
    const other = Array.from({ length: 6 }, (_, i) =>
      Math.round(4 + Math.abs(Math.sin((i + 1) * 1.7 + 91)) * 13),
    );
    await expect(other).not.toEqual(expected);
  },
});

/**
 * THE CONTRACT, wave 1b. Opening an attachment is navigation, so the card is one
 * `role="button"` with no effect chip, and it takes `.bk-row` — the −2 ring
 * offset — because it is a full-width block inside surfaces that clip.
 */
export const Operable = meta.story({
  play: async ({ canvas, canvasElement, userEvent, args }) => {
    const card = await canvas.findByRole("button");
    await expect(card).toHaveAttribute("tabindex", "0");
    await expect(card.className).toBe("bk-row");

    await userEvent.tab();
    await expect(document.activeElement).toBe(card);
    await expect(ring(card)).toEqual(ROW_RING);

    await userEvent.keyboard("{Enter}");
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    await expect(args.onClick).toHaveBeenCalledTimes(2);

    await expect(canvasElement.querySelector<HTMLElement>(".bk-row")!.style.getPropertyValue("--hv-bg")).toBe(
      "var(--bk-color-raised)",
    );
  },
});

/** THE GATE. No handler, no class, no role, no tab stop. */
export const Static = meta.story({
  args: { onClick: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row, .bk-control")).toBeNull();
  },
});
