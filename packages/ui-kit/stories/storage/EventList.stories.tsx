import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { CLUSTERED_EVENTS, EVENTS } from "../../fixtures/storage-history.js";
import { EventList } from "../../src/storage/EventList.js";
import { desktop, frame, openAt, phone } from "./_history.js";

/**
 * `EventList` (#4543): the numbered legend under the history chart. Every
 * number is listed on its own, even when the chart merged its markers into
 * one `2–4` box; the tone only tints the number's edge.
 */
const meta = preview.meta({
  title: "Storage/EventList",
  component: EventList,
  decorators: [frame],
  args: { events: EVENTS },
});

type Ctx = { canvasElement: HTMLElement; globals: { viewport?: unknown }; parameters: { viewportWidth?: number } };

async function listed(ctx: Ctx, numbers: number[]) {
  await openAt(ctx.parameters.viewportWidth ?? 320, ctx.globals);
  const rows = [...ctx.canvasElement.querySelectorAll<HTMLLIElement>("ol li")];
  await expect(rows.map((r) => Number(r.dataset.event))).toEqual(numbers);
  for (const row of rows) {
    // The number is in the row as words for assistive technology, and drawn for the eye.
    await expect(row.textContent).toContain(`Event ${row.dataset.event}: `);
    await expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(ctx.canvasElement.getBoundingClientRect().right + 1);
  }
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
}

/** One event. */
export const One = meta.story({ ...phone, args: { events: EVENTS.slice(0, 1) }, play: (ctx) => listed(ctx, [1]) });
export const OneDesktop = One.extend({ ...desktop });

/** Three events, in number order. */
export const Three = meta.story({ ...phone, play: (ctx) => listed(ctx, [1, 2, 3]) });
export const ThreeDesktop = Three.extend({ ...desktop });

/** Four events the chart merges into `1` and `2–4`: the list keeps all four. */
export const Clustered = meta.story({ ...phone, args: { events: CLUSTERED_EVENTS }, play: (ctx) => listed(ctx, [1, 2, 3, 4]) });

/** No events: nothing renders, rather than an empty list. */
export const None = meta.story({
  ...phone,
  args: { events: [] },
  play: async ({ canvasElement, globals, parameters }) => {
    await openAt((parameters.viewportWidth as number | undefined) ?? 320, globals);
    await expect(canvasElement.querySelector("ol")).toBeNull();
  },
});
export const NoneDesktop = None.extend({ ...desktop });

/** Without colour the numbers and words carry every row. */
export const Greyscale = meta.story({
  ...phone,
  args: { events: CLUSTERED_EVENTS },
  render: (args) => (
    <div style={{ filter: "grayscale(1)" }}>
      <EventList {...args} />
    </div>
  ),
  play: (ctx) => listed(ctx, [1, 2, 3, 4]),
});
