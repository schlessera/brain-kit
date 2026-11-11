import preview from "#.storybook/preview";
import { useState } from "react";
import { expect, userEvent } from "storybook/test";

import { ScreenHeader } from "../../src/chrome/ScreenHeader.js";
import { Toggle } from "../../src/primitives/Toggle.js";
import { LiveServiceSettings, type LiveServiceOption, type LiveServiceSettingsProps } from "../../src/voice/LiveServiceSettings.js";
import { stage } from "../_stage.js";
import { voiceA11y } from "./_checks.js";

/**
 * Settings › Voice, the Live service group (#3616). Which live-conversation
 * service a new Start uses when the Start card names none. A pick saves the
 * brain-wide default at once; it applies from the next Start, never to a
 * running conversation. A saved default the host no longer registers is a
 * dashed row that cannot be chosen: each Start then asks for a pick (S3d),
 * and the host default is never substituted.
 */
const meta = preview.meta({
  title: "Voice/Settings · Live service",
  decorators: [stage],
});

const GEMINI: LiveServiceOption = { id: "gemini-live", name: "Gemini Live", detail: "Audio and this chat's text go to Google." };
const GPT: LiveServiceOption = { id: "gpt-live", name: "GPT-Live", detail: "Audio and this chat's text go to OpenAI." };

/** Every row, measured: 52px rows, 44px targets, nothing outside the column. */
async function rows(root: HTMLElement) {
  await voiceA11y(root);
  for (const row of root.querySelectorAll<HTMLElement>(".bk-live-service-row")) {
    await expect(Math.round(row.getBoundingClientRect().height), "52px row").toBeGreaterThanOrEqual(52);
    // The radio starts every row at its padding, whatever the name's length.
    const radio = row.querySelector("input");
    if (radio) await expect(Math.round(radio.getBoundingClientRect().left - row.getBoundingClientRect().left), "radio at the row's start").toBeLessThanOrEqual(14);
  }
}

/** Interactive: the group as a pane draws it, saving on pick. */
function Live(p: Partial<LiveServiceSettingsProps> & { initial?: string | null }) {
  const [checked, setChecked] = useState<string | null>(p.initial ?? p.checked ?? null);
  return <LiveServiceSettings services={[GEMINI, GPT]} saved={checked} {...p} checked={checked} onChoose={(id) => { setChecked(id); p.onChoose?.(id); }} />;
}

/** No live service is registered: the honest unavailable line, nothing to choose. */
export const Zero = meta.story({
  name: "Zero services",
  render: () => <LiveServiceSettings services={[]} checked={null} />,
  play: async ({ canvas, canvasElement }) => {
    await rows(canvasElement);
    await expect(canvas.getByText("Live conversation isn’t set up on this host.")).toBeVisible();
    await expect(canvas.queryByRole("radio")).toBeNull();
  },
});

/** One service: a read-only row, no radio. */
export const One = meta.story({
  name: "One service",
  render: () => <LiveServiceSettings services={[GEMINI]} checked="gemini-live" />,
  play: async ({ canvas, canvasElement }) => {
    await rows(canvasElement);
    await expect(canvas.queryByRole("radio")).toBeNull();
    await expect(canvas.getByText(/The only live service on this host/)).toBeVisible();
  },
});

/** Several, nothing saved and no host default: nothing checked, "Pick a default". */
export const SeveralNoDefault = meta.story({
  name: "Several · pick a default",
  render: () => <Live />,
  play: async ({ canvas, canvasElement }) => {
    await rows(canvasElement);
    const group = canvas.getByRole("radiogroup", { name: "Live service" });
    await expect(group).toBeVisible();
    await expect(canvas.getByText("Pick a default")).toBeVisible();
    for (const radio of canvas.getAllByRole("radio")) await expect(radio).not.toBeChecked();
    // A pick checks the row and marks it the saved default.
    await userEvent.click(canvas.getByRole("radio", { name: /GPT-Live/ }));
    await expect(canvas.getByRole("radio", { name: /GPT-Live/ })).toBeChecked();
    await expect(canvas.getByText("saved default")).toBeVisible();
  },
});

/** Several, nothing saved, a host default: it is checked and marked "host default". */
export const SeveralHostDefault = meta.story({
  name: "Several · host default",
  render: () => <LiveServiceSettings services={[GEMINI, GPT]} checked="gpt-live" saved={null} hostDefault="gpt-live" />,
  play: async ({ canvas, canvasElement }) => {
    await rows(canvasElement);
    await expect(canvas.getByRole("radio", { name: /GPT-Live/ })).toBeChecked();
    await expect(canvas.getByText("host default")).toBeVisible();
  },
});

/** The saved default runs a conversation now; another is marked "in use now". Arrow keys move and select. */
export const SavedAndInUse = meta.story({
  name: "Several · saved, another in use",
  render: () => <Live initial="gemini-live" inUse="gpt-live" />,
  play: async ({ canvas, canvasElement }) => {
    await rows(canvasElement);
    await expect(canvas.getByText("saved default")).toBeVisible();
    await expect(canvas.getByText("in use now")).toBeVisible();
    await expect(canvas.getByText("Used from the next Start. A running conversation keeps its service.")).toBeVisible();
    const gemini = canvas.getByRole("radio", { name: /Gemini Live/ });
    gemini.focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(canvas.getByRole("radio", { name: /GPT-Live/ })).toBeChecked();
    await expect(canvas.getByRole("radio", { name: /GPT-Live/ })).toHaveFocus();
  },
});

/** A saved default the host no longer registers: dashed, announced, never selectable. */
export const SavedUnavailable = meta.story({
  name: "Saved default · not available",
  render: () => <LiveServiceSettings services={[GEMINI]} checked={null} saved="gpt-live" savedUnavailable={GPT} />,
  play: async ({ canvas, canvasElement }) => {
    await rows(canvasElement);
    const dashed = canvasElement.querySelector<HTMLElement>("[data-live-service-unavailable]")!;
    await expect(dashed.textContent).toContain("GPT-Live");
    await expect(dashed.textContent).toContain("saved default · not available");
    await expect(getComputedStyle(dashed).borderTopStyle).toBe("dashed");
    await expect(canvas.queryByRole("radio", { name: /GPT-Live/ }), "the unavailable default is not a choice").toBeNull();
    await expect(canvas.getByRole("radio", { name: /Gemini Live/ })).not.toBeChecked();
  },
});

/** Saving, then a 409: the latest value is shown with an inline line. */
export const SavingAndStale = meta.story({
  name: "Saving · changed on another device",
  render: () => <div style={{ display: "flex", flexDirection: "column", gap: 24, width: "100%" }}>
    <LiveServiceSettings services={[GEMINI, GPT]} checked="gpt-live" saved="gemini-live" status={{ kind: "saving" }} disabled />
    <LiveServiceSettings services={[GEMINI, GPT]} checked="gemini-live" saved="gemini-live" status={{ kind: "stale" }} />
  </div>,
  play: async ({ canvas, canvasElement }) => {
    await rows(canvasElement);
    await expect(canvas.getByText("Saving…")).toBeVisible();
    await expect(canvas.getByText("Changed on another device. Showing the latest.")).toBeVisible();
  },
});

/** A failed save reverts and offers Try again; a non-owner sees why the radios are off. */
export const FailedAndReadOnly = meta.story({
  name: "Save failed · read-only",
  render: () => <div style={{ display: "flex", flexDirection: "column", gap: 24, width: "100%" }}>
    <LiveServiceSettings services={[GEMINI, GPT]} checked="gemini-live" saved="gemini-live" status={{ kind: "failed", text: "Couldn't save. Your live service is unchanged." }} onRetry={() => {}} />
    <LiveServiceSettings services={[GEMINI, GPT]} checked="gemini-live" saved="gemini-live" readOnly />
  </div>,
  play: async ({ canvas, canvasElement }) => {
    await rows(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("Couldn't save. Your live service is unchanged.");
    await expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(canvas.getByText("Only the owner can change this.")).toBeVisible();
    const readOnly = canvas.getAllByRole("radiogroup")[1]!;
    for (const radio of readOnly.querySelectorAll("input")) await expect(radio).toBeDisabled();
  },
});

/** Desktop: the label in a 140px column, exactly two services side by side. */
export const Desktop = meta.story({
  name: "Desktop · two side by side",
  parameters: { stageWidth: "none" },
  render: () => <Live initial="gemini-live" />,
  play: async ({ canvas, canvasElement }) => {
    await rows(canvasElement);
    const label = canvas.getByRole("heading", { name: "Live service" }).getBoundingClientRect();
    const [a, b] = canvas.getAllByRole("radio").map((r) => r.closest("label")!.getBoundingClientRect());
    await expect(Math.round(label.width), "140px label column").toBe(140);
    await expect(Math.round(a!.top), "two services side by side").toBe(Math.round(b!.top));
    await expect(a!.left).toBeGreaterThan(label.right);
  },
});

/** The 320px phone column: stacked, nothing overflows. */
export const Phone320 = meta.story({
  name: "320 · stacked",
  parameters: { stageWidth: 320 },
  render: () => <Live initial="gpt-live" />,
  play: async ({ canvas, canvasElement }) => {
    await rows(canvasElement);
    const [a, b] = canvas.getAllByRole("radio").map((r) => r.closest("label")!.getBoundingClientRect());
    await expect(b!.top, "stacked at 320").toBeGreaterThan(a!.bottom - 1);
  },
});

/**
 * The full pane: Dictation, Live service and Persona as independent siblings.
 * Picking a live service touches neither neighbour.
 */
function Pane() {
  const [smart, setSmart] = useState(true);
  const [persona, setPersona] = useState("steward");
  return <div style={{ width: "100%" }}>
    <ScreenHeader variant="nav" title="Voice" subtitle="dictation and live conversation · where your spoken words go" back={false} divider={false} />
    <div style={{ display: "flex", flexDirection: "column", gap: 24, padding: "0 16px 24px" }}>
      <section aria-label="Dictation" data-pane-group="dictation">
        <h3 style={{ margin: 0, fontSize: 14 }}>Dictation</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 52 }}>
          <span id="pane-smart" style={{ flex: 1, fontSize: 13 }}>Clean up as I speak</span>
          <Toggle on={smart} labelledBy="pane-smart" onClick={() => setSmart((v) => !v)} />
        </div>
      </section>
      <Live initial="gemini-live" />
      <section aria-label="Persona" data-pane-group="persona">
        <h3 style={{ margin: 0, fontSize: 14 }}>Persona</h3>
        <div role="radiogroup" aria-label="Persona" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[["steward", "Ithaca steward"], ["herald", "Herald of the assembly"]].map(([id, name]) => (
            <label key={id} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 52 }}>
              <input type="radio" name="pane-persona" checked={persona === id} onChange={() => setPersona(id!)} style={{ width: 20, height: 20 }} />
              {name}
            </label>
          ))}
        </div>
      </section>
    </div>
  </div>;
}

async function independent(canvasElement: HTMLElement) {
  const radio = (name: RegExp) => [...canvasElement.querySelectorAll<HTMLInputElement>("input[type=radio]")].find((i) => name.test(i.closest("label")?.textContent ?? ""))!;
  await rows(canvasElement);
  const toggle = canvasElement.querySelector<HTMLElement>("[role=switch]")!;
  const before = toggle.getAttribute("aria-checked");
  await userEvent.click(radio(/GPT-Live/));
  await expect(radio(/GPT-Live/)).toBeChecked();
  await expect(radio(/Ithaca steward/), "persona untouched").toBeChecked();
  await expect(toggle.getAttribute("aria-checked"), "dictation untouched").toBe(before);
}

export const FullPane = meta.story({
  name: "Full pane · 320",
  parameters: { stageWidth: 320 },
  render: () => <Pane />,
  play: async ({ canvasElement }) => independent(canvasElement),
});

export const FullPaneDesktop = meta.story({
  name: "Full pane · desktop",
  parameters: { stageWidth: "none" },
  render: () => <Pane />,
  play: async ({ canvasElement }) => independent(canvasElement),
});
