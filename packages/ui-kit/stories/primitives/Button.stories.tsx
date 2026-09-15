import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { Button } from "../../src/primitives/Button.js";
import type { ButtonTone } from "../../src/types.js";
import { Row, stage, wide } from "../_stage.js";

const TONES: ButtonTone[] = ["primary", "affirm", "ghost", "quiet", "danger", "suggest"];
const SIZES = ["sm", "md", "lg"] as const;

const meta = preview.meta({
  title: "Primitives/Button",
  component: Button,
  decorators: [stage],
  args: {
    label: "Tie me to the mast",
    tone: "primary",
    size: "lg",
    icon: "confirm",
    effect: "write_policy",
    block: true,
    onClick: fn(),
  },
  argTypes: {
    tone: { control: "select", options: TONES },
    size: { control: "select", options: SIZES },
    icon: { control: "text" },
  },
});

/**
 * `effect` is the mono chip naming what the tap actually does. The design
 * system's rule is: no unnamed effects.
 *
 * Note the args set `size: "lg"` because `data-props` does. The component's own
 * runtime fallback is `"md"` — a `data-props` default is a story arg, never a
 * React default.
 */
export const Default = meta.story({});

export const Affirm = Default.extend({
  args: { label: "Approve the raft manifest", tone: "affirm", effect: "enqueue" },
});

export const Danger = Default.extend({
  args: { label: "Sail the Charybdis side", tone: "danger", icon: "policy", effect: "commit_route" },
});

/** A subtitle carries the consequence the label cannot fit. */
export const WithSubtitle = Default.extend({
  args: {
    label: "Pass Scylla",
    subtitle: "Circe: six of the crew, and the ship survives",
    tone: "suggest",
    icon: "suggestion",
    effect: "commit_route",
  },
});

/** Not `block`, so it sizes to its content and centres — the inline form used
 * in a row of two. */
export const Inline = Default.extend({
  args: { label: "Later", tone: "quiet", size: "sm", block: false, icon: "later", effect: undefined },
});

/**
 * Dimmed and inert: `opacity .45`, `pointer-events: none`, `aria-disabled`, and
 * out of the tab order. The design pairs a disabled control with a mono line
 * saying *why*, which is the caller's `subtitle`.
 */
export const Disabled = Default.extend({
  args: {
    disabled: true,
    tone: "affirm",
    label: "Sail for Ithaca",
    subtitle: "The raft is short two planks",
    effect: "depart",
  },
  play: async ({ canvas }) => {
    const button = await canvas.findByRole("button");
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(button).toHaveAttribute("tabindex", "-1");
  },
});

/**
 * Focus, hover and pressed, ported as designed.
 *
 * The rules live in `theme.css` because a pseudo-class cannot be expressed in a
 * React `style` object; the per-tone hover palette reaches them as `--hv-bg` /
 * `--hv-bd` / `--hv-fg` on this element's own inline style. `:focus-visible`,
 * not `:focus`, so a pointer tap leaves no ring behind — which is why this test
 * tabs to the button rather than clicking it.
 */
export const Focused = Default.extend({
  play: async ({ canvas, userEvent, args }) => {
    const button = await canvas.findByRole("button");
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await expect(button.matches(":focus-visible")).toBe(true);
    // Hover values are present to be read by the stylesheet, and they are the
    // tone's own step up — never another tone.
    await expect(button.style.getPropertyValue("--hv-bg")).toContain("--bk-button-hover-bg-primary");
    // The design's table: Enter and Space both activate a role="button".
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    await expect(args.onClick).toHaveBeenCalledTimes(2);
  },
});

/**
 * No handler, no interactive treatment: no role, no tab stop, no hover class.
 * "A row with no `onClick` is not focusable and gets no hover, so a static list
 * never pretends to be clickable." Easy to miss, and it is part of the API
 * contract rather than a detail.
 */
export const Static = Default.extend({
  args: { onClick: undefined, label: "Approved by Athena", tone: "ghost", effect: undefined },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    const root = canvasElement.querySelector("div > div")!;
    await expect(root.className).toBe("");
    await expect(root.getAttribute("tabindex")).toBeNull();
  },
});

/** Full width in a wide container. The label column takes the slack and the
 * effect chip stays pinned to the right. */
export const Wide = Default.extend({ parameters: wide });

export const TonesBySize = meta.story({
  parameters: { stageWidth: "none" },
  render: () => (
    <>
      {TONES.map((tone) => (
        <Row key={tone} caption={tone}>
          {SIZES.map((size) => (
            <Button key={size} tone={tone} size={size} block={false} label={size} icon="confirm" />
          ))}
        </Row>
      ))}
    </>
  ),
});

export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(await canvas.findByText("Tie me to the mast"));
    await expect(args.onClick).toHaveBeenCalled();
  },
});
