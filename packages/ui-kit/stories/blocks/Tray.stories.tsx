import preview from "#.storybook/preview";
import { useState } from "react";
import { expect, fn } from "storybook/test";

import { Tray } from "../../src/blocks/Tray.js";
import { RecordingRow } from "../../src/rows/RecordingRow.js";
import { accent, color, font } from "../../src/tokens.js";
import { stage, wide } from "../_stage.js";

/** Three recordings from the morning watch, 2026-07-12. */
const recordings = [
  { time: "06:10", length: "1:42", durationLabel: "1 minute 42 seconds" },
  { time: "07:35", length: "0:58", durationLabel: "58 seconds" },
  { time: "09:12", length: "2:14", durationLabel: "2 minutes 14 seconds" },
];

function Recordings({ count = recordings.length }: { count?: number }) {
  return (
    <>
      <p style={{ margin: "0 4px", font: `400 12px/1.45 ${font.body}`, color: color.inkMute }}>
        Kept in this browser. Not protected from someone who can use this device.
      </p>
      {Array.from({ length: count }, (_, i) => recordings[i % recordings.length]!).map((row, i) => (
        <RecordingRow key={i} {...row} state="saved" onPlay={fn()} onDiscard={fn()} />
      ))}
    </>
  );
}

/** What a token resolves to here, for comparing computed colours. */
function resolved(host: HTMLElement, value: string) {
  const probe = document.createElement("span");
  probe.style.color = value;
  host.append(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out;
}

const meta = preview.meta({
  title: "Blocks/Tray",
  component: Tray,
  decorators: [stage],
  parameters: { stageWidth: 320 },
  args: {
    label: "On this device · 3 recordings · 1.2 MB",
    icon: "mic" as const,
    children: <Recordings />,
  },
});

/**
 * A bounded panel whose collapsed header is useful on its own: it says what
 * the tray holds and how much. Closed by default.
 */
export const Collapsed = meta.story({
  play: async ({ canvas, canvasElement }) => {
    const header = await canvas.findByRole("button", { name: /On this device/ });
    await expect(header).toHaveAttribute("aria-expanded", "false");
    // The header reaches 44px by itself; it is a row, not a text link.
    await expect(header.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    // The kit's tokens, not the browser's button defaults.
    const css = getComputedStyle(header);
    await expect(css.fontFamily).toContain("JetBrains Mono");
    await expect([css.fontSize, css.fontWeight, css.paddingLeft]).toEqual(["11px", "500", "12px"]);
    await expect(css.color).toBe(resolved(canvasElement, "var(--bk-color-ink)"));
    const tray = canvasElement.querySelector<HTMLElement>("[data-tray]")!;
    await expect(getComputedStyle(tray).borderTopColor).toBe(resolved(canvasElement, "var(--bk-color-line)"));
  },
});

export const Expanded = meta.story({ args: { open: true } });

export const ExpandedWide = Expanded.extend({ parameters: wide });

/** The panel caps its own height; the header stays put and the body scrolls. */
export const ScrollingBody = meta.story({
  args: { open: true, maxHeight: 240, label: "On this device · 9 recordings · 3.4 MB", children: <Recordings count={9} /> },
  play: async ({ canvasElement }) => {
    const body = canvasElement.querySelector<HTMLElement>("[data-tray-body]")!;
    const header = canvasElement.querySelector<HTMLElement>("[data-tray-header]")!;
    await expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    const top = header.getBoundingClientRect().top;
    body.scrollTop = body.scrollHeight;
    await expect(header.getBoundingClientRect().top).toBe(top);
  },
});

/**
 * Graph maintenance's grouped findings. The swatch is a mark, never the name:
 * the label says "Orphan notes" whatever the colour.
 */
export const Grouped = meta.story({
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
      <Tray label="Orphan notes (12)" swatch={accent.gold.mark} open>
        <p style={{ margin: "0 4px", font: `400 12px/1.45 ${font.body}`, color: color.inkDim }}>
          No note links to these.
        </p>
      </Tray>
      <Tray label="Stale notes (4)" swatch={accent.blue.mark}>
        <p style={{ margin: "0 4px" }}>Untouched for over 90 days.</p>
      </Tray>
    </div>
  ),
});

/** A long label wraps rather than truncating, so the count stays visible. */
export const LongLabel = meta.story({
  args: { label: "Not linked to an account · recordings from the crossing to Aeolia · 14 recordings · 6.8 MB" },
  play: async ({ canvas }) => {
    const header = await canvas.findByRole("button");
    await expect(header).toHaveTextContent(/14 recordings · 6\.8 MB$/);
  },
});

/** Enter and Space toggle the native header; aria-controls names the body. */
export const Keyboard = meta.story({
  args: { onOpenChange: fn() },
  play: async ({ canvas, canvasElement, userEvent, args }) => {
    const header = await canvas.findByRole("button", { name: /On this device/ });
    const body = canvasElement.querySelector<HTMLElement>("[data-tray-body]")!;
    await expect(header).toHaveAttribute("aria-controls", body.id);
    header.focus();
    await userEvent.keyboard("{Enter}");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(true);
    await expect(body).toBeVisible();
    await userEvent.keyboard(" ");
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(body).not.toBeVisible();
    // The kit focus ring, not the browser's default.
    await expect(header.matches(":focus-visible")).toBe(true);
    await expect(getComputedStyle(header).outlineStyle).toBe("solid");
  },
});

/**
 * THE LIFECYCLE THIS COMPONENT EXISTS FOR. A closed tray keeps its body
 * mounted, so a recording's playback, a scroll offset or a half-typed note
 * survive closing. `Disclosure` unmounts instead; that is right for evidence
 * and wrong here.
 */
export const RetainsContentWhenClosed = meta.story({
  args: {
    open: true,
    children: (
      <label style={{ display: "grid", gap: 4, margin: "0 4px", font: `400 12px/1.45 ${font.body}`, color: color.ink }}>
        Transcript note
        <input defaultValue="" style={{ minHeight: 44, font: `400 13px ${font.body}` }} />
      </label>
    ),
  },
  play: async ({ canvas, userEvent }) => {
    const header = await canvas.findByRole("button");
    const input = canvas.getByLabelText("Transcript note");
    await userEvent.type(input, "Wind from the north");
    await userEvent.click(header);
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(header);
    // The same node, with the same value: nothing was remounted.
    await expect(canvas.getByLabelText("Transcript note")).toBe(input);
    await expect(input).toHaveValue("Wind from the north");
  },
});

/** The three modes are Disclosure's, through the same primitive. */
export const OpenPropIsSeedOnly = meta.story({
  args: { open: true },
  play: async ({ canvas, userEvent }) => {
    const header = await canvas.findByRole("button", { name: /On this device/ });
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(header);
    await expect(header).toHaveAttribute("aria-expanded", "false");
  },
});

export const Controlled = meta.story({
  args: { open: false, onOpenChange: fn() },
  play: async ({ canvas, userEvent, args }) => {
    const header = await canvas.findByRole("button");
    await userEvent.click(header);
    await expect(args.onOpenChange).toHaveBeenCalledWith(true);
    await expect(header).toHaveAttribute("aria-expanded", "false");
  },
});

/** A parent owning the value, the way the recordings tray does. */
export const ControlledByParent = meta.story({
  render: (args) => {
    const [open, setOpen] = useState(false);
    return <Tray {...args} open={open} onOpenChange={setOpen} />;
  },
  play: async ({ canvas, userEvent }) => {
    const header = await canvas.findByRole("button");
    await userEvent.click(header);
    await expect(header).toHaveAttribute("aria-expanded", "true");
  },
});
