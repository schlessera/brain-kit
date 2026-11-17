import { Icon, type IconName } from "../primitives/Icon.js";

export interface VoiceStateLabelProps {
  icon: IconName;
  /** One word (or two): Listening, Thinking, Speaking, Muted… */
  word: string;
  /** Persona and elapsed time, in mono on the right: `Ithaca steward · 0:12`. */
  meta?: string;
  /** Turns the icon while the state is waiting on something (thinking, connecting). */
  spin?: boolean;
  /** Announce the word when it changes. The integrated app decides which (#3701). */
  live?: "polite" | "assertive";
}

/**
 * The field's state, as an icon and a word in the speaker's ink, with an
 * optional mono meta line. Never colour alone: every state has both.
 */
export function VoiceStateLabel(p: VoiceStateLabelProps) {
  return (
    <div className="bk-voice-label" data-voice-label="">
      <span className={p.spin ? "bk-voice-label-icon bk-voice-spin" : "bk-voice-label-icon"} aria-hidden="true">
        <Icon icon={p.icon} size={13} strokeWidth={2.25} />
      </span>
      <span aria-live={p.live} aria-atomic={p.live ? true : undefined} data-voice-word="">{p.word}</span>
      {p.meta ? <span className="bk-voice-label-meta">{p.meta}</span> : null}
    </div>
  );
}
