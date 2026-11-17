import type { KeyboardEvent, PointerEvent } from "react";

import { Icon } from "../primitives/Icon.js";
import { clampLevel } from "./VoiceMeter.js";
import { motionAttr, type VoiceMotion } from "./tone.js";

/**
 * `idle` at rest; `pressed` the instant a finger lands; `holding` while the
 * ring fills; `complete` when it has closed.
 */
export type MicPhase = "idle" | "pressed" | "holding" | "complete";

export interface MicButtonProps {
  phase?: MicPhase;
  /** 0–1: how much of the hold ring is drawn. The caller drives it from time. */
  progress?: number;
  /** Show "Keep holding to talk live" above the mic. */
  hint?: boolean;
  /** The accessible name. Tapping dictates. */
  name?: string;
  /** The hint's words. */
  hintLabel?: string;
  /** Click / Enter / Space: dictate. */
  onClick?: () => void;
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel?: (event: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /**
   * The keyboard and screen-reader way to start a live conversation: a
   * "Talk live…" button that stays out of sight until it takes focus.
   */
  onTalkLive?: () => void;
  talkLiveLabel?: string;
  disabled?: boolean;
  motion?: VoiceMotion;
}

const R = 20;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * The one composer mic (#3692): tap to dictate, hold to talk live.
 *
 * Presentational only. It draws the four phases and the ring from `progress`,
 * and hands every pointer and key event to the caller, which owns the hold
 * timer and decides what a release means. Nothing here starts capture.
 */
export function MicButton(p: MicButtonProps) {
  const phase = p.phase ?? "idle";
  const progress = phase === "complete" ? 1 : phase === "holding" ? clampLevel(p.progress) : 0;
  const ring = phase === "holding" || phase === "complete";
  return (
    <span className="bk-voice-mic-wrap" data-motion={motionAttr(p.motion)}>
      {p.hint ? (
        <span className="bk-voice-hint" aria-hidden="true">
          <Icon icon="speaker" size={13} strokeWidth={2.25} />
          {p.hintLabel ?? "Keep holding to talk live"}
        </span>
      ) : null}
      {p.onTalkLive ? (
        <button type="button" className="bk-voice-talk-live" onClick={p.onTalkLive}>
          <Icon icon="speaker" size={13} strokeWidth={2.25} />
          {p.talkLiveLabel ?? "Talk live…"}
        </button>
      ) : null}
      <button
        type="button"
        className="bk-voice-mic"
        data-phase={phase}
        aria-label={p.name ?? "Dictate"}
        disabled={p.disabled}
        onClick={p.onClick}
        onPointerDown={p.onPointerDown}
        onPointerUp={p.onPointerUp}
        onPointerLeave={p.onPointerLeave}
        onPointerCancel={p.onPointerCancel}
        onKeyDown={p.onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className="bk-voice-mic-disc">
          <Icon icon="mic" size={17} strokeWidth={2.25} />
        </span>
        {ring ? (
          <svg className="bk-voice-ring" viewBox="0 0 44 44" aria-hidden="true" data-progress={progress}>
            <circle className="bk-voice-ring-track" cx="22" cy="22" r={R} />
            <circle
              className="bk-voice-ring-fill"
              cx="22"
              cy="22"
              r={R}
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - progress)}
            />
          </svg>
        ) : null}
      </button>
    </span>
  );
}
