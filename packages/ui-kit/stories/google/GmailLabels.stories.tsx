import preview from "#.storybook/preview";
import { expect, waitFor } from "storybook/test";

import { L } from "../../fixtures/gmail.js";
import { GmailLabels } from "../../src/google/GmailLabels.js";
import { stage } from "../_stage.js";
import { desktop, holdsTogether, narrow, widthOf } from "./_gmail.js";

/**
 * A Gmail thread's labels (#4209, ruling G5): system labels as words, UNREAD
 * and STARRED left to the flags, every label the same neutral chip, three
 * chips and then "+N", which expands in place and moves focus to the first
 * label it revealed.
 */
const meta = preview.meta({
  title: "Gmail/GmailLabels",
  component: GmailLabels,
  decorators: [stage],
  args: { labels: [L.inbox, L.family, L.ithaca] },
});

const names = (root: HTMLElement) => [...root.querySelectorAll("[data-gmail-label]")].map((n) => n.textContent);

/** System labels only: words, not ids; UNREAD, STARRED and a superstar are flags, not chips. */
export const SystemOnly = meta.story({
  args: { labels: [L.unread, L.inbox, L.starred, L.yellowStar, L.important] },
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(names(canvasElement)).toEqual(["Inbox", "Important"]);
  },
});
export const SystemOnlyNarrow = SystemOnly.extend({ ...narrow });

/** The owner's labels after the system ones, in the payload's order. */
export const UserLabels = meta.story({
  args: { labels: [L.family, L.inbox, L.ithaca] },
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(names(canvasElement)).toEqual(["Inbox", "Family", "Ithaca"]);
  },
});
export const UserLabelsNarrow = UserLabels.extend({ ...narrow });

/** Seven labels: three chips and "+4". */
export const Overflow = meta.story({
  args: { labels: [L.inbox, L.important, L.family, L.ithaca, L.voyage, L.suitors, L.raft] },
  ...desktop,
  play: async ({ canvas, canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(names(canvasElement)).toEqual(["Inbox", "Important", "Family"]);
    await expect(canvas.getByRole("button", { name: "Show 4 more labels" })).toHaveTextContent("+4");
  },
});
export const OverflowNarrow = Overflow.extend({ ...narrow });

/** "+4" pressed from the keyboard: every label shows, and focus lands on the first one it revealed. */
export const OverflowExpanded = meta.story({
  args: Overflow.input.args,
  ...desktop,
  play: async ({ canvas, canvasElement, userEvent, parameters }) => {
    const more = canvas.getByRole("button", { name: "Show 4 more labels" });
    more.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Ithaca"));
    await expect(document.activeElement?.getAttribute("data-gmail-label")).toBe("Label_2");
    await expect(names(canvasElement)).toEqual(["Inbox", "Important", "Family", "Ithaca", "Voyage", "Suitors", "Raft"]);
    await expect(canvas.queryByRole("button")).toBeNull();
    await holdsTogether(canvasElement, widthOf(parameters));
  },
});
export const OverflowExpandedNarrow = OverflowExpanded.extend({ ...narrow });

/**
 * A name the host escaped stays escaped: an override in the owner's label
 * name arrives as the visible text `\u{202E}` and cannot turn the chip
 * around. A name the host withheld shows its id, in mono. A long name wraps
 * inside its chip.
 */
export const EscapedName = meta.story({
  args: { labels: [L.escaped, L.withheld, L.estate], limit: 5 },
  ...desktop,
  play: async ({ canvasElement, parameters }) => {
    await holdsTogether(canvasElement, widthOf(parameters));
    await expect(names(canvasElement)).toEqual(["Suitors \\u{202E}gol", "Label_8", "Estate · herds and orchards"]);
    await expect(getComputedStyle(canvasElement.querySelector("[data-gmail-label='Label_8']")!).fontFamily).toContain("JetBrains Mono");
  },
});
export const EscapedNameNarrow = EscapedName.extend({ ...narrow });
