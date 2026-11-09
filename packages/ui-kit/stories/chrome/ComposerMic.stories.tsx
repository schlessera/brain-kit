import preview from "#.storybook/preview";
import type { ReactElement, ReactNode } from "react";
import { expect } from "storybook/test";

import { Composer } from "../../src/chrome/Composer.js";
import { overflowing, stage, wide } from "../_stage.js";
import { COMPOSER_MIC_TITLES, PROVIDER, REVIEW, composerWithMic, type ComposerMicId } from "./_composer-mic.js";

/**
 * The hold-to-talk `MicButton` in the real composer (#3727, signed off on the
 * issue with rulings M1 and M2): the caller passes it as `micControl`, and the
 * row stays attach · text · mic · send.
 *
 * The mic's 44px target sits in the field with -4px block margins, so the
 * field is 54px rather than 46px. Attach and Send sit on the last line of a
 * multi-line draft. The hold hint and "Talk live…" are the mic's own: they
 * float above the field and never move the layout.
 *
 * D1 rest, S1 holding with the hint, S1 with "Talk live…" focused, D6 review
 * (plain editable text, no uncertain mark and no hint-line cue, M2) and the
 * offline "Record on this device" mic, which has no hold (M1).
 */
const meta = preview.meta({
  title: "Chrome/Composer with MicButton",
  component: Composer,
  decorators: [stage],
  parameters: { stageWidth: 390 },
});

/** Room above the field for the hint and "Talk live…", which overlay whatever is there. */
const above = (children: ReactNode): ReactElement => <div style={{ width: "100%", paddingTop: 56 }}>{children}</div>;

const field = (root: HTMLElement) => root.querySelector<HTMLElement>(".bk-field")!;
const centre = (el: Element) => {
  const box = el.getBoundingClientRect();
  return box.top + box.height / 2;
};

/** D1: the mic takes the mic slot, and the field grows from 46px to 54px. */
export const Idle = meta.story({
  render: () => composerWithMic("D1"),
  play: async ({ canvas, canvasElement }) => {
    await expect(field(canvasElement).getBoundingClientRect().height, "54px field").toBe(54);
    const names = canvas.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
    await expect(names, "row order attach · Talk live… · mic · send, then the chip").toEqual([
      "Attach — photo, camera, files",
      "Talk live…",
      "Dictate",
      "Send",
      `Model — ${PROVIDER}`,
    ]);
    const mic = canvas.getByRole("button", { name: "Dictate" });
    const box = mic.getBoundingClientRect();
    await expect([box.width, box.height], "the 44px target").toEqual([44, 44]);
    const outer = field(canvasElement).getBoundingClientRect();
    await expect(box.top >= outer.top && box.bottom <= outer.bottom, "the target stays inside the border").toBe(true);
    const disc = centre(canvasElement.querySelector(".bk-voice-mic-disc")!);
    for (const name of ["Attach — photo, camera, files", "Send"]) {
      await expect(Math.abs(centre(canvas.getByRole("button", { name })) - disc), `${name} centred on the mic`).toBeLessThanOrEqual(0.5);
    }
    await expect(Math.abs(centre(canvas.getByRole("textbox")) - disc), "one line centred on the mic").toBeLessThanOrEqual(1);
    await expect(canvas.queryByText("Keep holding to talk live")).toBeNull();
  },
});

/** S1 at 320px: the hint floats above the field, and the row does not overflow. */
export const HoldingWithHint = meta.story({
  parameters: { stageWidth: 320 },
  render: () => above(composerWithMic("S1")),
  play: async ({ canvas, canvasElement }) => {
    const hint = canvas.getByText("Keep holding to talk live");
    await expect(hint).toBeVisible();
    await expect(field(canvasElement).getBoundingClientRect().height, "the hint never moves the layout").toBe(54);
    await expect(hint.getBoundingClientRect().bottom, "above the field").toBeLessThanOrEqual(field(canvasElement).getBoundingClientRect().top);
    const mic = canvas.getByRole("button", { name: "Dictate" }).getBoundingClientRect();
    await expect(Math.round(hint.getBoundingClientRect().right), "MicButton's own position: right-aligned to the mic").toBe(Math.round(mic.right));
    await expect(overflowing(canvasElement, "*:not(.bk-voice-talk-live *)")).toEqual([]);
    for (const row of canvasElement.querySelectorAll<HTMLElement>(".bk-field, [data-composer-hint]")) {
      await expect(row.scrollWidth, "no row overflow at 320").toBeLessThanOrEqual(row.clientWidth);
    }
    // 292 − padding 20 − attach 28 − mic 44 − send 28 − three 8px gaps, less the 1px border each side.
    await expect(Math.round(canvas.getByRole("textbox").getBoundingClientRect().width), "the text keeps its width at 320").toBe(146);
  },
});

/** S1 from the keyboard: "Talk live…" shows where the hint would, in the tab order between the text and the mic. */
export const TalkLiveFocused = meta.story({
  render: () => above(composerWithMic("S1-talk-live")),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const order = ["Attach — photo, camera, files", "Message", "Talk live…", "Dictate", "Send", `Model — ${PROVIDER}`];
    const reached: string[] = [];
    for (let i = 0; i < order.length; i++) {
      await userEvent.tab();
      const el = document.activeElement as HTMLElement;
      reached.push(el.tagName === "TEXTAREA" ? "Message" : (el.getAttribute("aria-label") ?? el.textContent?.trim() ?? ""));
    }
    await expect(reached, "Attach → text → Talk live… → Dictate → Send → model chip").toEqual(order);
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    const talk = canvas.getByRole("button", { name: "Talk live…" });
    await expect(talk).toHaveFocus();
    await expect(talk.getBoundingClientRect().height, "44px when focused").toBeGreaterThanOrEqual(44);
    await expect(talk.getBoundingClientRect().bottom, "above the field").toBeLessThanOrEqual(field(canvasElement).getBoundingClientRect().top);
    await expect(canvas.queryByText("Keep holding to talk live"), "only one of the two").toBeNull();
    await expect(field(canvasElement).getBoundingClientRect().height).toBe(54);
  },
});

/** D6: plain editable dictated words, focus in the text with the caret at the end; "Dictate more" and a live Send. */
export const ReviewOneLine = meta.story({
  render: () => composerWithMic("D6"),
  play: async ({ canvas, canvasElement }) => {
    const text = canvas.getByRole<HTMLTextAreaElement>("textbox");
    await expect(text).not.toHaveAttribute("readonly");
    text.focus();
    text.setSelectionRange(REVIEW.length, REVIEW.length);
    await expect(text).toHaveFocus();
    await expect([text.selectionStart, text.selectionEnd], "caret at the end").toEqual([REVIEW.length, REVIEW.length]);
    await expect(canvas.getByRole("button", { name: "Dictate more" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Send" })).not.toHaveAttribute("aria-disabled");
    // M2: no uncertain-word mark and no hint-line cue.
    await expect(canvasElement.querySelector(".bk-uncertain")).toBeNull();
    await expect(canvasElement.querySelector("[data-composer-hint]")?.textContent).toContain("⏎ to send");
  },
});

/** D6 on three lines: attach, mic and Send sit on the last line. */
export const ReviewThreeLines = meta.story({
  render: () => composerWithMic("D6-three-lines"),
  play: async ({ canvas, canvasElement }) => {
    const text = canvas.getByRole("textbox");
    const box = field(canvasElement).getBoundingClientRect();
    await expect(Math.round(text.getBoundingClientRect().height), "three lines, no scroll").toBe(Math.round(3 * 13.5 * 1.45));
    await expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight);
    await expect(box.height, "taller than one line").toBeGreaterThan(54);
    const lastLine = text.getBoundingClientRect().bottom - (13.5 * 1.45) / 2;
    const disc = centre(canvasElement.querySelector(".bk-voice-mic-disc")!);
    await expect(Math.abs(disc - lastLine), "the mic on the last line").toBeLessThanOrEqual(1);
    for (const name of ["Attach — photo, camera, files", "Send"]) {
      await expect(Math.abs(centre(canvas.getByRole("button", { name })) - disc), `${name} on the last line`).toBeLessThanOrEqual(0.5);
    }
  },
});

/** M1: offline, the mic is "Record on this device", with no hold, no hint and no "Talk live…". */
export const OfflineLocalRecording = meta.story({
  render: () => composerWithMic("offline"),
  play: async ({ canvas, canvasElement }) => {
    const mic = canvas.getByRole("button", { name: "Record on this device" });
    await expect(mic).toHaveAttribute("data-phase", "idle");
    await expect(canvas.queryByRole("button", { name: "Talk live…" })).toBeNull();
    await expect(canvas.getByRole("button", { name: "Send — unavailable" })).toHaveAttribute("aria-disabled", "true");
    await expect(canvas.getByText("needs the host · your draft is kept")).toBeVisible();
    await expect(field(canvasElement).getBoundingClientRect().height).toBe(54);
  },
});

/** Every state, one per cell, as the visual baselines capture them. */
export const AllStates = meta.story({
  parameters: wide,
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, width: "100%", maxWidth: 720 }}>
      {(Object.keys(COMPOSER_MIC_TITLES) as ComposerMicId[]).map((id) => (
        <section key={id} data-state={id} aria-label={COMPOSER_MIC_TITLES[id]} style={{ width: "100%", paddingTop: id.startsWith("S1") ? 56 : 0 }}>
          {composerWithMic(id)}
        </section>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("[data-state]")).toHaveLength(6);
    await expect(canvasElement.querySelector(".bk-uncertain"), "M2: no mark anywhere").toBeNull();
  },
});
