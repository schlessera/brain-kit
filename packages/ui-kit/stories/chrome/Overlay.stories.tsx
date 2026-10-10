import preview from "#.storybook/preview";
import { useState } from "react";
import { expect, fn } from "storybook/test";
import { Overlay, type OverlayProps } from "../../src/chrome/Overlay.js";
import { Button } from "../../src/primitives/Button.js";

type TitleOverlayProps = Pick<Extract<OverlayProps, { title: string }>, "title" | "open" | "onClose" | "variant" | "children" | "modal" | "size" | "placement" | "role" | "closedBy">;
function Scene(p: TitleOverlayProps) {
  const [open, setOpen] = useState(p.open);
  return <>
    <Button label="Open raft plan" onClick={() => setOpen(true)} />
    <Overlay {...p} open={open} onClose={reason => { p.onClose(reason); setOpen(false); }}>
      {p.variant === "fullscreen" && <Button label="Close raft plan" style={{minHeight:44}} onClick={() => setOpen(false)} />}
      <p>Odysseus is building the raft on Ogygia.</p>
      <p>Plan reviewed on <time dateTime="2026-07-12">2026-07-12</time>.</p>
      <Button label="Review mast and yard" onClick={fn()} />
    </Overlay>
  </>;
}
const defaults: TitleOverlayProps = { open: true, title: "Raft plan", variant: "sheet", onClose: fn(), children: null };
const meta = preview.meta({
  title: "Chrome/Overlay",
  component: Scene,
  args: defaults,
  render: args => <Scene {...args} />,
});
export const Sheet = meta.story({
  args: { ...defaults },
  play: async ({ canvas }) => { await expect(await canvas.findByRole("dialog", { name: "Raft plan" })).toBeTruthy(); },
});
export const Dialog = meta.story({ args: { ...defaults, variant: "dialog" } });
export const DialogTop = meta.story({ args: { ...defaults, variant: "dialog", placement: "top", size: "lg" } });
export const Fullscreen = meta.story({ args: { ...defaults, variant: "fullscreen" } });
export const Panel = meta.story({ args: { ...defaults, variant: "panel" } });
export const Destination = meta.story({
  args: { ...defaults, variant: "panel", modal: false },
  render: args => <><nav data-bk-keep-live="" aria-label="Destinations" style={{position:"fixed",bottom:0,height:60,width:"100%"}}><Button label="Chat" onClick={fn()} /></nav><Scene {...args} /></>,
});
export const MustAcknowledge = meta.story({ args: { ...defaults, variant: "dialog", role: "alertdialog", closedBy: "none" },
  render: args => <Overlay {...args}><p>Odysseus must keep this plan.</p><Button label="Done" onClick={fn()} /></Overlay>,
});
