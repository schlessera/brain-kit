import type { CSSProperties, KeyboardEvent } from "react";

import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { AttachmentKind, AttachmentTone } from "../types.js";

/**
 * What the user sent in, rendered as what it IS.
 *
 * An image gets a hatched placeholder plus its OCR extract — Brain reads
 * pictures, it does not display them inline. A voice memo gets a waveform
 * derived from its own duration and the transcript underneath. A document gets
 * its page count. Anything from outside the corpus carries the purple
 * provenance line, and passing `trust` turns the card's border purple too.
 *
 * **The waveform is deterministic by design**: `4 + |sin((i + 1) · 1.7 +
 * seconds)| · 13`. The same clip always draws the same shape, which is what
 * makes the component screenshot-stable and lets a visual-regression baseline
 * exist at all. It is not a real amplitude envelope and does not pretend to
 * be; it is a mark that a recording of THIS length is here.
 *
 * **Interaction states landed in wave 1b**, the wave D17 named for them. The
 * design ships none for this component, so what it gets is the system's —
 * `.bk-row` at the −2 ring offset, because an attachment card is a full-width
 * block and a ring at +2 is clipped by the first `overflow: hidden` ancestor,
 * which in this kit is every `Surface`.
 *
 * Opening an attachment is navigation, not an effect, so the whole card is one
 * `role="button"` and carries no effect chip. Gated on the handler like
 * everything else: no `onClick`, no class, no role, no tab stop, no ring.
 */
export interface AttachmentRowProps {
  kind?: AttachmentKind;
  /** What the thing is called. `name` is reserved in the design's runtime. */
  label?: string;
  duration?: string;
  /** Drives the waveform's shape, and only that. */
  seconds?: number;
  /** 0-1. The fraction of the waveform drawn in the accent. */
  played?: number;
  meta?: string;
  /** The line worth pulling out of it — a transcript, an OCR read. */
  extract?: string;
  /** Provenance. Its PRESENCE is what makes the card purple. */
  trust?: string;
  /** Pass `""` to draw none. */
  actionIcon?: IconName | "";
  tone?: AttachmentTone;
  thumbSize?: number;
  waveBars?: number;
  onClick?: () => void;
}

/** Each kind's glyph, accent and trailing affordance. */
const KINDS: Record<AttachmentKind, { icon: IconName; tone: AttachmentTone; action: IconName }> = {
  image: { icon: "image", tone: "teal", action: "expand" },
  audio: { icon: "mic", tone: "amber", action: "run" },
  doc: { icon: "file", tone: "teal", action: "next" },
  link: { icon: "link", tone: "purple", action: "next" },
};

const INKS: Record<AttachmentTone, string> = {
  teal: accent.teal.ink,
  amber: accent.amber.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  neutral: accent.neutral.ink,
};

const THUMB_TINTS: Record<AttachmentTone, string> = {
  teal: token("attach-thumb-tint-teal"),
  amber: token("attach-thumb-tint-amber"),
  purple: token("attach-thumb-tint-purple"),
  blue: token("attach-thumb-tint-blue"),
  neutral: token("attach-thumb-tint-neutral"),
};

const THUMB_BORDERS: Record<AttachmentTone, string> = {
  teal: token("attach-thumb-border-teal"),
  amber: token("attach-thumb-border-amber"),
  purple: token("attach-thumb-border-purple"),
  blue: token("attach-thumb-border-blue"),
  neutral: token("attach-thumb-border-neutral"),
};

export function AttachmentRow(p: AttachmentRowProps) {
  const kind = p.kind || "audio";
  const k = KINDS[kind] || KINDS.doc;
  const tone = p.tone || k.tone;
  const ink = INKS[tone] || INKS.teal;
  const size = Number(p.thumbSize) || 44;
  const bars = Number(p.waveBars) || 22;

  const secs = Number(p.seconds ?? (kind === "audio" ? 38 : 0)) || 0;
  const played = Number(p.played ?? (kind === "audio" ? 0.35 : 0)) || 0;

  const label = p.label ?? "Sailing directions";
  const meta = p.meta ?? (kind === "audio" ? "captured 06:12 · transcribed on device" : null);
  const extract =
    p.extract ??
    (kind === "audio"
      ? "“Keep the Great Bear on your left hand, and do not correct it at night.”"
      : null);
  const duration = p.duration ?? (kind === "audio" ? "0:38" : null);
  const actionIcon = p.actionIcon === "" ? null : p.actionIcon || k.action;

  const box: CSSProperties = {
    border: `1px solid ${p.trust ? token("provenance-border") : color.edge}`,
    background: color.surface,
    borderRadius: 13,
    padding: 11,
    boxSizing: "border-box",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 9,
    cursor: p.onClick ? "pointer" : "default",
    // Rest is `surface`; hover is the design's one step up.
    ...({ "--hv-bg": p.onClick ? color.raised : color.surface } as CSSProperties),
  };
  const thumb: CSSProperties = {
    width: size,
    height: size,
    borderRadius: 9,
    flex: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background:
      kind === "image"
        ? `repeating-linear-gradient(135deg,${color.raised} 0 6px,${token("hatch-stripe")} 6px 12px)`
        : THUMB_TINTS[tone] || THUMB_TINTS.teal,
    border: `1px solid ${kind === "image" ? color.edge : THUMB_BORDERS[tone] || THUMB_BORDERS.teal}`,
  };

  const act = Boolean(p.onClick);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    p.onClick?.();
  }

  return (
    <div
      style={box}
      className={act ? "bk-row" : undefined}
      role={act ? "button" : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={p.onClick}
      onKeyDown={act ? onKeyDown : undefined}
    >
      <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
        <span style={thumb}>
          <Icon icon={k.icon} size={18} color={ink} />
        </span>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <b
              style={{
                flex: 1,
                minWidth: 0,
                font: `600 12.5px/1.35 ${font.body}`,
                color: color.ink,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </b>
            {duration ? (
              <span style={{ flex: "none", font: `500 10px/1.3 ${font.mono}`, color: ink }}>
                {duration}
              </span>
            ) : null}
          </div>
          {kind === "audio" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 2, height: 18 }}>
              {Array.from({ length: bars }).map((_, i) => (
                <span
                  key={i}
                  style={{
                    display: "block",
                    width: 2,
                    // Deterministic: the same clip always draws the same shape.
                    height: Math.round(4 + Math.abs(Math.sin((i + 1) * 1.7 + secs)) * 13),
                    borderRadius: 2,
                    flex: "none",
                    background: i / bars < played ? ink : color.edge,
                  }}
                />
              ))}
            </div>
          ) : null}
          {meta ? (
            <span style={{ font: `400 10px/1.4 ${font.mono}`, color: accent.neutral.ink }}>
              {meta}
            </span>
          ) : null}
        </div>
        {actionIcon ? <Icon icon={actionIcon} size={16} color={accent.neutral.ink} /> : null}
      </div>
      {extract ? (
        <div
          style={{
            background: token("inset-well-bg"),
            border: `1px solid ${color.line}`,
            borderRadius: 8,
            padding: "8px 10px",
            font: `400 11px/1.6 ${font.body}`,
            color: color.inkDim,
          }}
        >
          {extract}
        </div>
      ) : null}
      {p.trust ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            paddingTop: 9,
            borderTop: `1px solid ${color.line}`,
            font: `500 9.5px/1.4 ${font.mono}`,
            color: accent.purple.ink,
          }}
        >
          <Icon icon="trust" size={12} color={accent.purple.ink} />
          {p.trust}
        </div>
      ) : null}
    </div>
  );
}
