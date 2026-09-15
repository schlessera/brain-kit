import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { queueItems } from "../../fixtures/actions.js";
import { ScreenBody } from "../../src/chrome/ScreenBody.js";
import { ScreenHeader } from "../../src/chrome/ScreenHeader.js";
import { QueueItemRow } from "../../src/rows/QueueItemRow.js";
import { TabBar } from "../../src/chrome/TabBar.js";
import { stage } from "../_stage.js";

const meta = preview.meta({
  title: "Chrome/ScreenBody",
  component: ScreenBody,
  decorators: [stage],
  parameters: { stageWidth: 390 },
});

/**
 * **The one component in this kit the design does not have**, and the reason is
 * repetition: every assembled screen in the catalog retypes the same
 * `flex: 1; min-height: 0; overflow: hidden` container by hand, with only its
 * padding and gap differing. Nine screens, nine chances to drop the
 * `min-height: 0` — and a body without it does not scroll, it grows, which
 * reads as "the list is too long" rather than as a missing declaration.
 */
export const Default = meta.story({
  render: (args) => (
    <div style={{ height: 320, width: "100%", display: "flex", flexDirection: "column", border: "1px dashed #2a2d35" }}>
      <ScreenHeader title="Actions" meta="6 waiting" metaTone="teal" />
      <ScreenBody {...args}>
        {queueItems.slice(0, 3).map((item, i) => (
          <QueueItemRow key={`${item.subject}-${i}`} state={item.state} subject={item.subject} meta={item.meta} />
        ))}
      </ScreenBody>
      <TabBar />
    </div>
  ),
});

/** `overflow: auto` is what a real screen wants; the design's mockups use
 * `hidden` because a static mockup has nothing to scroll. */
export const Scrolls = Default.extend({ args: { overflow: "auto" } });

/** The two props that vary per screen in the design: 2-20px of padding and
 * 4-14px of gap. The three declarations that make it scroll do not vary and are
 * not props. */
export const Roomy = Default.extend({ args: { padding: "20px 24px", gap: 14 } });

/**
 * The whole point, measured. In a fixed-height column with a header above and a
 * tab bar below, the body must take exactly the space left over — not grow past
 * it, which is what `min-height: auto` would do with this much content.
 */
export const FitsBetweenTheChrome = meta.story({
  render: Default.input.render,
  play: async ({ canvasElement }) => {
    const frame = canvasElement.querySelector<HTMLElement>('[style*="height: 320px"]')!;
    const [header, body, tabs] = [...frame.children] as HTMLElement[];
    await expect(getComputedStyle(body).minHeight).toBe("0px");

    const f = frame.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    await expect(Math.round(b.height)).toBe(
      Math.round(f.height - header.getBoundingClientRect().height - tabs.getBoundingClientRect().height - 2),
    );
    // And the frame itself is still 320 tall: nothing pushed it open.
    await expect(Math.round(f.height)).toBe(320);
  },
});

/** A container, not a control. */
export const Static = meta.story({
  render: (args) => <ScreenBody {...args}>nothing here</ScreenBody>,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[role]")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
  },
});
