import type { ReactNode } from "react";

import { Icon } from "../primitives/Icon.js";

export type Speaker = "you" | "brain";

export interface SpokenMarkProps {
  speaker: Speaker;
}

/**
 * The inline mark on a spoken turn: an amber mic for you, a teal speaker for
 * brain. A typed turn carries none.
 */
export function SpokenMark(p: SpokenMarkProps) {
  return (
    <span className="bk-spoken-mark" data-speaker={p.speaker} role="img" aria-label={p.speaker === "you" ? "Spoken by you" : "Spoken by brain"}>
      <Icon icon={p.speaker === "you" ? "mic" : "speaker"} size={13} strokeWidth={2.25} />
    </span>
  );
}

export interface SpokenTurnProps {
  speaker: Speaker;
  /** Still being recognized: an outlined bubble with a cursor. You only. */
  inProgress?: boolean;
  /** Brain was talked over: a quiet "cut off" tag after the played words. */
  cutOff?: boolean;
  children?: ReactNode;
}

/**
 * A spoken turn in the chat. It reads like any other message, with a small
 * inline mark. Yours is a bubble; brain's is prose, as a typed answer is.
 */
export function SpokenTurn(p: SpokenTurnProps) {
  const body = (
    <>
      <SpokenMark speaker={p.speaker} />
      {p.children}
      {p.inProgress && p.speaker === "you" ? <span className="bk-voice-cursor" aria-hidden="true" /> : null}
      {p.cutOff ? <CutOffTag /> : null}
    </>
  );
  return (
    <div className="bk-spoken-turn" data-speaker={p.speaker}>
      {p.speaker === "you" ? (
        <div className="bk-spoken-bubble" data-in-progress={p.inProgress ? "true" : undefined} aria-busy={p.inProgress || undefined}>{body}</div>
      ) : (
        <div className="bk-spoken-prose">{body}</div>
      )}
    </div>
  );
}

export interface UncertainWordProps {
  children: ReactNode;
  /** Opens the alternatives. Without it the word is marked, not a control. */
  onClick?: () => void;
}

/**
 * A word recognition was not sure of: a dotted underline, and the word
 * "uncertain" for a screen reader. Only where the result carries confidence or
 * alternatives; uncertainty is never invented.
 */
export function UncertainWord(p: UncertainWordProps) {
  const word = (
    <span className="bk-uncertain">
      {p.children}
      <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" }}> (uncertain)</span>
    </span>
  );
  return p.onClick ? (
    <button type="button" className="bk-uncertain-btn" onClick={p.onClick}>{word}</button>
  ) : (
    word
  );
}

/** Reply text not yet played aloud: dimmed, and only where the playback
 * position is known. */
export function UnplayedText({ children }: { children: ReactNode }) {
  return (
    <span className="bk-unplayed">
      <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" }}>(not played) </span>
      {children}
    </span>
  );
}

/** Brain was talked over here. */
export function CutOffTag({ label = "cut off" }: { label?: string }) {
  return (
    <span className="bk-cut-off">
      <Icon icon="interrupt" size={9} strokeWidth={3} />
      {label}
    </span>
  );
}

export interface VoiceToolChipProps {
  label: string;
  /** `running` turns; `done` is ticked. */
  state?: "running" | "done";
}

/** Tool work during a live conversation, as a chip in the chat. */
export function VoiceToolChip(p: VoiceToolChipProps) {
  const running = p.state === "running";
  return (
    <span className="bk-voice-tool" aria-busy={running || undefined}>
      <span className={running ? "bk-voice-label-icon bk-voice-spin" : "bk-voice-label-icon"} aria-hidden="true">
        <Icon icon={running ? "loading" : "confirm"} size={12} strokeWidth={2.5} />
      </span>
      {p.label}
    </span>
  );
}

/** Where a live conversation ended: `Live · 1:12 · Ithaca steward`. */
export function ConversationEndDivider({ label }: { label: string }) {
  return (
    <div className="bk-voice-divider" role="separator" aria-label={`Live conversation ended: ${label}`}>
      <span className="bk-voice-label-icon" aria-hidden="true"><Icon icon="speaker" size={11} strokeWidth={2.5} /></span>
      <span aria-hidden="true">{label}</span>
    </div>
  );
}
