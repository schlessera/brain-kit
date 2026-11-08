import type { ReactNode } from "react";

import type { IconName } from "../primitives/Icon.js";
import { VoiceMeter, type VoiceMeterMode } from "./VoiceMeter.js";
import { VoiceStateLabel } from "./VoiceStateLabel.js";
import { motionAttr, type VoiceMotion, type VoiceTone } from "./tone.js";

export type VoiceFieldShape = "compact" | "tall" | "card";

export interface VoiceFieldLabel {
  icon: IconName;
  word: string;
  meta?: string;
  spin?: boolean;
  live?: "polite" | "assertive";
}

export interface VoiceFieldProps {
  /**
   * `compact` replaces the composer for dictation and keeps its height at rest;
   * with a `label` it is one fixed height (D3–D5 never move the page). `tall`
   * is the live panel, one fixed height for L1–L8. `card` grows to its
   * content, for the Start card and notices.
   */
  shape?: VoiceFieldShape;
  tone?: VoiceTone;
  /** The state as an icon and a word, with optional persona/elapsed meta. */
  label?: VoiceFieldLabel;
  meter?: VoiceMeterMode;
  /** 0–1, the input or output level the meter shows. */
  level?: number;
  /** Neutral, outlined: waiting for your tap (L6). */
  outline?: boolean;
  /** The accessible name of the field region. */
  name?: string;
  /** The words, a placeholder or a notice. */
  children?: ReactNode;
  /** `compact` only: the control at the end of the row (mic, ✓, send). */
  trailing?: ReactNode;
  /** `tall` only: the raised controls, bottom right. */
  controls?: ReactNode;
  motion?: VoiceMotion;
}

/**
 * The composer-replacing voice surface (#3692): the only place voice shows.
 *
 * Its fill, meter and label say who has the floor, in the one colour language
 * `VoiceTone` defines. It is presentational: no hooks, no client, no timers.
 * The caller maps its own state onto `tone`, `label`, `meter` and `level`.
 */
export function VoiceField(p: VoiceFieldProps) {
  const shape = p.shape ?? "compact";
  const label = p.label ? <VoiceStateLabel {...p.label} /> : null;
  return (
    <div
      role="group"
      aria-label={p.name ?? "Voice"}
      className="bk-voice-field bk-voice-tone"
      data-shape={shape}
      data-tone={p.tone ?? "idle"}
      data-labelled={p.label ? "true" : undefined}
      data-outline={p.outline ? "true" : undefined}
      data-motion={motionAttr(p.motion)}
    >
      {shape === "card" ? null : <VoiceMeter mode={p.meter ?? "none"} level={p.level} motion={p.motion} />}
      {shape === "compact" ? (
        <>
          <div className="bk-voice-body">
            {label}
            {p.children}
          </div>
          {p.trailing ? <div className="bk-voice-trailing">{p.trailing}</div> : null}
        </>
      ) : shape === "tall" ? (
        <>
          <div className="bk-voice-body">
            {label}
            {p.children}
          </div>
          {p.controls ? <div className="bk-voice-controls">{p.controls}</div> : null}
        </>
      ) : (
        <>
          {label}
          {p.children}
        </>
      )}
    </div>
  );
}

export interface VoiceTextProps {
  /** Words that have settled. */
  text?: string;
  /** Words still being recognized, muted until they settle. */
  partial?: string;
  /** Shown when there is nothing yet: `Message`, `Say something…`. */
  placeholder?: string;
  /** Rich content in place of `text` (a review with an uncertain word). */
  children?: ReactNode;
}

/**
 * The field's two-line text area, clamped to the newest words: the box is two
 * lines tall and bottom-aligned, so older words scroll up out of view.
 */
export function VoiceText(p: VoiceTextProps) {
  const empty = !p.text && !p.partial && p.children === undefined;
  return (
    <div className="bk-voice-text" data-voice-text="">
      <span>
        {empty ? <span className="bk-voice-text-placeholder">{p.placeholder ?? ""}</span> : null}
        {p.children ?? p.text}
        {p.partial ? <span className="bk-voice-text-partial">{p.text || p.children ? " " : ""}{p.partial}</span> : null}
      </span>
    </div>
  );
}
