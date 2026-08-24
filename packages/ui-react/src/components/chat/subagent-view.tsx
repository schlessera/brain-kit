import { useMemo } from "react";
import { ArrowLeft, Bot, Check, X } from "lucide-react";
import { motion } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import { isFailureOutcome } from "@schlessera/brain-ui-sdk/protocol";
import type { ActivitySpan, ActivitySpanEvent } from "@schlessera/brain-ui-sdk/protocol";

import { useActivityStore, childSpans, eventsFor, spanForTool } from "../../stores/activity-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useChatStore, activeChat } from "../../stores/chat-store.js";
import { cn } from "../../lib/utils.js";
import { getToolLabel, formatDuration } from "./tool-views.js";
import { SpanStatusDot, spanToolLabel } from "../activity/span-bits.js";

/**
 * Drill-in view of one subagent: the span tree under its Agent tool call,
 * transcript excerpts interleaved by time, live while the subagent runs.
 *
 * Deliberately observation-shaped — no composer, no way to address the
 * subagent — with ONE exception, decided during planning: an approval
 * request raised by a tool inside this subagent renders actionable here as
 * well as in the parent chat, because a fan-out stalled on an unaddressable
 * approval is worse than a relaxed rule.
 *
 * When transcript forwarding is off (or the backend cannot forward), the
 * view degrades to activity-only and says so, rather than looking empty.
 */
export function SubagentView({
  spanId,
  onApproval,
}: {
  spanId: string;
  onApproval?: (toolUseId: string, approved: boolean) => void;
}) {
  const popSubagentView = useUIStore((s) => s.popSubagentView);
  const pushSubagentView = useUIStore((s) => s.pushSubagentView);
  const span = useActivityStore((s) => spanForTool(s, spanId));
  const children = useActivityStore(useShallow((s) => childSpans(s, spanId)));
  const events = useActivityStore((s) => eventsFor(s, spanId));
  const pendingApprovals = useChatStore(
    useShallow((s) => {
      const chat = activeChat(s);
      const last = chat.messages.at(-1);
      return (last?.toolCalls ?? []).filter((t) => t.status === "pending_approval");
    })
  );

  const timelineItems = useMemo(
    () => interleave(children, events),
    [children, events]
  );

  if (!span) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <BackButton onClick={popSubagentView} />
        <p className="text-sm text-muted-foreground">
          No recorded activity for this subagent — it may have been pruned.
        </p>
      </div>
    );
  }

  const description = span.subagent?.description ?? null;
  const subagentType = span.subagent?.type ?? null;
  const summary = span.subagent?.summary ?? null;
  const running = span.outcome === undefined;
  const duration =
    span.endedAt !== undefined ? formatDuration(span.endedAt - span.startedAt) : null;
  const hasTranscript = events.some((e) => e.eventType.startsWith("transcript_"));
  const approvalsHere = pendingApprovals.filter((t) =>
    children.some((c) => c.spanId === t.id)
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <BackButton onClick={popSubagentView} />
        <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {description ?? "Subagent"}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {subagentType ?? "agent"}
            {running ? " · running" : span.outcome ? ` · ${span.outcome}` : ""}
            {duration ? ` · ${duration}` : ""}
          </div>
        </div>
        {running && (
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
        )}
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto p-4">
        {approvalsHere.map((tool) => (
          <div
            key={tool.id}
            className="rounded-lg border-2 border-primary/40 bg-primary/5 p-3 text-xs"
          >
            <div className="mb-2 font-medium">
              Approval needed: {getToolLabel(tool.name)}
            </div>
            {onApproval && (
              <div className="flex gap-2">
                <button
                  onClick={() => onApproval(tool.id, true)}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:brightness-110"
                >
                  <Check className="h-3 w-3" /> Allow
                </button>
                <button
                  onClick={() => onApproval(tool.id, false)}
                  className="flex items-center gap-1.5 rounded-lg border border-destructive/30 px-4 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10"
                >
                  <X className="h-3 w-3" /> Deny
                </button>
              </div>
            )}
          </div>
        ))}

        {timelineItems.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {running ? "Waiting for the first step…" : "No recorded steps."}
          </p>
        )}

        {timelineItems.map((item) =>
          item.kind === "span" ? (
            <SpanRow
              key={item.span.spanId}
              span={item.span}
              onOpen={
                item.span.kind === "subagent"
                  ? () => pushSubagentView(item.span.spanId)
                  : undefined
              }
            />
          ) : (
            <TranscriptRow key={`${item.event.spanId}:${item.event.eventIndex}`} event={item.event} />
          )
        )}

        {!hasTranscript && children.length > 0 && (
          <p className="pt-2 text-[11px] text-muted-foreground/60">
            Activity only — this subagent's transcript was not captured.
          </p>
        )}
        {summary && !running && (
          <div className="mt-2 rounded-lg border border-border-subtle bg-surface p-3 text-xs">
            {summary}
          </div>
        )}
      </div>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
      aria-label="Back"
    >
      <ArrowLeft className="h-4 w-4" />
    </button>
  );
}

function SpanRow({ span, onOpen }: { span: ActivitySpan; onOpen?: () => void }) {
  const running = span.outcome === undefined;
  const failed = isFailureOutcome(span.outcome);
  const duration =
    span.endedAt !== undefined
      ? formatDuration(span.endedAt - (span.waitUntil ?? span.startedAt))
      : null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 2 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
        failed ? "text-destructive/80" : "text-muted-foreground",
        onOpen && "cursor-pointer hover:text-foreground"
      )}
      onClick={onOpen}
    >
      <SpanStatusDot span={span} className="h-2 w-2" />
      <span className="font-[family-name:var(--font-mono)] font-medium">
        {spanToolLabel(span)}
      </span>
      {span.outcome && span.outcome !== "success" && (
        <span className="text-[10px] uppercase">{span.outcome}</span>
      )}
      <span className="ml-auto font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/50">
        {duration ?? (running ? "…" : "")}
      </span>
    </motion.div>
  );
}

function TranscriptRow({ event }: { event: ActivitySpanEvent }) {
  const text = typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
  if (!text) return null;
  return (
    <div className="whitespace-pre-wrap rounded-md bg-surface px-3 py-2 text-xs text-foreground/80">
      {text}
      {event.truncated && <span className="text-muted-foreground/60"> …</span>}
    </div>
  );
}

type TimelineItem =
  | { kind: "span"; span: ActivitySpan; ts: number }
  | { kind: "event"; event: ActivitySpanEvent; ts: number };

/** Child steps and transcript excerpts in one chronological stream. */
function interleave(spans: ActivitySpan[], events: ActivitySpanEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...spans.map((span) => ({ kind: "span" as const, span, ts: span.startedAt })),
    ...events
      .filter((e) => e.eventType.startsWith("transcript_"))
      .map((event) => ({ kind: "event" as const, event, ts: event.ts })),
  ];
  return items.sort((a, b) => a.ts - b.ts);
}
