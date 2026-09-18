import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { queueItems } from "../../fixtures/actions.js";
import { Composer } from "../../src/chrome/Composer.js";
import { ScreenBody } from "../../src/chrome/ScreenBody.js";
import { ScreenHeader } from "../../src/chrome/ScreenHeader.js";
import { TabBar } from "../../src/chrome/TabBar.js";
import { QueueItemRow } from "../../src/rows/QueueItemRow.js";
import { knownContrastGap } from "../_stage.js";
import { PhoneFrame } from "../_phone.js";

/**
 * **Story furniture, not a shipped component (D16).**
 *
 * `PhoneFrame` is a device mock for presenting screens, not a thing the app
 * renders, so it lives in `stories/` beside the stage decorator. It is absent
 * from `src/index.ts`, absent from the npm tarball, and exempt from the token
 * rule for the same reason the design marks its own `browser-window.jsx` "raw
 * elements / hex / px by design".
 *
 * Its stories are here rather than under a component folder because there is no
 * component to document — what these show is the frame doing its one structural
 * job: a fixed-height column with a header that does not scroll, a body that
 * does, and chrome pinned to the bottom.
 */
const meta = preview.meta({
  title: "Chrome/PhoneFrame",
  component: PhoneFrame,
  parameters: {
    layout: "centered",
    // Every story here renders the same Actions screen, and that screen
    // contains the SUPERSEDED queue row — so every one of them inherits
    // design-feedback §4 without doing anything of its own.
    ...knownContrastGap(
      "The Actions screen includes the superseded queue row (opacity .7, ink-mute at 3.08:1). See design-feedback §4.",
    ),
  },
  args: { time: "6:40", showStatus: true, showHome: false },
  argTypes: { theme: { control: "select", options: ["dark", "paper"] } },
  render: (args) => (
    <PhoneFrame {...args}>
      <ScreenHeader title="Actions" meta="6 waiting · 2 snoozed" metaTone="teal" />
      <ScreenBody overflow="auto">
        {queueItems.map((item, i) => (
          <QueueItemRow key={`${item.subject}-${i}`} state={item.state} subject={item.subject} meta={item.meta} />
        ))}
      </ScreenBody>
      <Composer variant="plain" hint={undefined} />
      <TabBar items={undefined} active={1} />
    </PhoneFrame>
  ),
});

/** 6:40 on Ogygia, which is the hour the digest lands and the instant the whole
 * fixture world is pinned to. */
export const Dark = meta.story({});

/**
 * `theme="paper"` is the light theme, scoped to one device: the frame carries
 * `data-theme="light"`, so every token inside it resolves its paper half while
 * the Storybook around it stays dark. This is the nested case the switching
 * mechanism (`color-scheme` + `light-dark()`) exists to make trivial, and the
 * story is where it is visible: the same screen, re-grounded, no component
 * knowing which theme it is in.
 *
 * Until the 2026-09-18 drop this was a light bezel around DARK components —
 * ink at 1.11:1 on cream, design-feedback §8 — and carried a contrast
 * exception. The exception is gone: the a11y gate runs here at `'error'`.
 */
export const Paper = Dark.extend({
  args: { theme: "paper" },
  play: async ({ canvasElement }) => {
    const frame = canvasElement.querySelector<HTMLElement>('[data-theme="light"]');
    await expect(frame).not.toBeNull();
    // The proof that the subtree switched: the ink INSIDE the frame is the
    // paper ink whatever the document around it is doing (the light Vitest
    // project runs this story on a light document, the dark one on a dark).
    await expect(getComputedStyle(frame!).color).toBe("rgb(35, 31, 26)");
    await expect(getComputedStyle(frame!).colorScheme).toBe("light");
  },
});

export const WithHomeIndicator = Dark.extend({ args: { showHome: true } });

/** No status bar, for a screenshot that is about the screen rather than about
 * the phone. */
export const NoChrome = Dark.extend({ args: { showStatus: false } });

/** A smaller device, to check that a screen built at 390 survives 360. */
export const Small = Dark.extend({ args: { width: 360, height: 720 } });

/**
 * The frame's structural job, measured: the header and the bottom chrome hold
 * their height, the body absorbs the rest, and the frame stays exactly as tall
 * as it was told to be. A `min-height: auto` anywhere in that column would push
 * the tab bar off the bottom of the device.
 */
export const TheColumnHolds = meta.story({
  args: { width: 390, height: 844 },
  play: async ({ canvasElement }) => {
    const frame = canvasElement.querySelector<HTMLElement>('[style*="border-radius: 42px"]')!;
    await expect(Math.round(frame.getBoundingClientRect().height)).toBe(844 + 18);

    const screen = [...frame.children].at(-1) as HTMLElement;
    const [header, body, composer, tabs] = [...screen.children] as HTMLElement[];
    await expect(getComputedStyle(body).minHeight).toBe("0px");
    await expect(Math.round(body.getBoundingClientRect().height)).toBe(
      Math.round(
        screen.getBoundingClientRect().height -
          header.getBoundingClientRect().height -
          composer.getBoundingClientRect().height -
          tabs.getBoundingClientRect().height,
      ),
    );

    // The tab bar is still on screen, which is the failure this catches.
    await expect(tabs.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      frame.getBoundingClientRect().bottom + 1,
    );
  },
});

/** The frame adds no roles of its own; everything operable inside it belongs to
 * the screen it is framing. */
export const FrameAddsNoSemantics = meta.story({
  render: (args) => (
    <PhoneFrame {...args}>
      <TabBar items={[{ icon: "brain", label: "Chat", onClick: fn() }]} active={0} />
    </PhoneFrame>
  ),
  play: async ({ canvas }) => {
    await expect(await canvas.findAllByRole("tab")).toHaveLength(1);
    await expect(canvas.queryByRole("img")).toBeNull();
  },
});
