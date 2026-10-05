import preview from "#.storybook/preview";
import { useState } from "react";
import { expect, fn } from "storybook/test";

import { EffectPreview } from "../../src/decisions/EffectPreview.js";
import { overflowing, stage } from "../_stage.js";

const ledgerInput = JSON.stringify(
  { path: "finances/ithaca-port.md", append: "| 2026-07-12 | harbour fee | 12 dr |\n| due before the next new moon |" },
  null,
  2,
);
const longInput = Array.from({ length: 48 }, (_, i) => `| 2026-07-${String((i % 28) + 1).padStart(2, "0")} | oar ${i + 1} | inspected |`).join("\n");

const meta = preview.meta({
  title: "Decisions/EffectPreview",
  component: EffectPreview,
  decorators: [stage],
  args: {
    variant: "enqueue",
    heading: "If approved",
    effect: "enqueue",
    tool: "Edit",
    path: "finances/ithaca-port.md",
    instruction: "Append the harbour-fee row to the port ledger.",
    input: ledgerInput,
    scope: "this edit, this path, once",
    cost: "1 autonomous turn",
  },
});

/** The exact effect: tool, path and full input as text, before any commit. */
export const Enqueue = meta.story({
  play: async ({ canvasElement, canvas }) => {
    await expect(canvas.getByText("Edit")).toBeTruthy();
    await expect(canvas.getByText("finances/ithaca-port.md")).toBeTruthy();
    await expect(canvasElement.querySelector("[data-effect-input]")!.textContent).toBe(ledgerInput);
    await expect(overflowing(canvasElement)).toEqual([]);
  },
});

/** A long path wraps inside the card; nothing in an effect is truncated. */
export const LongPath = Enqueue.extend({
  args: {
    path: `journeys/${"the-long-way-home-from-troy-by-way-of-ogygia-and-the-island-of-the-phaeacians/".repeat(2)}raft.md`,
  },
  play: async ({ canvasElement }) => {
    const path = canvasElement.querySelector<HTMLElement>("[data-effect-path]")!;
    await expect(path.textContent!.length).toBeGreaterThan(150);
    await expect(overflowing(canvasElement)).toEqual([]);
  },
});

/** Past 12 lines the input collapses; the reveal names how much is hidden. */
export const LongInput = meta.story({
  args: { input: longInput, onReveal: fn() },
  render: (args) => {
    const [revealed, setRevealed] = useState(false);
    return <EffectPreview {...args} revealed={revealed} onReveal={() => { setRevealed(true); args.onReveal?.(); }} />;
  },
  play: async ({ canvasElement, canvas, userEvent, args }) => {
    const input = () => canvasElement.querySelector("[data-effect-input]")!.textContent!;
    await expect(input().split("\n")).toHaveLength(12);
    await userEvent.click(await canvas.findByRole("button", { name: /Show all 48 lines/ }));
    await expect(args.onReveal).toHaveBeenCalledTimes(1);
    await expect(input().split("\n")).toHaveLength(48);
  },
});

/** A queued item it stops, and no tool runs. */
export const Cancel = meta.story({
  args: { variant: "cancel", effect: "cancel_blocked", message: "Cancels queued item triage · share-9f2 and cleans its staging. No tool runs." },
});

/** Deferred in this version: shown, never offered. */
export const Unavailable = meta.story({
  args: { variant: "unavailable", heading: "Always allow", effect: "write_policy", message: "Not available in this version." },
});

/** A record that fails the strict schema is printed raw, as text, never markup. */
export const Malformed = meta.story({
  args: {
    variant: "malformed",
    heading: "Effect",
    message: "This effect can't be displayed.",
    raw: JSON.stringify({ kind: "enqueue", payload: { instruction: "<img src=x onerror=alert(1)>", operation: { capability: "all" } } }, null, 2),
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("img")).toBeNull();
    await expect(canvasElement.querySelector("[data-effect-raw]")!.textContent).toContain("<img src=x onerror=alert(1)>");
  },
});
