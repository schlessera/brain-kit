import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { launchers } from "../../fixtures/files.js";
import { notificationRules } from "../../fixtures/events.js";
import { snoozeOptions } from "../../fixtures/actions.js";
import { Surface } from "../../src/primitives/Surface.js";
import { ListRow } from "../../src/rows/ListRow.js";
import type { ListRowVariant, Tone } from "../../src/types.js";
import { Row, stage, wide } from "../_stage.js";

const VARIANTS: ListRowVariant[] = ["group", "card", "launcher", "plain"];
const TONES: Tone[] = ["neutral", "amber", "teal", "red", "gold", "purple", "blue"];

const meta = preview.meta({
  title: "Rows/ListRow",
  component: ListRow,
  decorators: [stage],
  args: {
    title: "First light tomorrow",
    subtitle: "Resolves to a real time, not a guess",
    value: "05:30",
    icon: "sunrise",
    iconTone: "teal",
    variant: "card",
    onClick: fn(),
  },
  argTypes: {
    variant: { control: "select", options: VARIANTS },
    iconTone: { control: "select", options: TONES },
    valueTone: { control: "select", options: TONES },
    toggleTone: { control: "select", options: ["amber", "teal", "purple"] },
    icon: { control: "text" },
  },
});

export const Default = meta.story({});

/** The four containers. `group` has no shell of its own — it expects a
 * `Surface` around it, which is what the `Grouped` story shows. */
export const Variants = meta.story({
  render: (args) => (
    <>
      {VARIANTS.map((variant) => (
        <Row key={variant} caption={variant}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <ListRow {...args} variant={variant} />
          </div>
        </Row>
      ))}
    </>
  ),
});

/** Selected is teal, and teal means the choice is the user's. */
export const Selected = Default.extend({ args: { selected: true } });

/** The four snooze options, which are the design's example of a row whose
 * trailing value is the rule it resolves to rather than a label. */
export const Grouped = meta.story({
  render: (args) => (
    <Surface label="Later" labelIcon="later" pad={0}>
      {snoozeOptions.map((option, i) => (
        <ListRow
          {...args}
          key={option.label}
          variant="group"
          icon={option.icon}
          iconTone="neutral"
          title={option.label}
          subtitle={undefined}
          value={option.resolvesTo}
          last={i === snoozeOptions.length - 1}
        />
      ))}
    </Surface>
  ),
});

/** One row per notification kind, each with the switch that governs it. The
 * switch is decorative: the ROW is the hit target, which is why it grows no
 * competing one of its own. */
export const WithToggles = meta.story({
  render: (args) => (
    <Surface label="What pushes" labelIcon="bell" pad={0}>
      {notificationRules.map((rule, i) => (
        <ListRow
          {...args}
          key={rule.kind}
          variant="group"
          icon="bell"
          iconTone={rule.tone}
          title={rule.kind}
          subtitle={rule.policy}
          value={undefined}
          toggle={rule.policy !== "never push"}
          toggleTone="amber"
          last={i === notificationRules.length - 1}
        />
      ))}
    </Surface>
  ),
});

/** The first-run launchers: the larger `launcher` variant, chevron and all. */
export const Launchers = meta.story({
  render: (args) => (
    <>
      {launchers.map((l) => (
        <ListRow
          {...args}
          key={l.title}
          variant="launcher"
          icon={l.icon}
          iconTone={l.tone}
          title={l.title}
          subtitle={l.subtitle}
          value={undefined}
          chevron
        />
      ))}
    </>
  ),
});

export const WithAction = Default.extend({
  args: { actionLabel: "Undo", value: undefined, subtitle: undefined },
});

/** A path as a title reads in mono, and the subtitle can follow it. */
export const Mono = Default.extend({
  args: { mono: true, title: "voyage/_index.md", subMono: true, subtitle: "index lag 9d", value: "612" },
});

export const Wide = Default.extend({ parameters: wide });

/** The tap reaches the callback, and so do Enter and Space. */
export const Tapped = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const row = await canvas.findByRole("button");
    await userEvent.click(row);
    await expect(args.onClick).toHaveBeenCalledTimes(1);

    row.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    await expect(args.onClick).toHaveBeenCalledTimes(3);
  },
});

/**
 * THE CONTRACT. No handler means no role, no tab stop, no hover class and no
 * `aria-current` — a settings row that only displays a value never pretends to
 * be pressable. This is an API contract, not styling.
 */
export const Static = meta.story({
  args: { onClick: undefined, selected: true },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvasElement.querySelector(".bk-row")).toBeNull();
    await expect(canvasElement.querySelector("[tabindex]")).toBeNull();
    await expect(canvasElement.querySelector("[aria-current]")).toBeNull();
  },
});
