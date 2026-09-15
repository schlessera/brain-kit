import preview from "#.storybook/preview";
import { expect } from "storybook/test";

import { ICONS, Icon, type IconName } from "../../src/primitives/Icon.js";
import { stage } from "../_stage.js";

const meta = preview.meta({
  title: "Primitives/Icon",
  component: Icon,
  decorators: [stage],
  args: { icon: "brain", size: 16, strokeWidth: 2 },
  argTypes: {
    icon: { control: "select", options: Object.keys(ICONS) },
    size: { control: { type: "number", min: 10, max: 48, step: 1 } },
    color: { control: "color" },
    strokeWidth: { control: { type: "number", min: 1, max: 3, step: 0.25 } },
  },
});

export const Default = meta.story({});

export const Large = Default.extend({ args: { icon: "approval", size: 32, color: "var(--color-amber)" } });

export const Hairline = Default.extend({ args: { icon: "trust", size: 28, strokeWidth: 1 } });

/** `color` defaults to `currentColor`, so an icon inside a Chip or a Button
 * takes that component's colour without being told. */
export const InheritsColour = meta.story({
  args: { icon: "deadline", size: 20 },
  decorators: [(Story) => <span style={{ color: "var(--color-red)" }}>{Story()}</span>],
});

/**
 * All 77 semantic keys. This is the story that catches the port's worst silent
 * failure: an icon that renders as a correctly-sized empty box because its
 * glyph name is wrong. A blank cell here is a bug you can see.
 */
export const Vocabulary = meta.story({
  parameters: { stageWidth: "none" },
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 14, width: "100%" }}>
      {(Object.keys(ICONS) as IconName[]).map((key) => (
        <div
          key={key}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            width: 84,
            color: "var(--color-ink-dim)",
          }}
        >
          <Icon icon={key} size={20} />
          <span
            style={{
              font: "400 8.5px/1.3 'JetBrains Mono',ui-monospace,monospace",
              color: "var(--color-ink-mute)",
              textAlign: "center",
              wordBreak: "break-all",
            }}
          >
            {key}
          </span>
        </div>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    // Every key must have produced an <svg>. The DC version could not make
    // this assertion: Lucide replaced the <i> asynchronously, on a timer.
    const glyphs = canvasElement.querySelectorAll("svg");
    await expect(glyphs.length).toBe(Object.keys(ICONS).length);
  },
});
