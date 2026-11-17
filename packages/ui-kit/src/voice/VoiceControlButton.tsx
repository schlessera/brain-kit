import { Icon, type IconName } from "../primitives/Icon.js";

export interface VoiceControlButtonProps {
  /** The accessible name, in every state. */
  name: string;
  icon: IconName;
  /**
   * `neutral` is a raised grey control (Mute, Interrupt), `end` the only red
   * one, `you` the amber ✓ that finishes dictation, `brain` a teal one.
   */
  tone?: "neutral" | "end" | "you" | "brain";
  /** A toggle that is on (Mute while muted): solid, and `aria-pressed`. */
  pressed?: boolean;
  disabled?: boolean;
  /** Replaces the icon with a turning one (the ✓ while dictation finishes). */
  busy?: boolean;
  onClick?: () => void;
}

/**
 * A raised round voice control: 44px, lifted off the meter by a soft shadow
 * and a lit top edge, with a pressed (solid) and a disabled treatment.
 */
export function VoiceControlButton(p: VoiceControlButtonProps) {
  const tone = p.tone ?? "neutral";
  return (
    <button
      type="button"
      className="bk-voice-ctl"
      data-tone={tone === "neutral" ? undefined : tone}
      aria-label={p.name}
      aria-pressed={p.pressed === undefined ? undefined : p.pressed}
      aria-busy={p.busy || undefined}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      {p.busy ? (
        <span className="bk-voice-ctl-spin" aria-hidden="true"><Icon icon="loading" size={18} strokeWidth={2.25} /></span>
      ) : (
        <Icon icon={p.icon} size={18} strokeWidth={2.25} />
      )}
    </button>
  );
}
