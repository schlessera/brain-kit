import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { backlinks } from "../../fixtures/files.js";
import { relatedPeople } from "../../fixtures/people.js";
import { RelatedFiles } from "../../src/conversation/RelatedFiles.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Conversation/RelatedFiles",
  component: RelatedFiles,
  decorators: [stage],
  args: {
    label: "Files read",
    meta: "4 of 4,812",
    items: backlinks.map((f) => ({ ...f, onClick: fn() })),
  },
});

/**
 * The expansion behind "4 files touched". Each row states WHY that file was
 * read — the one thing a bare list of paths cannot tell you, and the thing
 * that makes a wrong answer debuggable.
 */
export const Default = meta.story({});

/** The same component pointed at people rather than notes. Read-only either
 * way: opening a file is navigation, never an effect. */
export const People = Default.extend({
  args: { label: "Who this is about", meta: "4 of 31", items: relatedPeople.map((f) => ({ ...f })) },
});

/** No heading, for a list already introduced by a `Disclosure` summary. */
export const Bare = Default.extend({ args: { label: "", meta: "" } });

/** No reasons, which is what the component exists to prevent. Here so the
 * degraded shape is visible rather than theoretical. */
export const PathsOnly = Default.extend({
  args: { items: backlinks.map((f) => ({ path: f.path, score: f.score })) },
});

export const Wide = Default.extend({ parameters: wide });

export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const rows = await canvas.findAllByRole("button");
    await userEvent.click(rows[0]);
    await expect(args.items?.[0].onClick).toHaveBeenCalledTimes(1);

    rows[1].focus();
    await userEvent.keyboard(" ");
    await expect(args.items?.[1].onClick).toHaveBeenCalledTimes(1);
  },
});

/**
 * THE CONTRACT, PER ITEM. A list whose rows carry no callbacks has no roles,
 * no tab stops and no `.bk-row` — which is the common case, since most of the
 * time this list is evidence rather than navigation.
 */
export const Static = meta.story({
  args: { items: backlinks.map((f) => ({ ...f })) },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
  },
});

export const MixedGating = meta.story({
  args: {
    items: [
      { path: "decisions/scylla-or-charybdis.md", reason: "the file in question", onClick: fn() },
      { path: "knowledge/scylla.md", reason: "cited by it" },
    ],
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findAllByRole("button")).toHaveLength(1);
  },
});
