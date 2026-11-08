import { useId } from "react";

import { Icon, type IconName } from "../primitives/Icon.js";
import { VoiceField } from "./VoiceField.js";
import type { VoiceMotion, VoiceTone } from "./tone.js";

export interface VoiceNoticeAction {
  label: string;
  onClick?: () => void;
  /** A solid action in the speaker's colour (Try again, Start again). */
  tone?: "you" | "brain";
}

export interface VoiceNoticeProps {
  tone?: VoiceTone;
  icon: IconName;
  title: string;
  /** One line, in plain words. No codes. */
  body?: string;
  /** Up to two. A third is dropped: a notice is not a menu. */
  actions?: VoiceNoticeAction[];
  /** Announce the notice when it appears. The integrated app decides (#3701). */
  live?: "polite" | "assertive";
  motion?: VoiceMotion;
}

/**
 * A notice in the voice field's card shape: an icon, a title, one line and up
 * to two actions. Used for microphone access, failures, an unavailable live
 * service and a stopped conversation.
 */
export function VoiceNotice(p: VoiceNoticeProps) {
  const titleId = useId();
  const actions = (p.actions ?? []).slice(0, 2);
  return (
    <VoiceField shape="card" tone={p.tone ?? "idle"} name={p.title} motion={p.motion}>
      <div className="bk-voice-notice-head" role={p.live ? (p.live === "assertive" ? "alert" : "status") : undefined} aria-labelledby={titleId}>
        <span className="bk-voice-notice-icon" aria-hidden="true">
          <Icon icon={p.icon} size={14} strokeWidth={2.5} />
        </span>
        <div style={{ minWidth: 0 }}>
          <p className="bk-voice-notice-title" id={titleId}>{p.title}</p>
          {p.body ? <p className="bk-voice-notice-body">{p.body}</p> : null}
        </div>
      </div>
      {actions.length ? (
        <div className="bk-voice-actions">
          {actions.map((a) => (
            <button key={a.label} type="button" className="bk-voice-action" data-tone={a.tone} onClick={a.onClick}>
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
    </VoiceField>
  );
}
