import { watchCloseRequests } from "@schlessera/brain-ui-kit/internal";
import { useEffect, useRef } from "react";

/**
 * Close requests (Escape, Android back) for a non-modal surface while it is
 * open (#2577), through the kit's one close-request helper. `request` returns
 * whether the surface closed; when it stays open, the helper re-arms so the
 * next close request reaches it again. The latest `request` is always used,
 * so a re-render never re-creates the platform watcher.
 */
export function useCloseRequest(open: boolean, request: () => boolean): void {
  const latest = useRef(request);
  latest.current = request;
  useEffect(() => {
    if (!open) return;
    const watch = watchCloseRequests(document, () => latest.current());
    return () => watch.destroy();
  }, [open]);
}
