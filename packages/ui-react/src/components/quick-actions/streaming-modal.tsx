import { useBrainUiRoot } from "../../root-context.js";
import { useState, useEffect, useRef } from "react";
import { SlidePanel } from "../layout/slide-panel.js";
import { linkifyPaths } from "../chat/brain-markdown.js";
import { StreamingOutput, type StreamState } from "./streaming-output.js";

/**
 * The container (S6) for a streamed backend job: the request, the SSE reader
 * loop, the abort controller and the "still my stream" checks live here;
 * `StreamingOutput` draws from props.
 */
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
  /** Backend-relative path, resolved against the current root. */
  endpoint: string;
  method?: string;
}) {
  const root = useBrainUiRoot();
  const [state, setState] = useState<StreamState>("idle");
  const [lines, setLines] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;

    setState("running");
    setLines([]);

    let disposed = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const controller = new AbortController();
    const cancelReader = () => { void reader?.cancel().catch(() => {}); };
    controller.signal.addEventListener("abort", cancelReader);
    controllerRef.current = controller;

    (async () => {
      try {
        const res = await root.request(root.backendUrl(endpoint), {
          method,
          signal: controller.signal,
        });

        if (disposed || controller.signal.aborted) {
          await res.body?.cancel();
          return;
        }

        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => null);
          if (disposed || controller.signal.aborted) return;
          setState("error");
          const message = typeof body?.error === "string" ? body.error : `HTTP ${res.status}: ${res.statusText}`;
          if (!controller.signal.aborted) setLines((l) => [...l, message]);
          return;
        }

        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finished = false;

        while (true) {
          const { done, value } = await reader.read();
          if (disposed || controller.signal.aborted) return;
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
                finished = true;
                setState(data.success ? "success" : "error");
              }
            } catch {}
          }
        }

        // EOF without a `done` frame — a dropped connection, or a route that
        // unwound past its last send. Running is not terminal, so staying in
        // it would strand the panel on a Cancel for a stream that is gone.
        if (!finished) {
          setLines((l) => [...l, "The connection closed before the job reported a result."]);
          setState("error");
        }
      } catch (err: any) {
        if (disposed || controller.signal.aborted) return;
        if (err.name === "AbortError") {
          setLines((l) => [...l, "Cancelled."]);
          setState("cancelled");
        } else {
          setState("error");
          setLines((l) => [...l, `Error: ${err.message}`]);
        }
      } finally {
        controller.signal.removeEventListener("abort", cancelReader);
        reader?.releaseLock();
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [open, endpoint, method, root]);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  // Closing unmounts the panel, and the unmount aborts the stream, so a stray
  // click on the backdrop must not close it: mid-run it would cancel the job,
  // and afterwards it would discard a log nobody has read. Escape is refused
  // only while the job runs; the header's X is always the way out.
  const closedBy = state === "running" ? "none" : "closerequest";

  return (
    <SlidePanel open={open} onClose={onClose} title={title} closedBy={closedBy}>
      <StreamingOutput
        state={state}
        lines={lines.map((line) => linkifyPaths(line))}
        anchor={<div ref={scrollRef} />}
        onCancel={() => {
          controllerRef.current?.abort();
          setState("cancelled");
          setLines((lines) => [...lines, "Cancelled."]);
        }}
        onClose={onClose}
      />
    </SlidePanel>
  );
}
