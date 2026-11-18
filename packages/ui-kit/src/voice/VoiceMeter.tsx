import type { CSSProperties } from "react";

import { motionAttr, type VoiceMotion } from "./tone.js";

/**
 * What the meter shows: the live `level` as bars, the thinking/working
 * `sweep`, a `flat` line (muted), the paused `hatch` (reconnecting), or
 * nothing.
 */
export type VoiceMeterMode = "level" | "sweep" | "flat" | "hatch" | "none";

export interface VoiceMeterProps {
  mode?: VoiceMeterMode;
  /** 0–1. Drives the bars, and under reduced motion the one static line. */
  level?: number;
  /** Bars across the band. */
  bars?: number;
  motion?: VoiceMotion;
}

/**
 * A fixed, deterministic contour, so a level reads as a voice rather than a
 * bar chart and every story and baseline paints the same bars. Multiplied by
 * `level`: at 0 every bar is its 2px floor.
 */
const CONTOUR = [
  0.35, 0.6, 0.45, 0.8, 0.55, 0.95, 0.4, 0.7, 0.5, 1, 0.65, 0.3, 0.75, 0.5, 0.9, 0.45, 0.6, 0.85, 0.4, 0.55, 0.95, 0.5,
  0.7, 0.35, 0.8, 0.6, 0.45, 1, 0.55, 0.4, 0.75, 0.6, 0.9, 0.5, 0.35, 0.7, 0.85, 0.45, 0.6, 0.4, 0.8, 0.55, 0.65, 0.3,
  0.7, 0.5, 0.9, 0.45,
];

export function clampLevel(level: number | undefined): number {
  if (level === undefined || !Number.isFinite(level)) return 0;
  return Math.min(1, Math.max(0, level));
}

/**
 * The level meter that sits behind the words in a `VoiceField`. Decorative:
 * the field's state label carries the state in an icon and a word, so the
 * meter is hidden from assistive technology.
 */
export function VoiceMeter(p: VoiceMeterProps) {
  const mode = p.mode ?? "level";
  if (mode === "none") return null;
  const level = clampLevel(p.level);
  const count = p.bars ?? CONTOUR.length;
  return (
    <div className="bk-voice-meter" data-mode={mode} data-motion={motionAttr(p.motion)} aria-hidden="true">
      {mode === "level" ? (
        <>
          <div className="bk-voice-bars">
            {Array.from({ length: count }, (_, i) => (
              <span key={i} className="bk-voice-bar" style={{ height: `${Math.round(CONTOUR[i % CONTOUR.length]! * level * 100)}%` }} />
            ))}
          </div>
          <div className="bk-voice-level" style={{ width: `calc((100% - 24px) * ${level})` } as CSSProperties} />
        </>
      ) : mode === "sweep" ? (
        <div className="bk-voice-sweep" />
      ) : mode === "flat" ? (
        <div className="bk-voice-flat" />
      ) : (
        <div className="bk-voice-hatch" />
      )}
    </div>
  );
}
