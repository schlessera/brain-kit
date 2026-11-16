import preview from "#.storybook/preview";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";

import { MarkupToolbar, type MarkupToolbarProps } from "../../src/images/MarkupToolbar.js";
import type { MarkupTool } from "../../src/images/markup.js";

/* ── Toolbar ──────────────────────────────────────────────────────────── */

function ToolbarScene(p: Partial<MarkupToolbarProps> & { layout: "compact" | "wide" }) {
  const [tool, setTool] = useState<MarkupTool>(p.tool ?? "pen");
  const [colour, setColour] = useState(p.color ?? "red");
  const [width, setWidth] = useState(p.width ?? "medium");
  return (
    <div data-theme="dark" style={{ background: "var(--bk-color-canvas)", padding: 12, maxWidth: p.layout === "compact" ? 320 : 1100, boxSizing: "border-box" }}>
      <MarkupToolbar
        canUndo={false} canRedo={false} canClear={false} canSubmit={false}
        onUndo={fn()} onRedo={fn()} onClear={fn()} onSubmit={fn()}
        {...p}
        tool={tool} onTool={setTool} color={colour} onColor={setColour} width={width} onWidth={setWidth}
      />
    </div>
  );
}

const toolbar = preview.meta({ title: "Images/Markup toolbar", component: ToolbarScene, args: { layout: "compact" } });

export const ToolbarEmpty = toolbar.story({ args: { layout: "compact" } });
export const ToolbarWithMarks = toolbar.story({ args: { layout: "compact", canUndo: true, canClear: true, canSubmit: true } });
export const ToolbarWide = toolbar.story({ args: { layout: "wide", canUndo: true, canRedo: true, canClear: true, canSubmit: true } });
export const ToolbarEachTool = toolbar.story({
  args: { layout: "wide" },
  render: () => <div style={{ display: "grid", gap: 8 }}>
    {(["pen", "arrow", "ellipse", "text", "hand"] as const).map(tool => <ToolbarScene key={tool} layout="wide" tool={tool} canSubmit />)}
  </div>,
  play: async ({ canvasElement }) => {
    const groups = within(canvasElement).getAllByRole("group", { name: "Tools" });
    const pressed = groups.map(g => within(g).getAllByRole("button").find(b => b.getAttribute("aria-pressed") === "true")?.getAttribute("aria-label"));
    await expect(pressed).toEqual(["Pen", "Arrow", "Ellipse", "Text note", "Pan"]);
  },
});
export const ToolbarKeyboard = toolbar.story({
  args: { layout: "compact" },
  play: async ({ canvasElement }) => {
    const colours = within(canvasElement).getByRole("radiogroup", { name: "Mark colour" });
    const red = within(colours).getByRole("radio", { name: "Red" });
    red.focus();
    await userEvent.keyboard("{ArrowRight}");
    const yellow = within(colours).getByRole("radio", { name: "Yellow" });
    await expect(yellow.getAttribute("aria-checked")).toBe("true");
    await expect(document.activeElement).toBe(yellow);
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    await expect(within(colours).getByRole("radio", { name: "Cyan" }).getAttribute("aria-checked")).toBe("true");
  },
});
