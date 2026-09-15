import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { activityFooter } from "../../fixtures/runs.js";
import { ScreenHeader } from "../../src/chrome/ScreenHeader.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Chrome/ScreenHeader",
  component: ScreenHeader,
  decorators: [stage],
  parameters: { stageWidth: 390 },
  args: { title: "Actions", variant: "title", meta: "6 waiting · 2 snoozed", metaTone: "teal" },
  argTypes: {
    variant: { control: "select", options: ["title", "nav", "hero"] },
    subTone: { control: "select", options: ["neutral", "teal", "red"] },
    trailingDot: { control: "select", options: [undefined, "amber", "teal", "red"] },
  },
});

/** A destination: serif display line, counts on the right, no rule underneath
 * because nothing is pushed on top of it. */
export const Title = meta.story({});

/** A pushed detail view. The back chevron and the bottom rule both belong to
 * `nav` and to nothing else — a rule under a destination title would say
 * something is scrolling beneath it when nothing is. */
export const Nav = Title.extend({
  args: { variant: "nav", title: "run #4c1", subtitle: "researcher · stalled", subTone: "red", meta: undefined },
});

/** A decision screen opens with a sentence, which is what `hero` is for. */
export const Hero = Title.extend({
  args: {
    variant: "hero",
    title: "Four things need you",
    description: "Two are edits, one is a fetch outside the envelope, and one is a question only you can answer.",
    meta: undefined,
  },
});

/** The subtitle's dot breathes when something is live. It is a 5px `mark`, the
 * smallest in the kit. */
export const LiveSubtitle = Title.extend({
  args: { title: "Activity", subtitle: activityFooter, subDot: "amber", subPulse: true, meta: undefined },
});

/** An avatar identifies a thread by who it is with. */
export const WithAvatar = Title.extend({
  args: { variant: "nav", avatarIcon: "agent", title: "Penelope", subtitle: "last spoke: 10 years ago", meta: undefined },
});

/**
 * The filament is the chat surface's mark and nothing else's. One gradient in
 * the whole kit, spent on saying "this screen is a conversation".
 */
export const Filament = Title.extend({
  args: { title: "Brain", subtitle: "connected · 4,812 docs", subTone: "teal", filament: true, meta: undefined },
});

/** Both trailing slots at once, which is where the meta/auto margin switch
 * matters: with a `meta` the trailing icon sits 10px after it, without one it
 * pushes itself to the far edge. */
export const TrailingSlots = Title.extend({
  args: { trailingIcon: "resolved", trailingDot: "amber" },
});

export const Wide = Title.extend({ parameters: wide });

/** `nav` draws the rule; the other two do not, and `divider: false` removes it
 * from `nav` as well. */
export const DividerBelongsToNav = meta.story({
  args: { variant: "nav", title: "run #4c1" },
  play: async ({ canvasElement }) => {
    const header = canvasElement.querySelector<HTMLElement>("div > div")!;
    await expect(getComputedStyle(header).borderBottomStyle).toBe("solid");
  },
});

/** A header is chrome, not a control. The back chevron has no handler in the
 * source and gets none here — navigation belongs to whatever owns the stack. */
export const Static = meta.story({
  args: { variant: "nav", title: "run #4c1" },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[role]")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector(".bk-control")).toBeNull();
  },
});
