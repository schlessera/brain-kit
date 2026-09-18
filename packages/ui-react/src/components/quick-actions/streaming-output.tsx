import { Button, Placeholder, StatusDot } from "@schlessera/brain-ui-kit";
import type { ReactNode } from "react";
import type { Tone } from "@schlessera/brain-ui-kit";

/**
 * What a streamed backend job looks like while it runs and once it has
 * finished — rendered from props (S6). `StreamingPanel` and `WhatsupPanel`
 * are the containers: they own the request, the reader loop, the abort
 * controller and the "is this still my stream" checks; the two views here
 * own the status row, the output area and the one button in the footer.
 *
 * `state` is the job's, in the container's vocabulary: `running` is the only
 * state with a Cancel; every other state offers Close. The status dot is the
 * kit's — amber breathing while running, teal when it completed, red for a
 * failure or a cancellation — and the row is a polite live region so a
 * screen reader hears "Complete" once, not every line.
 */
export type StreamState = "idle" | "running" | "success" | "error" | "cancelled";

const STATUS: Record<StreamState, { tone: Tone; pulse: boolean; text: string }> = {
  idle: { tone: "neutral", pulse: false, text: "Ready" },
  running: { tone: "amber", pulse: true, text: "Running..." },
  success: { tone: "teal", pulse: false, text: "Complete" },
  error: { tone: "red", pulse: false, text: "Failed" },
  cancelled: { tone: "red", pulse: false, text: "Cancelled" },
};

export interface StreamingOutputProps {
  state: StreamState;
  /** The job's lines so far, already turned into nodes by the container (paths linkified). */
  lines: ReactNode[];
  onCancel: () => void;
  onClose: () => void;
  /** Wire to the scroll anchor the container keeps in view. */
  anchor?: ReactNode;
}

export function StreamingOutput(p: StreamingOutputProps) {
  const running = p.state === "running";
  const s = STATUS[p.state];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-5 py-2" aria-live="polite">
        <StatusDot tone={s.tone} pulse={s.pulse} size={7} />
        <span className="text-xs text-muted-foreground">{s.text}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 font-[family-name:var(--font-mono)] text-xs leading-relaxed text-muted-foreground">
        {p.lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap">
            {line}
          </div>
        ))}
        {running && p.lines.length === 0 && <div className="text-muted-foreground/50">Starting...</div>}
        {p.anchor}
      </div>

      <StreamFooter running={running} onCancel={p.onCancel} onClose={p.onClose} />
    </div>
  );
}

/**
 * The briefing: one document rather than a log, so it loads behind a skeleton
 * and renders as prose once it has all arrived. `content` is the container's
 * rendered markdown node; the view does not know what it is made of.
 */
export interface BriefingOutputProps {
  state: "loading" | "done" | "error" | "cancelled";
  content: ReactNode;
  onCancel: () => void;
  onClose: () => void;
}

export function BriefingOutput(p: BriefingOutputProps) {
  const loading = p.state === "loading";
  return (
    <div className="flex h-full flex-col">
      {(p.state === "error" || p.state === "cancelled") && (
        <div className="flex items-center gap-2 border-b border-border px-5 py-2" aria-live="polite">
          <StatusDot tone="red" pulse={false} size={7} />
          <span className="text-xs text-muted-foreground">Failed</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-5">
        {loading ? (
          <div className="flex flex-col gap-3">
            <Placeholder variant="loading" lines={4} bordered={false} pad={0} />
            <p className="text-sm text-muted-foreground">Generating briefing...</p>
          </div>
        ) : (
          p.content
        )}
      </div>

      <StreamFooter running={loading} onCancel={p.onCancel} onClose={p.onClose} />
    </div>
  );
}

function StreamFooter({ running, onCancel, onClose }: { running: boolean; onCancel: () => void; onClose: () => void }) {
  return (
    <div className="flex justify-end border-t border-border px-5 py-3">
      {running ? (
        <Button label="Cancel" icon="cancel" tone="danger" size="sm" block={false} onClick={onCancel} />
      ) : (
        <Button label="Close" tone="quiet" size="sm" block={false} onClick={onClose} />
      )}
    </div>
  );
}
