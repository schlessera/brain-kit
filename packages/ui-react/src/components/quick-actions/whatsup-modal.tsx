import { useBrainUiRoot } from "../../root-context.js";
import { useState, useEffect, useRef } from "react";
import { SlidePanel } from "../layout/slide-panel.js";
import { BrainMarkdown } from "../chat/brain-markdown.js";
import { BriefingOutput } from "./streaming-output.js";

type State = "loading" | "done" | "empty" | "error" | "cancelled";

/**
 * The container (S6) for the daily briefing. It reads the selected root's
 * `GET /api/brain/briefing`: the keyless `brain briefing` output, gathered
 * without a model, and runs no script and no agent turn (#1391). The request,
 * the abort controller and the "still my request" checks live here;
 * `BriefingOutput` draws from props. Retry reads the briefing again.
 */
export function WhatsupPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const root = useBrainUiRoot();
  const [state, setState] = useState<State>("loading");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;

    setState("loading");
    setContent("");
    setError(undefined);

    let disposed = false;
    const controller = new AbortController();
    controllerRef.current = controller;
    const stale = () => disposed || controller.signal.aborted;

    (async () => {
      try {
        const res = await root.request(root.backendUrl("/api/brain/briefing"), {
          signal: controller.signal,
        });
        const body = (await res.json().catch(() => null)) as { content?: unknown; error?: unknown } | null;
        if (stale()) return;

        if (!res.ok) {
          setError(typeof body?.error === "string" && body.error ? body.error : `HTTP ${res.status}: ${res.statusText}`);
          setState("error");
          return;
        }
        if (typeof body?.content !== "string") {
          setError("The briefing response carried no content.");
          setState("error");
          return;
        }
        setContent(body.content);
        setState(body.content.trim() ? "done" : "empty");
      } catch (err: any) {
        if (stale()) return;
        if (err?.name === "AbortError") {
          setState("cancelled");
        } else {
          setError(err instanceof Error ? err.message : String(err));
          setState("error");
        }
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [open, root, attempt]);

  // Closing unmounts the panel and discards the briefing, so a stray click
  // beside the drawer must not close it. Escape is refused only while the
  // briefing loads; the header's X is always the way out.
  const closedBy = state === "loading" ? "none" : "closerequest";

  return (
    <SlidePanel open={open} onClose={onClose} title="Whatsup" wide closedBy={closedBy}>
      <BriefingOutput
        state={state}
        error={error}
        content={<BrainMarkdown content={content} className="whatsup-briefing brain-prose" entityTags fileLinks />}
        onRetry={() => setAttempt((n) => n + 1)}
        onCancel={() => {
          controllerRef.current?.abort();
          setState("cancelled");
        }}
        onClose={onClose}
      />
    </SlidePanel>
  );
}
