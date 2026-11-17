import { MARKUP_CLOSED, MarkupEditor, type MarkupExport } from "@schlessera/brain-ui-kit";
import { useCallback } from "react";

import { useBrainUiRoot } from "../../root-context.js";
import { useMarkupStore, type MarkupRequest } from "../../stores/markup-store.js";

/**
 * The markup editor for `request_image_markup` (#3975): the kit's
 * `MarkupEditor`, opened by a `markup_request` and answered over the markup
 * upload route rather than the socket, because a layer may be up to 50 MiB.
 *
 * The layer is drawn at the source's displayed size as the server read it
 * (after EXIF orientation), never flattened onto the source. A refused upload
 * keeps the editor open with the server's reason; closing it declines.
 */
export function MarkupEditorHost({ onDecline }: { onDecline: (request: MarkupRequest, message: string) => void }) {
  const root = useBrainUiRoot();
  const request = useMarkupStore((s) => s.request);
  const close = useMarkupStore((s) => s.close);

  const submit = useCallback(async (layer: MarkupExport) => {
    if (!request) return;
    await uploadMarkupLayer(root, request, layer);
    close(request.requestId);
  }, [root, request, close]);

  if (!request) return null;
  return (
    <MarkupEditor
      key={request.requestId}
      open
      // The request's own bound source: the general file route stops at
      // 10 MiB, a markup source may be larger.
      src={`${root.apiBase()}${request.sourcePath}${request.turnId ? `?turnId=${encodeURIComponent(request.turnId)}` : ""}`}
      imagePath={request.imagePath}
      {...(request.instruction ? { instruction: request.instruction } : {})}
      size={{ width: request.width, height: request.height }}
      maxBytes={request.maxBytes}
      onSubmit={submit}
      onDismiss={() => {
        onDecline(request, MARKUP_CLOSED);
        close(request.requestId);
      }}
    />
  );
}

/**
 * Upload one drawn layer for `request`. Resolves once the server took it for
 * the waiting request; rejects with the server's own words otherwise, which
 * the editor shows while it stays open.
 */
export async function uploadMarkupLayer(
  root: Pick<ReturnType<typeof useBrainUiRoot>, "apiBase" | "request">,
  request: MarkupRequest,
  layer: MarkupExport,
): Promise<void> {
  const form = new FormData();
  form.append("summary", JSON.stringify({ marks: layer.counts, notes: layer.notes }));
  form.append("layer", layer.png, "markup.png");
  const query = request.turnId ? `?turnId=${encodeURIComponent(request.turnId)}` : "";
  let res: Response;
  try {
    res = await root.request(`${root.apiBase()}${request.uploadPath}${query}`, { method: "POST", body: form, cache: "no-store" });
  } catch {
    throw new Error("The markup could not be sent. Check the connection and try again.");
  }
  if (res.ok) return;
  const body = (await res.json().catch(() => undefined)) as { message?: unknown } | undefined;
  throw new Error(typeof body?.message === "string" && body.message ? body.message : `The markup could not be sent (HTTP ${res.status}).`);
}
