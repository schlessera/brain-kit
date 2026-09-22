import { useBrainUiRoot } from "../../root-context.js";
import { useState, useEffect, useRef } from "react";
import { SlidePanel } from "../layout/slide-panel.js";
import { BrainMarkdown } from "../chat/brain-markdown.js";
import { BriefingOutput } from "./streaming-output.js";

type State = "loading" | "done" | "error" | "cancelled";

/**
 * The container (S6) for the briefing: the request, the SSE reader loop, the
 * abort controller and the "still my stream" checks live here;
 * `BriefingOutput` draws from props.
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
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;

    setState("loading");
    setContent("");

    let disposed = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const controller = new AbortController();
    const cancelReader = () => { void reader?.cancel().catch(() => {}); };
    controller.signal.addEventListener("abort", cancelReader);
    controllerRef.current = controller;

    (async () => {
      try {
        const res = await root.request(root.backendUrl("/api/brain/whatsup"), {
          method: "POST",
          signal: controller.signal,
        });

        if (disposed || controller.signal.aborted) {
          await res.body?.cancel();
          return;
        }

        if (!res.ok || !res.body) {
          setState("error");
          setContent(`HTTP ${res.status}: ${res.statusText}`);
          return;
        }

        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const lines: string[] = [];

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
        if (disposed || controller.signal.aborted) return;
        if (err.name === "AbortError") {
          setState("cancelled");
          setContent("Cancelled.");
        } else {
          setState("error");
          setContent(`Error: ${err.message}`);
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
  }, [open, root]);

  // Closing unmounts the panel, and the unmount aborts the briefing, so a stray
  // click on the backdrop must not close it: while it loads the click cancels a
  // model call, and afterwards it discards a briefing that call paid for.
  // Escape is refused only while the briefing loads; the header's X is always
  // the way out.
  const closedBy = state === "loading" ? "none" : "closerequest";

  return (
    <SlidePanel open={open} onClose={onClose} title="Whatsup" wide closedBy={closedBy}>
      <BriefingOutput
        state={state}
        content={<BrainMarkdown content={content} className="whatsup-briefing brain-prose" entityTags fileLinks />}
        onCancel={() => {
          controllerRef.current?.abort();
          setState("cancelled");
          setContent("Cancelled.");
        }}
        onClose={onClose}
      />
    </SlidePanel>
  );
}
