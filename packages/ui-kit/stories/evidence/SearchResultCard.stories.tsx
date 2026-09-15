import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { query, searchHits } from "../../fixtures/search.js";
import { SearchResultCard } from "../../src/evidence/SearchResultCard.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Evidence/SearchResultCard",
  component: SearchResultCard,
  decorators: [stage],
  args: { view: "ready", ...searchHits[0], onClick: fn() },
  argTypes: {
    view: { control: "select", options: ["ready", "loading", "empty", "error"] },
    icon: { control: "text" },
  },
});

/**
 * The score is shown because the user is entitled to know how confident the
 * retrieval was. The snippet arrives pre-split as `before` / `highlight` /
 * `after` rather than as a string with markup in it — a component that took
 * HTML would be one that could be made to render anything the corpus contains.
 *
 * The design's own defaults for this card name a real company and quote its
 * day rate, so nothing here comes from them.
 */
export const Default = meta.story({});

/** The three results the screen actually shows for "{query}" — nine were
 * found. Descending score, which is the only order a hybrid search can
 * defend. */
export const ResultSet = meta.story({
  parameters: { docs: { description: { story: query } } },
  render: (args) => (
    <>
      {searchHits.map((hit) => (
        <SearchResultCard {...args} key={hit.path} {...hit} />
      ))}
    </>
  ),
});

/** A hit in an image, which changes the glyph and nothing else. */
export const ImageHit = Default.extend({
  args: { icon: "image", path: "omens/ionian-approach.png", score: "0.62" },
});

export const Wide = Default.extend({ parameters: wide });

/* ── The Placeholder delegation, all four states ───────────────────────── */

export const Loading = Default.extend({ args: { view: "loading" } });

/** "No matches" with the corpus size and a suggestion, which is the design's
 * rule: an empty state says what would be here and why it isn't. */
export const Empty = Default.extend({ args: { view: "empty" } });

/** The error affordance here is "Re-index", not "Retry" — the failure is the
 * index, and the copy names it. */
export const ErrorState = Default.extend({ args: { view: "error", onStateAction: fn() } });

export const EmptyOverridden = Default.extend({
  args: {
    view: "empty",
    stateMessage: "Nothing in the corpus about that",
    stateDetail: "Searched 4,812 documents · 0.2s",
  },
});

export const Reindexed = ErrorState.extend({
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(await canvas.findByText("Re-index"));
    await expect(args.onStateAction).toHaveBeenCalled();
  },
});

export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const card = await canvas.findByRole("button");
    await userEvent.click(card);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    card.focus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onClick).toHaveBeenCalledTimes(2);
  },
});

/** THE CONTRACT. A result listed for reference — in a digest, say — carries no
 * role, no tab stop and no hover. */
export const Static = meta.story({
  args: { onClick: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
  },
});
