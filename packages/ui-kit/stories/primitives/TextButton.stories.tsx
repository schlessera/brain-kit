import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";
import { TextButton } from "../../src/primitives/TextButton.js";
import { Row, stage } from "../_stage.js";

const meta = preview.meta({
  title: "Primitives/TextButton",
  component: TextButton,
  decorators: [stage],
  parameters: { stageWidth: 320 },
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn() },
});

// Pressed specimens hold the visual pose; native :active is measured in native-buttons.visual.tsx.
export const Default = meta.story({ args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn() } });

export const LinkStandaloneRest = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "link", inline: false },
});

export const LinkStandaloneHover = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "link", inline: false },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.hover(button);
  },
});

export const LinkStandalonePressed = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "link", inline: false, style: { transform: "translateY(1px)" } },
});

export const LinkStandaloneFocus = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "link", inline: false },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.tab(); await expect(button).toHaveFocus(); await expect(button.matches(":focus-visible")).toBe(true);
  },
});

export const LinkStandaloneDisabled = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "link", inline: false, disabled: true },
  play: async ({ canvas, args }) => {
    const button = await canvas.findByRole("button");
    button.click(); await expect(args.onClick).not.toHaveBeenCalled();
  },
});

export const LinkInlineRest = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "link", inline: true },
});

export const LinkInlineHover = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "link", inline: true },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.hover(button);
  },
});

export const LinkInlinePressed = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "link", inline: true, style: { transform: "translateY(1px)" } },
});

export const LinkInlineFocus = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "link", inline: true },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.tab(); await expect(button).toHaveFocus(); await expect(button.matches(":focus-visible")).toBe(true);
  },
});

export const LinkInlineDisabled = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "link", inline: true, disabled: true },
  play: async ({ canvas, args }) => {
    const button = await canvas.findByRole("button");
    button.click(); await expect(args.onClick).not.toHaveBeenCalled();
  },
});

export const MetaStandaloneRest = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "meta", inline: false },
});

export const MetaStandaloneHover = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "meta", inline: false },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.hover(button);
  },
});

export const MetaStandalonePressed = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "meta", inline: false, style: { transform: "translateY(1px)" } },
});

export const MetaStandaloneFocus = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "meta", inline: false },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.tab(); await expect(button).toHaveFocus(); await expect(button.matches(":focus-visible")).toBe(true);
  },
});

export const MetaStandaloneDisabled = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "meta", inline: false, disabled: true },
  play: async ({ canvas, args }) => {
    const button = await canvas.findByRole("button");
    button.click(); await expect(args.onClick).not.toHaveBeenCalled();
  },
});

export const MetaInlineRest = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "meta", inline: true },
});

export const MetaInlineHover = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "meta", inline: true },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.hover(button);
  },
});

export const MetaInlinePressed = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "meta", inline: true, style: { transform: "translateY(1px)" } },
});

export const MetaInlineFocus = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "meta", inline: true },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.tab(); await expect(button).toHaveFocus(); await expect(button.matches(":focus-visible")).toBe(true);
  },
});

export const MetaInlineDisabled = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "meta", inline: true, disabled: true },
  play: async ({ canvas, args }) => {
    const button = await canvas.findByRole("button");
    button.click(); await expect(args.onClick).not.toHaveBeenCalled();
  },
});

export const InheritStandaloneRest = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "inherit", inline: false },
});

export const InheritStandaloneHover = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "inherit", inline: false },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.hover(button);
  },
});

export const InheritStandalonePressed = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "inherit", inline: false, style: { transform: "translateY(1px)" } },
});

export const InheritStandaloneFocus = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "inherit", inline: false },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.tab(); await expect(button).toHaveFocus(); await expect(button.matches(":focus-visible")).toBe(true);
  },
});

export const InheritStandaloneDisabled = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "inherit", inline: false, disabled: true },
  play: async ({ canvas, args }) => {
    const button = await canvas.findByRole("button");
    button.click(); await expect(args.onClick).not.toHaveBeenCalled();
  },
});

export const InheritInlineRest = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "inherit", inline: true },
});

export const InheritInlineHover = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "inherit", inline: true },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.hover(button);
  },
});

export const InheritInlinePressed = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "inherit", inline: true, style: { transform: "translateY(1px)" } },
});

export const InheritInlineFocus = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "inherit", inline: true },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.tab(); await expect(button).toHaveFocus(); await expect(button.matches(":focus-visible")).toBe(true);
  },
});

export const InheritInlineDisabled = meta.story({
  args: { label: "Open the raft manifest", icon: "file", iconEnd: "next", onClick: fn(), tone: "inherit", inline: true, disabled: true },
  play: async ({ canvas, args }) => {
    const button = await canvas.findByRole("button");
    button.click(); await expect(args.onClick).not.toHaveBeenCalled();
  },
});

export const TonesBySize = meta.story({
  render: () => (
    <div style={{ width: 320, display: "flex", flexDirection: "column", gap: 28, padding: 16, boxSizing: "border-box" }}>
      <Row caption="link">
        <TextButton tone="link" inline={false} label="standalone" iconEnd="next" onClick={fn()} />
        <TextButton tone="link" inline={true} label="inline" iconEnd="next" onClick={fn()} />
      </Row>
      <Row caption="meta">
        <TextButton tone="meta" inline={false} label="standalone" iconEnd="next" onClick={fn()} />
        <TextButton tone="meta" inline={true} label="inline" iconEnd="next" onClick={fn()} />
      </Row>
      <Row caption="inherit">
        <TextButton tone="inherit" inline={false} label="standalone" iconEnd="next" onClick={fn()} />
        <TextButton tone="inherit" inline={true} label="inline" iconEnd="next" onClick={fn()} />
      </Row>
    </div>
  ),
});

// Expanded is semantic for text disclosures; the words continue to carry the state.
export const LinkStandaloneExpanded = meta.story({
  args: { label: "Raft manifest open", onClick: fn(), tone: "link", inline: false, expanded: true, haspopup: "menu", controls: "manifest-menu" },
});
export const LinkInlineExpanded = meta.story({
  args: { label: "Raft manifest open", onClick: fn(), tone: "link", inline: true, expanded: true, haspopup: "menu", controls: "manifest-menu" },
});
export const MetaStandaloneExpanded = meta.story({
  args: { label: "Raft manifest open", onClick: fn(), tone: "meta", inline: false, expanded: true, haspopup: "menu", controls: "manifest-menu" },
});
export const MetaInlineExpanded = meta.story({
  args: { label: "Raft manifest open", onClick: fn(), tone: "meta", inline: true, expanded: true, haspopup: "menu", controls: "manifest-menu" },
});
export const InheritStandaloneExpanded = meta.story({
  args: { label: "Raft manifest open", onClick: fn(), tone: "inherit", inline: false, expanded: true, haspopup: "menu", controls: "manifest-menu" },
});
export const InheritInlineExpanded = meta.story({
  args: { label: "Raft manifest open", onClick: fn(), tone: "inherit", inline: true, expanded: true, haspopup: "menu", controls: "manifest-menu" },
});
