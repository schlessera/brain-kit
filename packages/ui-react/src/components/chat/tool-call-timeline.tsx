import { useBrainUiRoot } from "../../root-context.js";
import { useState, useEffect, useRef, type KeyboardEvent } from "react";
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
import { type ToolSemantics } from "@schlessera/brain-ui-sdk/client";
import { useChatStore, type ToolCall } from "../../stores/chat-store.js";
import { cn } from "../../lib/utils.js";
import { motion, AnimatePresence } from "framer-motion";
import { getToolLabel, getTouchedFile, formatDuration, formatTokenCount } from "./tool-views.js";
import { registerBuiltinRenderers, GENERIC_RENDERER } from "./renderers/index.js";
import { riskHints } from "./risk-hints.js";
import { useShallow } from "zustand/react/shallow";
import { focusAfterDecision, singleKey } from "../../lib/single-key.js";
import { KeyCap } from "../layout/key-cap.js";
import { useActivityStore, spanForTool, childSpans } from "../../stores/activity-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useNow } from "../../hooks/use-now.js";
import { SpanStatusDot } from "../activity/span-bits.js";

// Sessions that predate backend stamping (old servers, cleared stores) scope
// to the shipped default backend.
const DEFAULT_BACKEND_ID = "claude";

/** Backend owning the session in view, scoping renderer resolution. */
function useBackendId(): string {
  return useChatStore(
    (s) =>
      (s.activeSessionId ? s.backendIds[s.activeSessionId] : undefined) ??
      DEFAULT_BACKEND_ID
  );
}

export function ToolCallTimeline({
  toolCalls,
  onApproval,
  live = false,
}: {
  toolCalls: ToolCall[];
  onApproval: (toolUseId: string, approved: boolean, always?: boolean) => void;
  /** Parent message still streaming — keep the timeline open while work runs. */
  live?: boolean;
}) {
  // Resolution happens below during this render, before effects can run.
  const root = useBrainUiRoot();
  registerBuiltinRenderers(root.renderers);

  // Collapse the whole run to a summary row once the turn is over. History
  // messages mount collapsed; a live timeline collapses when streaming ends.
  const [collapsed, setCollapsed] = useState(!live);
  const backendId = useBackendId();
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
      <TimelineSummaryRow
        toolCalls={toolCalls}
        backendId={backendId}
        onExpand={() => setCollapsed(false)}
      />
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
          <ToolCallEntry
            key={tool.id}
            toolCall={tool}
            backendId={backendId}
            onApproval={onApproval}
          />
        ))}
      </div>
    </div>
  );
}

function TimelineSummaryRow({
  toolCalls,
  backendId,
  onExpand,
}: {
  toolCalls: ToolCall[];
  backendId: string;
  onExpand: () => void;
}) {
  const root = useBrainUiRoot();
  const steps = toolCalls.length;
  const files = new Set(
    toolCalls
      .map(
        (t) =>
          root.renderers.resolve(t, backendId)?.touchedFile?.(t) ?? getTouchedFile(t)
      )
      .filter(Boolean)
  ).size;
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
  backendId,
  onApproval,
}: {
  toolCall: ToolCall;
  backendId: string;
  onApproval: (toolUseId: string, approved: boolean, always?: boolean) => void;
}) {
  const root = useBrainUiRoot();
  const [expanded, setExpanded] = useState(
    toolCall.status === "pending_approval"
  );
  const prevStatus = useRef(toolCall.status);
  // One clock for live and reloaded views: when the activity stream carries
  // this call's span, its server-stamped timing wins over the client stamps
  // (which don't exist at all for history-loaded messages). Selecting the
  // span itself (a stable reference) rather than a derived timing object
  // keeps every other entry from re-rendering on every activity delta.
  const span = useActivityStore((s) => spanForTool(s, toolCall.id));
  const timed: ToolCall = span
    ? {
        ...toolCall,
        startedAt: span.waitUntil ?? span.startedAt,
        ...(span.endedAt !== undefined ? { endedAt: span.endedAt } : {}),
      }
    : toolCall;
  // Resolve the renderer for this tool (backend-scoped exact -> global exact ->
  // shape-sniffing predicate). Falls back to the generic renderer.
  const renderer = root.renderers.resolve(toolCall, backendId) ?? GENERIC_RENDERER;
  const Icon = renderer.icon ?? FileText;
  const label =
    typeof renderer.label === "function"
      ? renderer.label(toolCall)
      : renderer.label ?? getToolLabel(toolCall.name);
  const isPending = toolCall.status === "pending_approval";
  const keys = useUIStore((s) => s.singleKeyShortcuts);
  /**
   * A decision hands focus on before the card goes (D36): the next pending
   * approval in the transcript, else the composer — the thing the reader
   * continues with, since a chat has no empty-state heading to land on.
   */
  function decide(card: HTMLElement | null, approved: boolean, always?: boolean) {
    if (card) focusAfterDecision(card, "[data-approval-card]", "textarea[data-composer]");
    onApproval(toolCall.id, approved, always);
  }
  function onCardKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!keys) return;
    const key = singleKey(event);
    if (key !== "a" && key !== "d") return;
    event.preventDefault();
    decide(event.currentTarget, key === "a");
  }
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
          {label}
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

      {/* Live subagent state for tool fan-outs, fed by the activity stream. */}
      {renderer.subagentRows && <SubagentEntryRows agentToolUseId={toolCall.id} />}

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
              {isPending && (
                <RiskHints toolCall={toolCall} semantics={renderer.semantics} />
              )}

              {/* Approval buttons. "Always allow" only for grantable tool
                  requests — a destructive-command confirmation (kind
                  "command") stays per-use. */}
              {isPending && (
                // The card is the focus scope for `a` / `d` (D36): the keys
                // act only while it, or a button inside it, holds focus, and
                // they are printed on the buttons they belong to.
                <div
                  data-approval-card=""
                  role="group"
                  aria-label={`Approval: ${label}`}
                  tabIndex={0}
                  onKeyDown={onCardKeyDown}
                  className="flex flex-wrap gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <button
                    onClick={(e) => decide(e.currentTarget.closest("[data-approval-card]"), true)}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:brightness-110"
                  >
                    <Check className="h-3 w-3" />
                    Allow
                    {keys && <KeyCap>a</KeyCap>}
                  </button>
                  {toolCall.approvalKind !== "command" && (
                    <button
                      onClick={(e) => decide(e.currentTarget.closest("[data-approval-card]"), true, true)}
                      title={`Allow ${toolCall.name} without asking from now on (revocable in Settings → Models)`}
                      className="flex items-center gap-1.5 rounded-lg border border-primary/40 px-4 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                    >
                      <Check className="h-3 w-3" />
                      Always allow
                    </button>
                  )}
                  <button
                    onClick={(e) => decide(e.currentTarget.closest("[data-approval-card]"), false)}
                    className="flex items-center gap-1.5 rounded-lg border border-destructive/30 px-4 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
                  >
                    <X className="h-3 w-3" />
                    Deny
                    {keys && <KeyCap>d</KeyCap>}
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
  const stepCount = useActivityStore(
    useShallow((s) => childSpans(s, agentToolUseId).length)
  );
  const pushSubagentView = useUIStore((s) => s.pushSubagentView);
  const now = useNow();
  if (!span || span.kind !== "subagent") return null;

  const description = span.subagent?.description ?? "subagent";
  const tokens = span.subagent?.totalTokens ?? null;
  const elapsed = formatDuration((span.endedAt ?? now) - span.startedAt);

  return (
    <button
      type="button"
      onClick={() => pushSubagentView(agentToolUseId)}
      className="ml-6 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-md px-2 py-1 text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground"
    >
      <SpanStatusDot span={span} />
      <span className="truncate">{description}</span>
      <span className="ml-auto shrink-0 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/50">
        {stepCount > 0 && `${stepCount} step${stepCount === 1 ? "" : "s"} · `}
        {tokens !== null && `${formatTokenCount(tokens)} tok · `}
        {elapsed}
      </span>
      <ChevronRight className="h-3 w-3 shrink-0" />
    </button>
  );
}

function RiskHints({
  toolCall,
  semantics,
}: {
  toolCall: ToolCall;
  semantics?: ToolSemantics;
}) {
  const hints = riskHints(toolCall, semantics);
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

