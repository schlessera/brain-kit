import type { ReactNode } from "react";
import { color, font, accent } from "../tokens.js";
import { Button } from "../primitives/Button.js";
import { StatusDot } from "../primitives/StatusDot.js";

export type RecordingRowState = "recording" | "saved" | "interrupted" | "transcribing" | "transcript-ready" | "failed" | "accepted";
export interface RecordingRowProps {
  time: string;
  length: string;
  state: RecordingRowState;
  /** The end of the last committed chunk, formatted as m:ss. */
  savedThrough?: string;
  /** A recovered audio prefix may accompany a still-reviewable transcript. */
  interrupted?: boolean;
  /** Human-readable length for accessible action names. */
  durationLabel: string;
  offline?: boolean;
  onPlay?: () => void;
  onDiscard?: () => void;
  children?: ReactNode;
}

/** A local recording is the record: words wrap, and every state is named. */
export function RecordingRow(p: RecordingRowProps) {
  const state = p.state === "transcript-ready" ? "transcript ready" : p.state;
  const name = `recording from ${p.time}, ${p.durationLabel}`;
  return (
    <div data-recording-row="" style={{ border: `1px solid ${color.edge}`, borderRadius: 12, padding: 12, background: color.surface, color: color.ink, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, font: `500 12px/1.5 ${font.mono}` }}>
        <StatusDot tone={p.state === "interrupted" || p.state === "failed" ? "amber" : "neutral"} pulse={p.state === "recording"} />
        <span>{p.time} · {p.length}</span>
        <b style={{ color: p.state === "interrupted" || p.state === "failed" ? accent.amber.ink : color.inkMute }}>{state}</b>
      </div>
      {(p.state === "interrupted" || p.interrupted) && <p style={{ margin: "6px 0", font: `400 12px/1.5 ${font.body}`, color: color.inkMute }}>saved up to {p.savedThrough} — the end may be missing</p>}
      {p.children ?? <>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          {p.onPlay && <Button label="Play" ariaLabel={`Play ${name}`} tone="ghost" block={false} style={{ minHeight: 44, minWidth: 44 }} onClick={p.onPlay} />}
          {p.onDiscard && <Button label="Discard…" ariaLabel={`Discard ${name}`} tone="quiet" block={false} style={{ minHeight: 44, minWidth: 44 }} onClick={p.onDiscard} />}
        </div>
        <p style={{ margin: "8px 0 0", font: `400 12px/1.5 ${font.body}`, color: color.inkMute }}>
          {p.offline ? "Transcribe · needs the host" : "Transcribing saved recordings isn\u0027t available on this server yet. Your recording is kept. Play it back and type, or keep it for later."}
        </p>
      </>}
    </div>
  );
}
