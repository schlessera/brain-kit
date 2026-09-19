/**
 * The `request_image_mask` result: a receipt, not a path (D38 §2).
 *
 * The source thumb — hatched, as everywhere: no remote image loads inline —
 * with the drawn region over it in teal, because the region is the user's own
 * answer, stacked ABOVE a kit `Receipt` (the truncation rule: a receipt value
 * column under ~160px means change the layout, not the break rule).
 *
 * Typed `ImageMaskPayload`, so the rows are the fields the handler actually
 * sends: `imagePath`, `maskPath`, `bytes`. The design also draws a region and
 * a coverage row; the payload carries neither yet, so the card draws the
 * region only when a caller supplies one and prints no coverage. Nothing here
 * is invented — a mask that silently became "whole image" is how an answer
 * ends up citing the wrong half of a whiteboard.
 *
 * Failure is a fact about the evidence, not a dialog: a declined or failed
 * mask comes back as a tool error with a message, and `ImageMaskFallback`
 * states it in a red boxed mono `Callout` from the result's own words.
 */

import type { CSSProperties } from "react";
import { Callout, Receipt, Surface, color, type ReceiptRow } from "@schlessera/brain-ui-kit";
import type { ImageMaskPayload, ToolCallView } from "@schlessera/brain-ui-sdk/client";
import { ClampedPre } from "../tool-views.js";

/** A normalised rectangle over the source image: every value in 0..1. */
export interface MaskRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

const THUMB_W = 160;
const THUMB_H = 100;

/** The kit's image placeholder: raised stripes on the surface, no pixels. */
const HATCH = `repeating-linear-gradient(135deg,${color.raised} 0 6px,var(--bk-hatch-stripe) 6px 12px)`;

function bytesLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * The thumb with the drawn region over it. Exported for the view test; the
 * bound card passes no `region` because the payload carries none.
 */
export function MaskThumb({ region, label }: { region?: MaskRegion; label: string }) {
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
  const drawn: CSSProperties | undefined = region
    ? {
        position: "absolute",
        left: `${region.x * 100}%`,
        top: `${region.y * 100}%`,
        width: `${region.w * 100}%`,
        height: `${region.h * 100}%`,
        border: "1.5px dashed var(--bk-teal-ink)",
        background: "rgba(91,181,162,0.18)",
        borderRadius: 3,
        boxSizing: "border-box",
      }
    : undefined;
  return (
    <div role="img" aria-label={label} style={frame} data-mask-thumb>
      {drawn ? <div style={drawn} data-mask-region /> : null}
    </div>
  );
}

/** The rows the receipt prints — only the facts the result carries. */
export function maskReceiptRows(payload: ImageMaskPayload, region?: MaskRegion): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  if (region) {
    rows.push({
      k: "region",
      v: `${pct(region.x)},${pct(region.y)} → ${pct(region.x + region.w)},${pct(region.y + region.h)}`,
      tone: "teal",
    });
    rows.push({ k: "covers", v: `${pct(region.w * region.h)} of the image`, tone: "teal" });
  }
  rows.push({ k: "source", v: payload.imagePath });
  rows.push({ k: "mask", v: `${payload.maskPath} · ${bytesLabel(payload.bytes)}` });
  return rows;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function ImageMaskResultCard(payload: ImageMaskPayload & { region?: MaskRegion }) {
  const region = payload.region;
  return (
    <Surface tone="teal" label="Mask drawn" labelIcon="confirm" meta="by you" pad={12}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <MaskThumb
          region={region}
          label={
            region
              ? `Source ${payload.imagePath} with the drawn region`
              : `Source ${payload.imagePath}; the mask is in ${payload.maskPath}`
          }
        />
        <Receipt keyWidth={58} rows={maskReceiptRows(payload, region)} />
      </div>
    </Surface>
  );
}

/**
 * No payload: the user declined, the editor failed, or an older server
 * answered with a sentence. An error is stated as a fact in red; anything
 * else is shown as the text it is.
 */
export function ImageMaskFallback({ tool }: { tool: ToolCallView }) {
  if (!tool.output) return null;
  if (!tool.isError) return <ClampedPre text={tool.output} />;
  const source = typeof tool.input.imagePath === "string" ? tool.input.imagePath : null;
  return (
    <Callout
      tone="red"
      variant="boxed"
      mono
      text={`no mask drawn${source ? ` on ${source}` : ""} · ${tool.output.trim()}`}
    />
  );
}
