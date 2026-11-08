import preview from "#.storybook/preview";
import { expect, fn, userEvent } from "storybook/test";

import { MicButton, type MicPhase } from "../../src/voice/MicButton.js";
import { VoiceControlButton } from "../../src/voice/VoiceControlButton.js";
import { VoiceField, VoiceText } from "../../src/voice/VoiceField.js";
import type { VoiceTone } from "../../src/voice/tone.js";
import { stage } from "../_stage.js";
import { reducedMotion, voiceA11y } from "./_checks.js";
import { liveControls } from "./_voice.js";

/**
 * The voice controls (#3692): the composer mic with its hold ring, and the
 * raised round buttons. Every control is 44px, has a name, and shows the
 * kit's focus ring on every fill.
 */
const meta = preview.meta({
  title: "Voice/Controls",
  decorators: [stage],
});

const PHASES: MicPhase[] = ["idle", "pressed", "holding", "complete"];

/** The mic's four phases: idle, pressed, holding (ring from `progress`), complete. */
export const MicPhases = meta.story({
  render: () => (
    <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
      {PHASES.map((phase) => <MicButton key={phase} phase={phase} progress={0.6} name={`Dictate, ${phase}`} onClick={fn()} />)}
    </div>
  ),
  play: async ({ canvasElement }) => {
    await voiceA11y(canvasElement);
    const progress = [...canvasElement.querySelectorAll(".bk-voice-ring")].map((r) => r.getAttribute("data-progress"));
    await expect(progress, "ring only while holding or complete").toEqual(["0.6", "1"]);
  },
});

/** The hold hint floats above the mic and is not a target. */
export const MicWithHint = meta.story({
  render: () => <div style={{ paddingTop: 44 }}><MicButton phase="holding" progress={0.3} hint onClick={fn()} /></div>,
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Keep holding to talk live")).toBeVisible();
  },
});

/** Keyboard and screen readers: "Talk live…" stays out of sight until it takes focus. */
export const TalkLiveAction = meta.story({
  render: () => <div style={{ paddingTop: 52 }}><MicButton onClick={fn()} onTalkLive={fn()} /></div>,
  play: async ({ canvas }) => {
    const talk = canvas.getByRole("button", { name: "Talk live…" });
    await expect(talk.getBoundingClientRect().width, "out of sight at rest").toBeLessThanOrEqual(1);
    await userEvent.tab();
    await expect(talk).toHaveFocus();
    await expect(talk.getBoundingClientRect().height, "44px when focused").toBeGreaterThanOrEqual(44);
    await expect(getComputedStyle(talk).outlineStyle).toBe("solid");
  },
});

/** Rest, pressed (solid), disabled, End, the amber ✓ and the ✓ while finishing. */
export const ControlButtons = meta.story({
  render: () => (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
      <VoiceControlButton name="Mute" icon="mic" pressed={false} onClick={fn()} />
      <VoiceControlButton name="Unmute" icon="mic-off" pressed onClick={fn()} />
      <VoiceControlButton name="Interrupt" icon="interrupt" disabled />
      <VoiceControlButton name="End" icon="dismiss" tone="end" onClick={fn()} />
      <VoiceControlButton name="Finish dictation" icon="confirm" tone="you" onClick={fn()} />
      <VoiceControlButton name="Finishing dictation" icon="confirm" tone="you" busy />
    </div>
  ),
  play: async ({ canvas, canvasElement }) => {
    await voiceA11y(canvasElement);
    await expect(canvas.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByRole("button", { name: "Interrupt" })).toBeDisabled();
  },
});

const TONES: VoiceTone[] = ["you", "brain", "idle", "fail"];

/**
 * The focus ring on every fill: each control, tabbed to inside a field of each
 * tone, draws the kit's 2px ring.
 */
export const FocusOnEveryFill = meta.story({
  render: () => (
    <>
      {TONES.map((tone) => (
        <VoiceField key={tone} shape="tall" tone={tone} name={`${tone} field`} label={{ icon: "mic", word: tone }} meter="level" level={0.5} controls={liveControls({ interrupt: true })} />
      ))}
      <VoiceField shape="compact" tone="you" name="compact field" label={{ icon: "mic", word: "Listening" }} meter="level" level={0.5} trailing={<VoiceControlButton name="Finish dictation" icon="confirm" tone="you" onClick={fn()} />}>
        <VoiceText text="Ask Calypso" />
      </VoiceField>
    </>
  ),
  play: async ({ canvasElement }) => {
    const buttons = [...canvasElement.querySelectorAll("button")];
    await expect(buttons.length).toBe(TONES.length * 3 + 1);
    for (const button of buttons) {
      await userEvent.tab();
      await expect(button).toHaveFocus();
      const style = getComputedStyle(button);
      await expect(`${style.outlineStyle} ${style.outlineWidth}`, `${button.getAttribute("aria-label")} ring`).toBe("solid 2px");
    }
  },
});

/** Reduced motion: the ring follows progress without easing; the ✓ does not turn. */
export const ReducedMotion = meta.story({
  render: () => (
    <div data-motion="reduce" style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <MicButton phase="holding" progress={0.6} onClick={fn()} motion="reduce" />
      <VoiceControlButton name="Finishing dictation" icon="confirm" tone="you" busy />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await reducedMotion(canvasElement);
  },
});
