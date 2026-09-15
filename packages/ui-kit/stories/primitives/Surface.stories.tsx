import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { Chip } from "../../src/primitives/Chip.js";
import { Meter } from "../../src/primitives/Meter.js";
import { PathRef } from "../../src/primitives/PathRef.js";
import { Surface } from "../../src/primitives/Surface.js";
import type { Emphasis, Tone } from "../../src/types.js";
import { ROW_RING, ring, Row, stage, wide } from "../_stage.js";

const EMPHASIS: Emphasis[] = ["hairline", "strong", "bold", "dashed", "none"];
const TONES: Tone[] = ["neutral", "amber", "teal", "red", "gold", "purple", "blue"];

const body = (
  <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
    <Meter label="supplies" value={38} valueText="9 days / 20" tone="teal" />
    <Meter label="crew" value={50} valueText="6 of 12" tone="red" />
  </div>
);

const meta = preview.meta({
  title: "Primitives/Surface",
  component: Surface,
  decorators: [stage],
  args: { label: "Route home", meta: "3 legs", emphasis: "hairline", pad: 12, radius: 14, children: body },
  argTypes: {
    tone: { control: "select", options: TONES },
    emphasis: { control: "select", options: EMPHASIS },
    pad: { control: { type: "number", min: 0, max: 20, step: 1 } },
    radius: { control: { type: "number", min: 8, max: 26, step: 1 } },
    labelIcon: { control: "text" },
  },
});

/** hairline: an inert container. */
export const Default = meta.story({});

/** strong: interactive. The border steps up from the in-card hairline to the
 * card edge. */
export const Interactive = Default.extend({
  args: { emphasis: "strong", onClick: fn(), labelIcon: "graph" },
  // Clicking the header label, not the root: the click has to reach the
  // Surface by bubbling from something a finger would actually land on.
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(await canvas.findByText("Route home"));
    await expect(args.onClick).toHaveBeenCalled();
  },
});

/** bold: needs a decision. `bold` implies the tone tint, which is why this card
 * is not the plain surface colour. */
export const NeedsDecision = Default.extend({
  args: {
    emphasis: "bold",
    tone: "amber",
    label: "Scylla or Charybdis",
    meta: "today",
    labelIcon: "approval",
  },
});

/** dashed: stale, or an unverified premise. */
export const Unverified = Default.extend({
  args: { emphasis: "dashed", tone: "gold", label: "Oracle at Aeaea", meta: "unverified", labelIcon: "unverified" },
});

/** No label at all: the header row disappears and the body takes the full pad. */
export const Unlabelled = Default.extend({ args: { label: undefined, meta: undefined } });

/**
 * A Surface holding other primitives — the composition that exercises the port's
 * top layout risk. In the DC runtime each child sat inside an extra
 * `div.sc-host`; here each child's own root is the flex item, which is why the
 * `PathRef` chips shrink-wrap and the `Meter` fills.
 */
export const Nested = meta.story({
  args: {
    label: "Open loops",
    meta: "4",
    labelIcon: "steps",
    tone: "teal",
    children: (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
        <PathRef text="voyage/scylla-vs-charybdis.md" icon="file" />
        <PathRef text="people/penelope.md" icon="file" meta="overdue" />
        <Meter label="supplies" value={38} valueText="9 days / 20" />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Chip label="#ithaca" variant="soft" tone="teal" />
          <Chip label="#crew" variant="soft" tone="amber" />
          <Chip label="#gods" variant="soft" tone="purple" />
        </div>
      </div>
    ),
  },
});

export const Wide = Default.extend({ parameters: wide });

export const EmphasisByTone = meta.story({
  parameters: { stageWidth: "none" },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%" }}>
      {EMPHASIS.map((emphasis) => (
        <Row key={emphasis} caption={emphasis}>
          <div style={{ flex: 1, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {TONES.map((tone) => (
              <div key={tone} style={{ width: 132 }}>
                <Surface emphasis={emphasis} tone={tone} label={tone} pad={10}>
                  <Meter value={62} tone={tone} variant="bar" />
                </Surface>
              </div>
            ))}
          </div>
        </Row>
      ))}
    </div>
  ),
});

/**
 * THE CONTRACT, wave 1b, and this is the component the −2 focus offset was
 * written for. A `Surface` sets `overflow: hidden`, so a ring at +2 on a
 * Surface nested inside another Surface — which is most of this kit — is drawn
 * outside the inner box and clipped away entirely. The ring is correct in the
 * stylesheet, correct in the computed style, and invisible on screen, which is
 * the worst of the three ways to get this wrong.
 *
 * The role is gated on `onClick`, NOT on `emphasis="strong"`. Emphasis is
 * paint; a handler is behaviour; a card that looks tappable and is not is
 * exactly the failure the gating rule exists to prevent.
 */
export const Operable = Default.extend({
  args: { emphasis: "strong", label: "Route home", onClick: fn() },
  play: async ({ canvas, canvasElement, userEvent, args }) => {
    const card = await canvas.findByRole("button");
    await expect(card.className).toBe("bk-row");

    await userEvent.tab();
    await expect(document.activeElement).toBe(card);
    await expect(ring(card)).toEqual(ROW_RING);

    await userEvent.keyboard("{Enter}");
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    await expect(args.onClick).toHaveBeenCalledTimes(2);

    // Hover is the tone one step up, in the tone's OWN hue. Neutral has no hue
    // to step, so it resolves to `raised` — D20's literal value.
    await expect(canvasElement.querySelector<HTMLElement>(".bk-row")!.style.getPropertyValue("--hv-bg")).toBe(
      "var(--bk-surface-hover-tint-neutral)",
    );
  },
});

/** A toned card keeps its hue on hover. "A control that looks like something
 * else on hover has lied about what it does." */
export const OperableToned = Operable.extend({
  args: { tone: "amber", tint: true },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector<HTMLElement>(".bk-row")!.style.getPropertyValue("--hv-bg")).toBe(
      "var(--bk-surface-hover-tint-amber)",
    );
  },
});

/** THE GATE. `emphasis="strong"` is the design's word for "interactive" and it
 * still buys no role, because paint is not behaviour. */
export const StrongButStatic = Default.extend({
  args: { emphasis: "strong", label: "Route home" },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row, .bk-control")).toBeNull();
  },
});
