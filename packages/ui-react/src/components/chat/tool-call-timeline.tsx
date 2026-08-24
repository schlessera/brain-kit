import { useState, useEffect, useRef } from "react";
import {
  Check,
  X,
  Copy,
  Layers,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  FileText,
} from "lucide-react";
import { resolveToolRenderer } from "@schlessera/brain-ui-sdk/client";
import type { ToolCall } from "../../stores/chat-store.js";
import { cn } from "../../lib/utils.js";
import { motion, AnimatePresence } from "framer-motion";
import { getToolLabel, getTouchedFile, formatDuration } from "./tool-views.js";
import { registerBuiltinRenderers, GENERIC_RENDERER } from "./renderers/index.js";
import { riskHints } from "./risk-hints.js";
import { useActivityStore, timingFor, spanForTool, childSpans } from "../../stores/activity-store.js";
import { useUIStore } from "../../stores/ui-store.js";

// Register the built-in renderer packs once. Registration is build-time; this
// runs on module load.
registerBuiltinRenderers();

// One backend is active per deployment (v1). The shipped default is the Claude
// backend; renderer resolution is backend-scoped so a future multi-backend
// build can thread the real id through here.
const BACKEND_ID = "claude";

export function ToolCallTimeline({
  toolCalls,
  onApproval,
  live = false,
}: {
  toolCalls: ToolCall[];
  onApproval: (toolUseId: string, approved: boolean) => void;
  /** Parent message still streaming — keep the timeline open while work runs. */
  live?: boolean;
}) {
  // Collapse the whole run to a summary row once the turn is over. History
  // messages mount collapsed; a live timeline collapses when streaming ends.
  const [collapsed, setCollapsed] = useState(!live);
  const prevLive = useRef(live);
  useEffect(() => {
    if (prevLive.current && !live) setCollapsed(true);
    prevLive.current = live;
  }, [live]);

  if (toolCalls.length === 0) return null;

  const hasPending = toolCalls.some((t) => t.status === "pending_approval");
  const effectiveCollapsed = collapsed && !hasPending && !live;

  if (effectiveCollapsed) {
    return (
      <TimelineSummaryRow toolCalls={toolCalls} onExpand={() => setCollapsed(false)} />
    );
  }

  return (
    <div>
      {!live && !hasPending && (
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
        >
          <ChevronDown className="h-3 w-3" />
          Hide steps
        </button>
      )}
      <div className="relative ml-1 border-l-2 border-border/40 pl-4 space-y-1.5">
        {toolCalls.map((tool) => (
          <ToolCallEntry key={tool.id} toolCall={tool} onApproval={onApproval} />
        ))}
      </div>
    </div>
  );
}

function TimelineSummaryRow({
  toolCalls,
  onExpand,
}: {
  toolCalls: ToolCall[];
  onExpand: () => void;
}) {
  const steps = toolCalls.length;
  const files = new Set(toolCalls.map(getTouchedFile).filter(Boolean)).size;
  const errors = toolCalls.filter((t) => t.isError).length;
  const started = Math.min(...toolCalls.map((t) => t.startedAt ?? Infinity));
  const ended = Math.max(...toolCalls.map((t) => t.endedAt ?? -Infinity));
  const duration =
    Number.isFinite(started) && ended > started
      ? formatDuration(ended - started)
      : null;

  return (
    <button
      type="button"
      onClick={onExpand}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      <Layers className="h-3.5 w-3.5 shrink-0" />
      <span className="font-[family-name:var(--font-mono)]">
        {steps} step{steps === 1 ? "" : "s"}
        {files > 0 && ` · ${files} file${files === 1 ? "" : "s"} touched`}
        {duration && ` · ${duration}`}
      </span>
      {errors > 0 && (
        <span className="font-[family-name:var(--font-mono)] text-destructive">
          · {errors} failed
        </span>
      )}
      <ChevronRight className="h-3 w-3 shrink-0" />
    </button>
  );
}

function ToolCallEntry({
  toolCall,
  onApproval,
}: {
  toolCall: ToolCall;
  onApproval: (toolUseId: string, approved: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(
    toolCall.status === "pending_approval"
  );
  const prevStatus = useRef(toolCall.status);
  // One clock for live and reloaded views: when the activity stream carries
  // this call's span, its server-stamped timing wins over the client stamps
  // (which don't exist at all for history-loaded messages).
  const serverTiming = useActivityStore((s) => timingFor(s, toolCall.id));
  const timed: ToolCall = serverTiming
    ? {
        ...toolCall,
        startedAt: serverTiming.startedAt,
        ...(serverTiming.endedAt !== undefined ? { endedAt: serverTiming.endedAt } : {}),
      }
    : toolCall;
  // Resolve the renderer for this tool (backend-scoped exact -> global exact ->
  // shape-sniffing predicate). Falls back to the generic renderer.
  const renderer = resolveToolRenderer(toolCall, BACKEND_ID) ?? GENERIC_RENDERER;
  const Icon = renderer.icon ?? FileText;
  const isPending = toolCall.status === "pending_approval";
  const summary = renderer.summary?.(timed) ?? null;
  const meta = renderer.meta?.(timed) ?? null;
  const Input = renderer.Input;
  const Output = renderer.Output;

  useEffect(() => {
    if (
      toolCall.status === "pending_approval" &&
      prevStatus.current !== "pending_approval"
    ) {
      setExpanded(true);
    } else if (
      prevStatus.current === "pending_approval" &&
      toolCall.status !== "pending_approval"
    ) {
      setExpanded(false);
    }
    prevStatus.current = toolCall.status;
  }, [toolCall.status]);

  return (
    <div className="relative">
      {/* Timeline dot */}
      <div
        className={cn(
          "absolute -left-[21px] top-2 h-2.5 w-2.5 rounded-full border-2 border-background",
          toolCall.status === "streaming" && "bg-primary animate-pulse",
          toolCall.status === "pending_approval" &&
            "bg-primary",
          toolCall.status === "approved" && "bg-accent",
          toolCall.status === "denied" && "bg-destructive",
          toolCall.status === "complete" &&
            (toolCall.isError ? "bg-destructive" : "bg-accent"),
          !["streaming", "pending_approval", "approved", "denied", "complete"].includes(toolCall.status) && "bg-muted-foreground"
        )}
        style={
          toolCall.status === "pending_approval"
            ? { animation: "breathe 2s ease-in-out infinite" }
            : undefined
        }
      />

      {/* Header row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
          toolCall.isError
            ? "text-destructive/80 hover:text-destructive"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="font-[family-name:var(--font-mono)] font-medium">
          {getToolLabel(toolCall.name)}
        </span>
        {summary && (
          <span
            className={cn(
              "truncate",
              toolCall.isError ? "text-destructive/60" : "text-muted-foreground/70"
            )}
          >
            {summary}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {meta && (
            <span className="font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/50">
              {meta}
            </span>
          )}
          <StatusIndicator status={toolCall.status} isError={toolCall.isError} />
        </span>
      </button>

      {/* Live subagent state for Agent fan-outs, fed by the activity stream. */}
      {toolCall.name === "Agent" && <SubagentEntryRows agentToolUseId={toolCall.id} />}

      {/* Expandable detail */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div
              className={cn(
                "mt-1 rounded-lg p-3 space-y-2",
                isPending
                  ? "border-2 border-primary/40 bg-primary/5"
                  : "border border-border-subtle bg-surface"
              )}
            >
              {/* Tool input */}
              {Input && <Input tool={toolCall} />}

              {/* Risk hints — advisory only, never blocks approval */}
              {isPending && <RiskHints toolCall={toolCall} />}

              {/* Approval buttons */}
              {isPending && (
                <div className="flex gap-2">
                  <button
                    onClick={() => onApproval(toolCall.id, true)}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:brightness-110"
                  >
                    <Check className="h-3 w-3" />
                    Allow
                  </button>
                  <button
                    onClick={() => onApproval(toolCall.id, false)}
                    className="flex items-center gap-1.5 rounded-lg border border-destructive/30 px-4 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                  >
                    <X className="h-3 w-3" />
                    Deny
                  </button>
                </div>
              )}

              {/* Tool output */}
              {toolCall.output && Output && (
                <div className="relative">
                  <button
                    onClick={() =>
                      navigator.clipboard.writeText(toolCall.output!)
                    }
                    className="absolute right-1 top-1 z-10 rounded p-1 text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
                    title="Copy output"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                  <Output tool={toolCall} />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Compact live status of one Agent fan-out: what the subagent is, its state,
 * elapsed time and step count — with a tap opening the drill-in view. Data
 * comes from the activity stream (session subscription); on a host without
 * activity recording this renders nothing and the entry stays as before.
 */
function SubagentEntryRows({ agentToolUseId }: { agentToolUseId: string }) {
  const span = useActivityStore((s) => spanForTool(s, agentToolUseId));
  const children = useActivityStore((s) => childSpans(s, agentToolUseId));
  const pushSubagentView = useUIStore((s) => s.pushSubagentView);
  if (!span || span.kind !== "subagent") return null;

  const attrs = span.attrs ?? {};
  const description =
    typeof attrs["subagent.description"] === "string"
      ? (attrs["subagent.description"] as string)
      : "subagent";
  const running = span.outcome === undefined;
  const tokens =
    typeof attrs["subagent.total_tokens"] === "number"
      ? (attrs["subagent.total_tokens"] as number)
      : null;
  const elapsed = formatDuration((span.endedAt ?? Date.now()) - span.startedAt);

  return (
    <button
      type="button"
      onClick={() => pushSubagentView(agentToolUseId)}
      className="ml-6 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-md px-2 py-1 text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground"
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          running ? "animate-pulse bg-primary" : span.outcome === "success" ? "bg-accent" : "bg-destructive"
        )}
      />
      <span className="truncate">{description}</span>
      <span className="ml-auto shrink-0 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/50">
        {children.length > 0 && `${children.length} step${children.length === 1 ? "" : "s"} · `}
        {tokens !== null && `${Math.round(tokens / 1000)}k tok · `}
        {elapsed}
      </span>
      <ChevronRight className="h-3 w-3 shrink-0" />
    </button>
  );
}

function RiskHints({ toolCall }: { toolCall: ToolCall }) {
  const hints = riskHints(toolCall);
  if (hints.length === 0) return null;
  return (
    <div className="space-y-0.5 text-[11px] text-amber-400">
      {hints.map((hint) => (
        <div key={hint} className="flex items-center gap-1.5">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span>{hint}</span>
        </div>
      ))}
    </div>
  );
}

function StatusIndicator({
  status,
  isError,
}: {
  status: ToolCall["status"];
  isError?: boolean;
}) {
  switch (status) {
    case "streaming":
      return (
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
      );
    case "pending_approval":
      return (
        <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          Approval needed
        </span>
      );
    case "approved":
      return <Check className="h-3 w-3 text-accent" />;
    case "denied":
      return <X className="h-3 w-3 text-destructive" />;
    case "complete":
      return isError ? (
        <X className="h-3 w-3 text-destructive" />
      ) : (
        <Check className="h-3 w-3 text-muted-foreground/50" />
      );
  }
}
