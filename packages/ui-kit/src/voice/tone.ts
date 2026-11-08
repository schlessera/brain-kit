import { accent, token } from "../tokens.js";

/**
 * The voice surface's one colour language (#3692), shared by dictation and
 * live conversation so the two can never drift apart:
 *
 *   you    amber  you and your mic
 *   brain  teal   brain and its voice
 *   idle   grey   nothing is being heard
 *   fail   red    only End and failures
 *
 * The values live in `tokens.css` (`--bk-voice-*`) and are applied there by
 * `data-tone` on any element carrying `.bk-voice-tone`. This table names the
 * same tokens for a consumer that needs one outside the voice components.
 */
export type VoiceTone = "you" | "brain" | "idle" | "fail";

export interface VoiceSkin {
  /** The state word and icon. */
  ink: string;
  /** The field's fill. */
  tint: string;
  /** The field's outline. */
  border: string;
  /** The level meter behind the words. */
  bar: string;
}

export const VOICE_SKINS: Readonly<Record<VoiceTone, VoiceSkin>> = {
  you: { ink: accent.amber.ink, tint: token("voice-tint-you"), border: token("voice-border-you"), bar: token("voice-bar-you") },
  brain: { ink: accent.teal.ink, tint: token("voice-tint-brain"), border: token("voice-border-brain"), bar: token("voice-bar-brain") },
  idle: { ink: token("color-ink-dim"), tint: token("voice-tint-idle"), border: token("voice-border-idle"), bar: token("voice-bar-idle") },
  fail: { ink: accent.red.ink, tint: token("voice-tint-fail"), border: token("voice-border-fail"), bar: token("voice-border-fail") },
};

/** `auto` follows `prefers-reduced-motion`; `reduce` forces the static form. */
export type VoiceMotion = "auto" | "reduce";

/** The `data-motion` attribute a voice root carries, or nothing for `auto`. */
export function motionAttr(motion: VoiceMotion | undefined): "reduce" | undefined {
  return motion === "reduce" ? "reduce" : undefined;
}
