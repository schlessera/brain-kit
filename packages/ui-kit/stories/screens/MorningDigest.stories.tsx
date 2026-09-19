import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { actions } from "../../fixtures/actions.js";
import { digestFootnote, digestStats, overnight, overnightSpend, today } from "../../fixtures/events.js";
import { tabs } from "../../fixtures/files.js";
import { ScreenBody } from "../../src/chrome/ScreenBody.js";
import { ScreenHeader } from "../../src/chrome/ScreenHeader.js";
import { TabBar } from "../../src/chrome/TabBar.js";
import { ActionCard } from "../../src/decisions/ActionCard.js";
import { ScheduleList } from "../../src/blocks/ScheduleList.js";
import { StatTiles } from "../../src/blocks/StatTiles.js";
import { TimelineList } from "../../src/blocks/TimelineList.js";
import { Callout } from "../../src/primitives/Callout.js";
import { Label } from "../../src/primitives/Label.js";
import { phone } from "../_phone.js";
import { overflowing, unreachable } from "../_stage.js";

/**
 * §11.1 — MORNING DIGEST. *"The destination behind 'What's new?' — with the
 * overnight work stated as fact before anything asks for a decision."*
 *
 * The screen's argument is its ORDER, and the order is the design's rule about
 * escalation made into a layout: four numbers, then what happened while you
 * slept, then what is coming, and only after all of that a card that wants
 * something from you. The one `ActionCard` is `kind="fyi"` — the kind that
 * asks for nothing — and it is the last thing above the banner.
 *
 * Nothing here is new. Every figure comes from `events.ts`, the card is the
 * `fyi` entry `actions.ts` already carries, and the two section labels take
 * their metas from the data beneath them rather than from a typed string: the
 * "Overnight" spend is the same `$0.40` as the spend tile three rows above it,
 * and "Today" reports the group's own item count.
 *
 * The one deviation from §11.1's literal text is that label: the catalog types
 * `meta="2 items"` and the schedule group says three. The group is right and
 * the catalog is stale, so the label reads the group.
 */
const on = { card: fn() };

const fyi = actions.find((a) => a.kind === "fyi")!;

const meta = preview.meta({
  title: "Screens/Morning digest",
  component: ScreenBody,
  decorators: [phone({ time: "06:40" })],
  parameters: { layout: "centered" },
});

export const MorningDigest = meta.story({
  render: () => (
    <>
      <ScreenHeader variant="title" title="This morning" meta="06:40" trailingIcon="digest" />
      <ScreenBody padding="4px 16px 8px" gap={11} overflow="auto">
        <StatTiles tiles={digestStats} minTile={96} />

        <Label text="Overnight" icon="activity" meta={overnightSpend} />
        <TimelineList items={overnight} timeWidth={44} />

        <Label text="Today" icon="calendar" meta={today[0]!.meta} />
        <ScheduleList groups={today} timeWidth={44} />

        <ActionCard
          kind="fyi"
          title={fyi.title}
          body={fyi.body}
          rightMeta={fyi.rightMeta}
          rightMetaTone={fyi.rightMetaTone}
          footMeta={fyi.footMeta}
          footDot="amber"
          footPulse
          chevron
          onClick={on.card}
        />

        <Callout variant="banner" tone="teal" icon="resolved" mono text={digestFootnote} />
      </ScreenBody>
      <TabBar items={tabs.map((t) => ({ ...t, onClick: fn() }))} active={1} />
    </>
  ),
});

/** Nothing crosses the phone's edges. See `Screens/Weekly review` for why this
 * is measured rather than inspected. */
export const NothingEscapesTheFrame = MorningDigest.extend({
  play: async ({ canvasElement }) => {
    const frame = canvasElement.firstElementChild as HTMLElement;
    await expect(overflowing(frame)).toEqual([]);
    await expect(unreachable(frame.querySelector(".bk-screen-body")!)).toEqual([]);
  },
});

/**
 * THE SCREEN'S ARGUMENT IS ITS ORDER, so the order is what gets asserted.
 *
 * Facts, then the night, then the day, then the one card — and the card asks
 * for nothing, which is the whole claim in the design's own sentence. A screen
 * that put the decision above the facts would still render, still pass every
 * component's own stories, and still be the wrong screen.
 */
export const FactsBeforeAnythingAsks = MorningDigest.extend({
  play: async ({ canvas, canvasElement }) => {
    const order = [
      await canvas.findByText(digestStats[0]!.label),
      await canvas.findByText("Overnight"),
      await canvas.findByText(overnight[0]!.title),
      // "Today" is on the screen twice — the section label and the schedule
      // group's own day heading — and document order makes the first the label.
      (await canvas.findAllByText("Today"))[0]!,
      await canvas.findByText(today[0]!.items[0]!.title),
      await canvas.findByText(fyi.title),
      await canvas.findByText(digestFootnote),
    ];
    for (let i = 1; i < order.length; i += 1) {
      // eslint-disable-next-line no-bitwise -- Node.DOCUMENT_POSITION_FOLLOWING
      await expect(Boolean(order[i - 1]!.compareDocumentPosition(order[i]!) & 4)).toBe(true);
    }

    // The only card on the screen is the kind that asks for nothing: no button,
    // no approve/deny pair, one chevron to somewhere else.
    await expect(canvasElement.querySelectorAll('[role="button"]').length).toBeGreaterThan(0);
    await expect(await canvas.findByText(fyi.rightMeta!)).toBeTruthy();
  },
});

/**
 * ONE FIGURE, TWO PLACES. The spend tile and the "Overnight" label are the same
 * number, and it is `usd(overnightSpendCents)` in both — a screen that states a
 * figure twice is a screen that can contradict itself.
 */
export const TheSpendAgreesWithItself = MorningDigest.extend({
  play: async ({ canvas }) => {
    const shown = await canvas.findAllByText(overnightSpend);
    await expect(shown).toHaveLength(2);
  },
});
