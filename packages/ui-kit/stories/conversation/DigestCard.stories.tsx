import preview from "#.storybook/preview";

import { digestFootnote, digestGroups } from "../../fixtures/events.js";
import { DigestCard } from "../../src/conversation/DigestCard.js";
import { stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Conversation/DigestCard",
  component: DigestCard,
  decorators: [stage],
  args: {
    title: "While you were away",
    subtitle: "23:00 → 06:40 · 14 runs",
    spend: "$0.40",
    groups: digestGroups,
    footnote: digestFootnote,
  },
  argTypes: { titleSize: { control: { type: "number", min: 14, max: 26, step: 1 } } },
});

/**
 * The briefing as a single chat block. Ordered by what it costs the READER —
 * settled things first, things that still need them last — so the card can be
 * abandoned halfway without missing a decision. The spend is on the card
 * because a brain that worked overnight spent money doing it.
 */
export const Default = meta.story({});

/** A quiet night: one group, nothing waiting. The shape is the same, which is
 * the point — the digest does not become a different card when it has less to
 * say. */
export const Quiet = Default.extend({
  args: {
    subtitle: "23:00 → 06:40 · 3 runs",
    spend: "$0.04",
    groups: [digestGroups[0]],
    footnote: "nothing needed you · next digest 04:30",
  },
});

/** No spend line, for a window that cost nothing. */
export const NoSpend = Default.extend({ args: { spend: "" } });

export const NoFootnote = Default.extend({ args: { footnote: "" } });

export const Wide = Default.extend({ parameters: wide });
