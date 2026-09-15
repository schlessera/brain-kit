import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { dismissReasons } from "../../fixtures/actions.js";
import { Button } from "../../src/primitives/Button.js";
import { ChoiceOption } from "../../src/rows/ChoiceOption.js";
import { BottomSheet } from "../../src/chrome/BottomSheet.js";
import { stage } from "../_stage.js";

const meta = preview.meta({
  title: "Chrome/BottomSheet",
  component: BottomSheet,
  decorators: [stage],
  parameters: { stageWidth: 390 },
  args: {
    title: "Why not?",
    subtitle: "One tap. This is what teaches Brain to stop asking.",
  },
});

/**
 * A modal surface for one decision. The sheet renders no scrim and traps no
 * focus: both belong to whatever decided it is open, and this component is a
 * surface rather than a dialog controller.
 */
export const Default = meta.story({
  render: (args) => (
    <BottomSheet {...args}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {dismissReasons.map((reason) => (
          <ChoiceOption key={reason} title={reason} onClick={fn()} />
        ))}
      </div>
    </BottomSheet>
  ),
});

/** Header and nothing else — which is the design's own default render, and the
 * shape the DC parity harness compares against. */
export const HeaderOnly = meta.story({});

/** Title only. Without a subtitle the title's own bottom margin widens, which
 * is the source's `p.subtitle ? 4 : 12`. */
export const TitleOnly = Default.extend({ args: { subtitle: undefined } });

/** An icon and a mono meta line: the sheet as a receipt for what is about to
 * happen, rather than as a question. */
export const WithMeta = Default.extend({
  args: { icon: "later", title: "Snooze until", meta: "3 waiting", subtitle: undefined },
});

/** No header at all — the sheet is the content, which is what a share intake
 * wants. */
export const Bare = meta.story({
  args: { title: undefined, subtitle: undefined },
  render: (args) => (
    <BottomSheet {...args}>
      <Button label="Send to Brain" tone="primary" onClick={fn()} />
    </BottomSheet>
  ),
});

/**
 * `docked` is the whole component: absolute against the nearest positioned
 * ancestor rather than in flow. In a `PhoneFrame` that is the screen; here it
 * is a box standing in for one, so the story shows the positioning rather than
 * describing it.
 */
export const Docked = meta.story({
  args: { docked: true },
  render: (args) => (
    <div style={{ position: "relative", height: 300, width: "100%", overflow: "hidden" }}>
      <BottomSheet {...args}>
        <Button label="Approve this edit" tone="primary" effect="enqueue" onClick={fn()} />
      </BottomSheet>
    </div>
  ),
  play: async ({ canvas, canvasElement }) => {
    const sheet = await canvas.findByText("Why not?");
    const root = sheet.closest("div")!.parentElement!;
    await expect(getComputedStyle(root).position).toBe("absolute");
    // Docked means pinned to the bottom of its container, not floating in it.
    const container = canvasElement.querySelector<HTMLElement>('[style*="position: relative"]')!;
    await expect(Math.abs(root.getBoundingClientRect().bottom - container.getBoundingClientRect().bottom)).toBeLessThan(
      1.5,
    );
  },
});

/** Undocked it is `static` and takes part in normal flow, which is how a story
 * shows one without a frame around it. */
export const InFlow = meta.story({
  play: async ({ canvas }) => {
    const sheet = await canvas.findByText("Why not?");
    await expect(getComputedStyle(sheet.closest("div")!.parentElement!).position).toBe("static");
  },
});

/** The sheet itself is chrome: it adds no roles of its own, and everything
 * operable inside it belongs to whatever was passed in. */
export const Static = meta.story({
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[role]")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
  },
});
