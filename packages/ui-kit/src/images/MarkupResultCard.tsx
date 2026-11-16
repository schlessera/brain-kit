/**
 * The markup receipt (#3983): what the user drew, as a receipt rather than a
 * path (design-feedback.md §2, the rule the mask card follows).
 *
 * A teal "Markup drawn · by you" surface: the hatched source placeholder (no
 * remote source image loads inline) with the markup PNG laid over it, then the
 * rows — marks, notes, size, source and layer. When the layer cannot be shown
 * (no URL, or the browser could not load it) the thumb says
 * "markup not rendered" instead of passing off an empty frame as a drawing.
 *
 * The card is a pure function of the successful drawing's facts. A later
 * `brain image --markup` failure belongs to that tool's own card and never
 * rewrites this one, so there is deliberately no failure prop.
 *
 * `MarkupFallback` states a decline or refusal from the result's own words in
 * the kit's red boxed mono `Callout`.
 */

import { useState, type CSSProperties } from "react";

import { Receipt, type ReceiptRow } from "../evidence/Receipt.js";
import { Callout } from "../primitives/Callout.js";
import { Surface } from "../primitives/Surface.js";
import { color, font } from "../tokens.js";
import { describeCounts, markupBytesLabel, type MarkupCounts } from "./markup.js";

export const MARKUP_NOT_RENDERED = "markup not rendered";
/** Notes quoted in the receipt before the rest are counted. */
export const MARKUP_RECEIPT_NOTES = 3;

export interface MarkupResultCardProps {
  /** Repo-relative source path. */
  imagePath: string;
  /** Repo-relative path of the written layer. */
  markupPath: string;
  width: number;
  height: number;
  bytes: number;
  marks: MarkupCounts;
  /** Note texts, in placement order. */
  notes: readonly string[];
  /** A URL the layer loads from; omitted, the thumb says it is not rendered. */
  markupSrc?: string;
  /** True when the integration verified the layer's size against the source. */
  matchesSource?: boolean;
}

const THUMB_W = 160;
const THUMB_H = 100;
const HATCH = `repeating-linear-gradient(135deg,${color.raised} 0 6px,var(--bk-hatch-stripe) 6px 12px)`;

export function markupReceiptRows(p: MarkupResultCardProps): ReceiptRow[] {
  const rows: ReceiptRow[] = [{ k: "marks", v: describeCounts(p.marks), tone: "teal" }];
  if (p.notes.length > 0) {
    const quoted = p.notes.slice(0, MARKUP_RECEIPT_NOTES).map(n => `“${n}”`).join(" · ");
    const more = p.notes.length - MARKUP_RECEIPT_NOTES;
    rows.push({ k: "notes", v: more > 0 ? `${quoted} · +${more} more` : quoted });
  }
  rows.push({ k: "size", v: `${p.width} × ${p.height} px${p.matchesSource ? " · matches source" : ""}` });
  rows.push({ k: "source", v: p.imagePath });
  rows.push({ k: "layer", v: `${p.markupPath} · ${markupBytesLabel(p.bytes)}` });
  return rows;
}

export function MarkupResultCard(p: MarkupResultCardProps) {
  const [state, setState] = useState<"loading" | "shown" | "failed">("loading");
  const canShow = Boolean(p.markupSrc) && p.bytes > 0;
  const shown = canShow && state === "shown";
  const frame: CSSProperties = {
    position: "relative",
    width: "100%",
    maxWidth: THUMB_W * 2,
    aspectRatio: `${THUMB_W} / ${THUMB_H}`,
    borderRadius: 9,
    border: `1px solid ${color.edge}`,
    background: HATCH,
    overflow: "hidden",
  };
  const note: CSSProperties = { font: `400 10.5px/1.5 ${font.mono}`, color: color.inkMute };
  return (
    <Surface tone="teal" label="Markup drawn" labelIcon="confirm" meta="by you" pad={12}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div
          role="img"
          aria-label={shown ? `Markup ${p.markupPath} over the source ${p.imagePath}` : `Source ${p.imagePath}; the markup is in ${p.markupPath}`}
          style={frame}
          data-markup-thumb=""
        >
          {canShow ? (
            <img
              src={p.markupSrc}
              alt=""
              onLoad={() => setState("shown")}
              onError={() => setState("failed")}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", visibility: shown ? "visible" : "hidden" }}
              data-markup-overlay=""
              data-markup-shown={shown ? "" : undefined}
            />
          ) : null}
        </div>
        {!canShow || state === "failed" ? <div style={note}>{MARKUP_NOT_RENDERED}</div> : null}
        {/* A receipt of what was drawn: no grant header, no grant scope line. */}
        <Receipt keyWidth={58} title="" footnote="" rows={markupReceiptRows(p)} />
      </div>
    </Surface>
  );
}

export interface MarkupFallbackProps {
  /** The source the markup was requested on, when known. */
  imagePath?: string;
  /** The result's own words: "The user closed the markup editor", a voice refusal, a changed source. */
  reason: string;
}

export function MarkupFallback(p: MarkupFallbackProps) {
  return (
    <Callout
      tone="red"
      variant="boxed"
      mono
      text={`no markup drawn${p.imagePath ? ` on ${p.imagePath}` : ""} · ${p.reason.trim()}`}
    />
  );
}
