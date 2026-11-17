/**
 * `request_image_markup` in the transcript (#3975): the kit's markup receipt,
 * with the layer loaded from the brain's raw file route, and the decline
 * stated from the result's own words.
 *
 * The receipt records what the user drew. A later `brain image --markup`
 * failure belongs to that tool's own card and never rewrites this one.
 */
import { MarkupFallback, MarkupResultCard } from "@schlessera/brain-ui-kit";
import type { ImageMarkupPayload, ToolCallView } from "@schlessera/brain-ui-sdk/client";

import { useBrainUiRoot } from "../../../root-context.js";
import { ClampedPre } from "../tool-views.js";

export function ImageMarkupCard(payload: ImageMarkupPayload) {
  const root = useBrainUiRoot();
  return (
    <MarkupResultCard
      imagePath={payload.imagePath}
      markupPath={payload.markupPath}
      width={payload.width}
      height={payload.height}
      bytes={payload.bytes}
      marks={payload.marks}
      notes={payload.notes}
      // The server wrote the layer only after checking it against the source.
      matchesSource
      {...(payload.bytes > 0 ? { markupSrc: `${root.apiBase()}/files/content?path=${encodeURIComponent(payload.markupPath)}&raw=1` } : {})}
    />
  );
}

/** No payload: the user closed the editor, a recheck refused, or an older server answered. */
export function ImageMarkupFallback({ tool }: { tool: ToolCallView }) {
  if (!tool.output) return null;
  if (!tool.isError) return <ClampedPre text={tool.output} />;
  const source = typeof tool.input.imagePath === "string" ? tool.input.imagePath : undefined;
  return <MarkupFallback {...(source ? { imagePath: source } : {})} reason={tool.output} />;
}
