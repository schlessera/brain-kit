import { useEffect, useState } from "react";
import type { FileContentResponse } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { FileViewerRaw } from "./file-viewer-raw.js";
import { ViewerFailure, ViewerLoading } from "./file-viewer-frame.js";

/** Read source as text from the existing raw route; never insert SVG markup. */
export function SvgSource({ content }: { content: FileContentResponse }) {
  const root = useBrainUiRoot();
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    setSource(null);
    setFailed(false);
    void (async () => {
      try {
        const response = await root.request(`${root.apiBase()}/files/content?path=${encodeURIComponent(content.path)}&raw=1`, { signal: request.signal });
        if (!response.ok) throw Error("Source unavailable");
        const text = await response.text();
        if (!request.signal.aborted) setSource(text);
      } catch {
        if (request.signal.aborted) return;
        // The file store owns missing/expired/access states, just as for a
        // failed image preview. A present file permits one manual retry.
        const available = await root.stores.file.getState().checkPreview(content);
        if (!request.signal.aborted && available) setFailed(true);
      }
    })();
    return () => request.abort();
  }, [root, content, attempt]);
  if (failed) return <ViewerFailure failure={{ kind: "unknown" }} onRetry={() => setAttempt(n => n + 1)} />;
  if (source === null) return <ViewerLoading />;
  return <FileViewerRaw content={source} fileName={content.path} />;
}
