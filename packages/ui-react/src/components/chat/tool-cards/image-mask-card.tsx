/**
 * The `request_image_mask` result: a receipt, not a path (D38 §2).
 *
 * The source thumb — hatched, as everywhere: no remote image loads inline for
 * the source — stacked ABOVE a kit `Receipt` (the truncation rule: a receipt
 * value column under ~160px means change the layout, not the break rule).
 *
 * Typed `ImageMaskPayload`, so the rows are the fields the handler actually
 * sends: `imagePath`, `maskPath`, `bytes`. The design also draws a region and
 * a coverage row; the payload carries neither. The seventh drop's ruling 8
 * settles what happens then: **state the absence**. The receipt's `region`
 * row reads "region not recorded", in gold, rather than disappearing — a
 * load-bearing fact that vanishes cannot be told apart from a whole-image
 * mask, and a later answer citing that receipt would be citing a gap. A
 * caller that does supply a region (the view test) gets the figures.
 *
 * And the mask itself is DRAWN over the thumb whenever its bytes exist: the
 * PNG the handler wrote is fetched from the files API and laid over the
 * hatch, with the teal region fill beneath it so the transparent (editable)
 * pixels show as the user's answer. When the bytes do not exist the thumb
 * shows the source alone with a mono line saying the mask was not rendered.
 *
 * Failure is a fact about the evidence, not a dialog: a declined or failed
 * mask comes back as a tool error with a message, and `ImageMaskFallback`
 * states it in a red boxed mono `Callout` from the result's own words.
 */

import { useState, type CSSProperties } from "react";
import { Callout, Receipt, Surface, color, font, type ReceiptRow } from "@schlessera/brain-ui-kit";
import type { ImageMaskPayload, ToolCallView } from "@schlessera/brain-ui-sdk/client";
import { useBrainUiRoot } from "../../../root-context.js";
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

export const REGION_NOT_RECORDED = "region not recorded";
export const MASK_NOT_RENDERED = "mask not rendered";

/** The kit's image placeholder: raised stripes on the surface, no pixels. */
const HATCH = `repeating-linear-gradient(135deg,${color.raised} 0 6px,var(--bk-hatch-stripe) 6px 12px)`;

function bytesLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** The mask file exists with content: the handler reports the PNG's byte length. */
export function hasMaskBytes(payload: Pick<ImageMaskPayload, "bytes">): boolean {
  return typeof payload.bytes === "number" && payload.bytes > 0;
}

/**
 * The thumb: the hatched source, the drawn region when a caller has one, and
 * the mask image over both when `maskUrl` is given. Exported for the view
 * test; the bound card computes `maskUrl` from the payload.
 */
export function MaskThumb({
  region,
  label,
  maskUrl,
  maskShown,
  onMaskLoad,
  onMaskError,
}: {
  region?: MaskRegion;
  label: string;
  maskUrl?: string;
  /** The teal fill sits under the mask only once the PNG has loaded: until
   * then, or after a failure, a full teal frame would read as a whole-image
   * mask that was never drawn. */
  maskShown?: boolean;
  onMaskLoad?: () => void;
  onMaskError?: () => void;
}) {
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
        background: "var(--bk-mask-region-fill)",
        borderRadius: 3,
        boxSizing: "border-box",
      }
    : undefined;
  // The teal fill sits under the mask: where the PNG is transparent — the
  // editable region, the user's own answer — the teal shows through.
  const fill: CSSProperties = { position: "absolute", inset: 0, background: "var(--bk-mask-region-fill)" };
  const overlay: CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "contain",
  };
  return (
    <div role="img" aria-label={label} style={frame} data-mask-thumb>
      {drawn ? <div style={drawn} data-mask-region /> : null}
      {maskUrl ? (
        <>
          {maskShown ? <div style={fill} aria-hidden="true" /> : null}
          <img
            src={maskUrl}
            alt=""
            style={{ ...overlay, visibility: maskShown ? "visible" : "hidden" }}
            data-mask-overlay
            data-mask-shown={maskShown ? "" : undefined}
            onLoad={onMaskLoad}
            onError={onMaskError}
          />
        </>
      ) : null}
    </div>
  );
}

/** The rows the receipt prints. The region row is always there: figures when
 * a caller has them, the stated absence when the payload carries none. */
export function maskReceiptRows(payload: ImageMaskPayload, region?: MaskRegion): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  if (region) {
    rows.push({
      k: "region",
      v: `${pct(region.x)},${pct(region.y)} → ${pct(region.x + region.w)},${pct(region.y + region.h)}`,
      tone: "teal",
    });
    rows.push({ k: "covers", v: `${pct(region.w * region.h)} of the image`, tone: "teal" });
  } else {
    rows.push({ k: "region", v: REGION_NOT_RECORDED, tone: "gold" });
  }
  rows.push({ k: "source", v: payload.imagePath });
  rows.push({ k: "mask", v: `${payload.maskPath} · ${bytesLabel(payload.bytes)}` });
  return rows;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function ImageMaskResultCard(payload: ImageMaskPayload & { region?: MaskRegion }) {
  const root = useBrainUiRoot();
  const region = payload.region;
  const hasBytes = hasMaskBytes(payload);
  const maskUrl = hasBytes
    ? `${root.apiBase()}/files/content?path=${encodeURIComponent(payload.maskPath)}&raw=1`
    : undefined;
  // The bytes say a mask was written; only the browser can say it loaded.
  // A file gone since, or a path the raw route refuses, must not leave a
  // full teal frame standing in for a mask nobody can see.
  const [maskState, setMaskState] = useState<"loading" | "shown" | "failed">("loading");
  const rendered = hasBytes && maskState === "shown";
  const note: CSSProperties = { font: `400 10.5px/1.5 ${font.mono}`, color: color.inkMute };
  return (
    <Surface tone="teal" label="Mask drawn" labelIcon="confirm" meta="by you" pad={12}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <MaskThumb
          region={region}
          maskUrl={maskUrl}
          maskShown={rendered}
          onMaskLoad={() => setMaskState("shown")}
          onMaskError={() => setMaskState("failed")}
          label={
            rendered
              ? `Mask ${payload.maskPath} over the source ${payload.imagePath}`
              : `Source ${payload.imagePath}; the mask is in ${payload.maskPath}`
          }
        />
        {!hasBytes || maskState === "failed" ? <div style={note}>{MASK_NOT_RENDERED}</div> : null}
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
