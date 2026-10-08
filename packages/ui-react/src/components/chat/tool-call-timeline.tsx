import { useBrainUiRoot } from "../../root-context.js";
import { useState, useEffect, useRef, type KeyboardEvent } from "react";
import {
  Check,
  X,
  Layers,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  FileText,
} from "lucide-react";
import { type ToolSemantics } from "@schlessera/brain-ui-sdk/client";
import { awaitsDecision, offersAlwaysAllow, useChatStore, type ToolCall } from "../../stores/chat-store.js";
import { restoredApprovalWord } from "../../lib/restored-approvals.js";
import { cn } from "../../lib/utils.js";
import { motion, AnimatePresence } from "framer-motion";
import { effectOf, getToolLabel, getTouchedFile, formatDuration, formatTokenCount } from "./tool-views.js";
import { registerBuiltinRenderers, GENERIC_RENDERER } from "./renderers/index.js";
import { riskHints } from "./risk-hints.js";
import { useShallow } from "zustand/react/shallow";
import { focusAfterDecision, singleKey } from "../../lib/single-key.js";
import { KeyCap } from "../layout/key-cap.js";
import { useActivityStore, spanForTool, childSpans } from "../../stores/activity-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useNow } from "../../hooks/use-now.js";
import { useFinePointer } from "../../hooks/use-fine-pointer.js";
import { SpanStatusDot } from "../activity/span-bits.js";
import { CopyButton, EnclosingCopyControl } from "./copy-button.js";

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

  // A restored card the host closed (#1072) stays open too: it is read-only,
  // and says why, so it must not fold into the summary row.
  const hasPending = toolCalls.some((t) => awaitsDecision(t) || (t.restored && t.readOnly));
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

/** Flat message slots keep a card mounted when recovered text splits its run. */
export function ToolCallTimelineCell({
  toolCalls, toolIndex, onApproval, live, collapsed, onExpand, onCollapse,
}: {
  toolCalls: ToolCall[];
  toolIndex: number;
  onApproval: (toolUseId: string, approved: boolean, always?: boolean) => void;
  live: boolean;
  collapsed: boolean;
  onExpand: () => void;
  onCollapse: () => void;
}) {
  const root = useBrainUiRoot();
  registerBuiltinRenderers(root.renderers);
  const backendId = useBackendId();
  const hasPending = toolCalls.some((t) => awaitsDecision(t) || (t.restored && t.readOnly));
  const effectiveCollapsed = collapsed && !hasPending && !live;
  const first = toolIndex === 0;
  return (
    <div hidden={effectiveCollapsed && !first} style={{
      marginTop: first ? undefined : 0,
      marginBottom: toolIndex === toolCalls.length - 1 ? undefined : 0,
    }}>
      {first && effectiveCollapsed && <TimelineSummaryRow toolCalls={toolCalls} backendId={backendId} onExpand={onExpand} />}
      {first && !effectiveCollapsed && !live && !hasPending && (
        <button type="button" onClick={onCollapse} className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground/50 transition-colors hover:text-muted-foreground">
          <ChevronDown className="h-3 w-3" />
          Hide steps
        </button>
      )}
      <div hidden={effectiveCollapsed} className="relative ml-1 border-l-2 border-border/40 pl-4" style={{ paddingTop: first ? undefined : 6 }}>
        <ToolCallEntry toolCall={toolCalls[toolIndex]!} backendId={backendId} onApproval={onApproval} />
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
  const isPending = awaitsDecision(toolCall);
  // A restored card the host no longer lists as pending (#1072, D52 §4 R3):
  // read-only, with the host fact that closed it. Nothing on it can reply.
  const closed = toolCall.restored ? toolCall.readOnly : undefined;
  const closedWord = restoredApprovalWord(closed);
  const keys = useUIStore((s) => s.singleKeyShortcuts);
  // The caps are printed only while a fine pointer is present (#86); the letters
  // themselves follow the Settings switch alone, so a paired keyboard works
  // even if the pointer query stays coarse.
  const finePointer = useFinePointer();
  const printKeys = keys && finePointer;
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
      {/* Timeline dot: a bare mark with no content, so it takes the MARK
          weight — a fill sits at 1.3-1.8:1 on paper at any diameter. */}
      <div
        className={cn(
          "absolute -left-[21px] top-2 h-2.5 w-2.5 rounded-full border-2 border-background",
          toolCall.status === "streaming" && "bg-primary-mark animate-pulse",
          isPending && "bg-primary-mark",
          toolCall.status === "approved" && "bg-accent-mark",
          toolCall.status === "denied" && "bg-destructive-mark",
          toolCall.status === "complete" &&
            (toolCall.isError ? "bg-destructive-mark" : "bg-accent-mark"),
          (!["streaming", "pending_approval", "approved", "denied", "complete"].includes(toolCall.status)
            || (toolCall.status === "pending_approval" && !isPending)) && "bg-muted-foreground"
        )}
        style={
          isPending
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
          {/* R3 (D52 §4): the host handed this pending card back after a
              reload; it is the original request, not a new one. */}
          {(isPending || closed) && toolCall.restored && (
            <span
              data-restored-approval=""
              className="rounded-full border border-border-subtle px-1.5 py-px font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground"
            >
              restored
            </span>
          )}
          {meta && (
            <span className="font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/50">
              {meta}
            </span>
          )}
          {/* A closed card's word replaces "Approval needed": it needs nothing. */}
          {!(closed && toolCall.status === "pending_approval") && (
            <StatusIndicator status={toolCall.status} isError={toolCall.isError} />
          )}
        </span>
      </button>

      {/* Why a restored card is read-only (D52 §4 R3), on its own line so the
          words wrap at a phone's width instead of leaving the header row. */}
      {closedWord && (
        <p
          data-restored-closure={closed}
          className="pb-1 pl-[30px] pr-2 font-[family-name:var(--font-mono)] text-[11px] text-muted-foreground"
        >
          {closedWord}
        </p>
      )}

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
                  ? "border-2 border-primary/40 bg-primary-fill/5"
                  : "border border-border-subtle bg-surface"
              )}
            >
              {/* Tool input */}
              {Input && <Input tool={toolCall} />}

              {/* What a confirmed command will do, in words (#112) */}
              {isPending && effectOf(toolCall) && (
                <p className="text-[11px] text-muted-foreground">{effectOf(toolCall)}</p>
              )}

              {/* Risk hints — advisory only, never blocks approval */}
              {isPending && (
                <RiskHints toolCall={toolCall} semantics={renderer.semantics} />
              )}

              {/* Approval buttons. "Always allow" only for grantable tool
                  requests — a destructive-command confirmation (kind
                  "command") stays per-use, and a grant the host said it
                  will not keep (#147) is not offered. */}
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
                    className="flex items-center gap-1.5 rounded-lg bg-primary-fill px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:brightness-110"
                  >
                    <Check className="h-3 w-3" />
                    Allow
                    {printKeys && <KeyCap>a</KeyCap>}
                  </button>
                  {offersAlwaysAllow(toolCall) && (
                    <button
                      onClick={(e) => decide(e.currentTarget.closest("[data-approval-card]"), true, true)}
                      title={`Allow ${toolCall.name} without asking from now on (revocable in Settings → Models)`}
                      className="flex items-center gap-1.5 rounded-lg border border-primary/40 px-4 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary-fill/10"
                    >
                      <Check className="h-3 w-3" />
                      Always allow
                    </button>
                  )}
                  <button
                    onClick={(e) => decide(e.currentTarget.closest("[data-approval-card]"), false)}
                    className="flex items-center gap-1.5 rounded-lg border border-destructive/30 px-4 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive-fill/10"
                  >
                    <X className="h-3 w-3" />
                    Deny
                    {printKeys && <KeyCap>d</KeyCap>}
                  </button>
                </div>
              )}

              {/* Tool output */}
              {toolCall.output && Output && (
                <div className="relative">
                  <CopyButton
                    label="Copy output"
                    getText={() => toolCall.output!}
                    className="absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
                  />
                  <EnclosingCopyControl>
                    <Output tool={toolCall} />
                  </EnclosingCopyControl>
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
    <div className="space-y-0.5 text-[11px] text-primary">
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
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary-mark" />
      );
    case "pending_approval":
      return (
        <span className="rounded bg-primary-fill/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
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

