import { useState, useEffect, useRef } from "react";
import { Loader2, XCircle } from "lucide-react";
import { SlidePanel } from "../layout/slide-panel.js";
import { BrainMarkdown } from "../chat/brain-markdown.js";
import { getBackendUrl } from "../../lib/backend.js";

type State = "loading" | "done" | "error" | "cancelled";

export function WhatsupPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>("loading");
  const [content, setContent] = useState("");
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;

    setState("loading");
    setContent("");

    const controller = new AbortController();
    controllerRef.current = controller;

    (async () => {
      try {
        const res = await fetch(getBackendUrl("/api/brain/whatsup"), {
          method: "POST",
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          setState("error");
          setContent(`HTTP ${res.status}: ${res.statusText}`);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const lines: string[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const event of events) {
            const dataLine = event
              .split("\n")
              .find((l) => l.startsWith("data: "));
            if (!dataLine) continue;

            try {
              const data = JSON.parse(dataLine.slice(6));
              if (data.type === "progress" && data.text !== undefined) {
                lines.push(data.text);
              }
              if (data.type === "done") {
                setState(data.success ? "done" : "error");
              }
            } catch {}
          }
        }

        setContent(lines.join("\n"));
      } catch (err: any) {
        if (err.name === "AbortError") {
          setState("cancelled");
          setContent("Cancelled.");
        } else {
          setState("error");
          setContent(`Error: ${err.message}`);
        }
      } finally {
        controllerRef.current = null;
      }
    })();

    return () => {
      controller.abort();
      controllerRef.current = null;
    };
  }, [open]);

  const isLoading = state === "loading";

  return (
    <SlidePanel
      open={open}
      onClose={onClose}
      title="Whatsup"
      wide
    >
      <div className="flex h-full flex-col">
        {/* Status bar (errors only — loading uses centered indicator) */}
        {(state === "error" || state === "cancelled") && (
          <div className="flex items-center gap-2 border-b border-border px-5 py-2">
            <XCircle className="h-3.5 w-3.5 text-destructive" />
            <span className="text-xs text-muted-foreground">Failed</span>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
              <Loader2 className="h-5 w-5 animate-spin mr-2 text-primary" />
              Generating briefing...
            </div>
          ) : (
            <BrainMarkdown
              content={content}
              className="whatsup-briefing brain-prose"
              entityTags
              fileLinks
            />
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border px-5 py-3 flex justify-end">
          {isLoading ? (
            <button
              onClick={() => controllerRef.current?.abort()}
              className="rounded-lg border border-destructive/30 px-4 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
            >
              Cancel
            </button>
          ) : (
            <button
              onClick={onClose}
              className="rounded-lg bg-surface-raised px-4 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-overlay"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </SlidePanel>
  );
}
