import { TrackMap } from "@schlessera/brain-ui-kit";
import type { Block } from "@schlessera/brain-ui-sdk/client";
import { useEffect, useState } from "react";
import { useBrainUiRoot } from "../../../root-context.js";
import { loadTrackDisplay, type TrackDisplay } from "../../../lib/track-display.js";

type TrackBlock = Extract<Block, { kind: "track" }>;
export function TrackBlockCard({ block, isStatic = false, resolved }: { block: TrackBlock; isStatic?: boolean; resolved?: TrackDisplay }) {
  const root = useBrainUiRoot();
  const [loaded, setLoaded] = useState<TrackDisplay>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (isStatic || resolved) return;
    const controller = new AbortController();
    setLoaded(undefined); setError("");
    void loadTrackDisplay(root, block.source.path, block.title, controller.signal).then(value => {
      if (!controller.signal.aborted) setLoaded(value);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Track unavailable."); });
    return () => controller.abort();
  }, [root, block.source.path, block.title, isStatic, resolved]);
  const value = resolved ?? loaded;
  if (!value) return <div className="rounded-lg border border-border p-4 text-sm" role="status">{error || (isStatic ? "Track evidence must be resolved before export." : "Reading original track…")}<div className="mt-2 break-all font-mono text-xs text-muted-foreground">{block.source.path}</div></div>;
  return <TrackMap {...value.props} {...(!isStatic ? { originalHref: `${root.apiBase()}/files/content?path=${encodeURIComponent(block.source.path)}&raw=1` } : {})} />;
}
