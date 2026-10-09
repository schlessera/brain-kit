import preview from "#.storybook/preview";
import { Trash2 } from "lucide-react";
import { expect, fn } from "storybook/test";
import { IconButton } from "../../src/primitives/IconButton.js";
import { Row, stage } from "../_stage.js";

const meta = preview.meta({
  title: "Primitives/IconButton",
  component: IconButton,
  decorators: [stage],
  parameters: { stageWidth: 320 },
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn() },
});

// Pressed specimens hold the visual pose; native :active is measured in native-buttons.visual.tsx.
export const Default = meta.story({ args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn() } });

export const MuteSmRest = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "mute", size: "sm" },
});

export const MuteSmHover = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "mute", size: "sm" },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.hover(button);
  },
});

export const MuteSmPressed = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "mute", size: "sm", style: { transform: "translateY(1px)", filter: "brightness(.94)" } },
});

export const MuteSmFocus = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "mute", size: "sm" },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.tab(); await expect(button).toHaveFocus(); await expect(button.matches(":focus-visible")).toBe(true);
  },
});

export const MuteSmDisabled = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "mute", size: "sm", disabled: true },
  play: async ({ canvas, args }) => {
    const button = await canvas.findByRole("button");
    button.click(); await expect(args.onClick).not.toHaveBeenCalled();
  },
});

export const MuteSmExpanded = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "mute", size: "sm", expanded: true, haspopup: "menu", controls: "manifest-menu" },
});

export const MuteMdRest = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "mute", size: "md" },
});

export const MuteMdHover = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "mute", size: "md" },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.hover(button);
  },
});

export const MuteMdPressed = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "mute", size: "md", style: { transform: "translateY(1px)", filter: "brightness(.94)" } },
});

export const MuteMdFocus = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "mute", size: "md" },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.tab(); await expect(button).toHaveFocus(); await expect(button.matches(":focus-visible")).toBe(true);
  },
});

export const MuteMdDisabled = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "mute", size: "md", disabled: true },
  play: async ({ canvas, args }) => {
    const button = await canvas.findByRole("button");
    button.click(); await expect(args.onClick).not.toHaveBeenCalled();
  },
});

export const MuteMdExpanded = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "mute", size: "md", expanded: true, haspopup: "menu", controls: "manifest-menu" },
});

export const DangerSmRest = meta.story({
  args: { name: "Delete the raft manifest permanently", icon: undefined, glyph: <Trash2 />, onClick: fn(), tone: "danger", size: "sm" },
});

export const DangerSmHover = meta.story({
  args: { name: "Delete the raft manifest permanently", icon: undefined, glyph: <Trash2 />, onClick: fn(), tone: "danger", size: "sm" },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.hover(button);
  },
});

export const DangerSmPressed = meta.story({
  args: { name: "Delete the raft manifest permanently", icon: undefined, glyph: <Trash2 />, onClick: fn(), tone: "danger", size: "sm", style: { transform: "translateY(1px)", filter: "brightness(.94)" } },
});

export const DangerSmFocus = meta.story({
  args: { name: "Delete the raft manifest permanently", icon: undefined, glyph: <Trash2 />, onClick: fn(), tone: "danger", size: "sm" },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.tab(); await expect(button).toHaveFocus(); await expect(button.matches(":focus-visible")).toBe(true);
  },
});

export const DangerSmDisabled = meta.story({
  args: { name: "Delete the raft manifest permanently", icon: undefined, glyph: <Trash2 />, onClick: fn(), tone: "danger", size: "sm", disabled: true },
  play: async ({ canvas, args }) => {
    const button = await canvas.findByRole("button");
    button.click(); await expect(args.onClick).not.toHaveBeenCalled();
  },
});

export const DangerMdRest = meta.story({
  args: { name: "Delete the raft manifest permanently", icon: undefined, glyph: <Trash2 />, onClick: fn(), tone: "danger", size: "md" },
});

export const DangerMdHover = meta.story({
  args: { name: "Delete the raft manifest permanently", icon: undefined, glyph: <Trash2 />, onClick: fn(), tone: "danger", size: "md" },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.hover(button);
  },
});

export const DangerMdPressed = meta.story({
  args: { name: "Delete the raft manifest permanently", icon: undefined, glyph: <Trash2 />, onClick: fn(), tone: "danger", size: "md", style: { transform: "translateY(1px)", filter: "brightness(.94)" } },
});

export const DangerMdFocus = meta.story({
  args: { name: "Delete the raft manifest permanently", icon: undefined, glyph: <Trash2 />, onClick: fn(), tone: "danger", size: "md" },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.tab(); await expect(button).toHaveFocus(); await expect(button.matches(":focus-visible")).toBe(true);
  },
});

export const DangerMdDisabled = meta.story({
  args: { name: "Delete the raft manifest permanently", icon: undefined, glyph: <Trash2 />, onClick: fn(), tone: "danger", size: "md", disabled: true },
  play: async ({ canvas, args }) => {
    const button = await canvas.findByRole("button");
    button.click(); await expect(args.onClick).not.toHaveBeenCalled();
  },
});

export const OverlaySmRest = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "overlay", size: "sm" },
});

export const OverlaySmHover = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "overlay", size: "sm" },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.hover(button);
  },
});

export const OverlaySmPressed = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "overlay", size: "sm", style: { transform: "translateY(1px)", filter: "brightness(.94)" } },
});

export const OverlaySmFocus = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "overlay", size: "sm" },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.tab(); await expect(button).toHaveFocus(); await expect(button.matches(":focus-visible")).toBe(true);
  },
});

export const OverlaySmDisabled = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "overlay", size: "sm", disabled: true },
  play: async ({ canvas, args }) => {
    const button = await canvas.findByRole("button");
    button.click(); await expect(args.onClick).not.toHaveBeenCalled();
  },
});

export const OverlayMdRest = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "overlay", size: "md" },
});

export const OverlayMdHover = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "overlay", size: "md" },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.hover(button);
  },
});

export const OverlayMdPressed = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "overlay", size: "md", style: { transform: "translateY(1px)", filter: "brightness(.94)" } },
});

export const OverlayMdFocus = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "overlay", size: "md" },
  play: async ({ canvas, userEvent }) => {
    const button = await canvas.findByRole("button");
    await userEvent.tab(); await expect(button).toHaveFocus(); await expect(button.matches(":focus-visible")).toBe(true);
  },
});

export const OverlayMdDisabled = meta.story({
  args: { name: "Refresh the raft manifest", icon: "retry", onClick: fn(), tone: "overlay", size: "md", disabled: true },
  play: async ({ canvas, args }) => {
    const button = await canvas.findByRole("button");
    button.click(); await expect(args.onClick).not.toHaveBeenCalled();
  },
});

export const TonesBySize = meta.story({
  render: () => (
    <div style={{ width: 320, display: "flex", flexDirection: "column", gap: 28, padding: 16, boxSizing: "border-box" }}>
      <Row caption="mute">
        <IconButton tone="mute" size="sm" name="mute sm" icon="retry" onClick={fn()} />
        <IconButton tone="mute" size="md" name="mute md" icon="retry" onClick={fn()} />
      </Row>
      <Row caption="danger">
        <IconButton tone="danger" size="sm" name="Delete manifest (sm)" glyph={<Trash2 />} onClick={fn()} />
        <IconButton tone="danger" size="md" name="Delete manifest (md)" glyph={<Trash2 />} onClick={fn()} />
      </Row>
      <Row caption="overlay">
        <IconButton tone="overlay" size="sm" name="overlay sm" icon="retry" onClick={fn()} />
        <IconButton tone="overlay" size="md" name="overlay md" icon="retry" onClick={fn()} />
      </Row>
    </div>
  ),
});
