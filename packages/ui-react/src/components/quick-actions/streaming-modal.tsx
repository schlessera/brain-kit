import { useState, useEffect, useRef } from "react";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { SlidePanel } from "../layout/slide-panel.js";
import { linkifyPaths } from "../chat/brain-markdown.js";

type StreamState = "idle" | "running" | "success" | "error" | "cancelled";

export function StreamingPanel({
  open,
  onClose,
  title,
  endpoint,
  method = "POST",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  endpoint: string;
  method?: string;
}) {
  const [state, setState] = useState<StreamState>("idle");
  const [lines, setLines] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;

    setState("running");
    setLines([]);

    const controller = new AbortController();
    controllerRef.current = controller;

    (async () => {
      try {
        const res = await fetch(endpoint, {
          method,
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          setState("error");
          const body = await res.json().catch(() => null);
          const message = typeof body?.error === "string" ? body.error : `HTTP ${res.status}: ${res.statusText}`;
          if (!controller.signal.aborted) setLines((l) => [...l, message]);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

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
              if (data.text !== undefined) {
                setLines((l) => [...l, data.text]);
              }
              if (data.type === "done") {
                setState(data.success ? "success" : "error");
              }
            } catch {}
          }
        }
      } catch (err: any) {
        if (err.name === "AbortError") {
          setLines((l) => [...l, "Cancelled."]);
          setState("cancelled");
        } else {
          setState("error");
          setLines((l) => [...l, `Error: ${err.message}`]);
        }
      } finally {
        controllerRef.current = null;
      }
    })();

    return () => {
      controller.abort();
      controllerRef.current = null;
    };
  }, [open, endpoint, method]);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  const isRunning = state === "running";

  return (
    <SlidePanel
      open={open}
      onClose={isRunning ? () => {} : onClose}
      title={title}
    >
      <div className="flex h-full flex-col">
        {/* Status bar */}
        <div className="flex items-center gap-2 border-b border-border px-5 py-2">
          {isRunning && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          )}
          {state === "success" && (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
          )}
          {(state === "error" || state === "cancelled") && (
            <XCircle className="h-3.5 w-3.5 text-destructive" />
          )}
          <span className="text-xs text-muted-foreground">
            {isRunning
              ? "Running..."
              : state === "success"
                ? "Complete"
                : state === "error"
                  ? "Failed"
                  : state === "cancelled"
                    ? "Cancelled"
                    : "Ready"}
          </span>
        </div>

        {/* Log output */}
        <div className="flex-1 overflow-y-auto p-4 font-[family-name:var(--font-mono)] text-xs leading-relaxed text-muted-foreground">
          {lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap">
              {linkifyPaths(line)}
            </div>
          ))}
          {isRunning && lines.length === 0 && (
            <div className="text-muted-foreground/50">Starting...</div>
          )}
          <div ref={scrollRef} />
        </div>

        {/* Footer */}
        <div className="border-t border-border px-5 py-3 flex justify-end">
          {isRunning ? (
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
