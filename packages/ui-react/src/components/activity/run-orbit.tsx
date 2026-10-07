import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { AgentOrbit, type OrbitAgent } from "@schlessera/brain-ui-kit";
import { isFailureOutcome, type ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { awaitsDecision } from "../../stores/chat-store.js";
import { formatDuration } from "../chat/tool-views.js";

/** Map recorded dispositions; a radius carries no completion estimate. */
export function orbitAgent(span: ActivitySpan, waiting: boolean): OrbitAgent {
  const outcome = span.outcome;
  const state = outcome !== undefined
    ? outcome === "success" ? "done" : isFailureOutcome(outcome) ? "failed" : "stopped"
    : waiting ? "waiting" : "running";
  const duration = span.endedAt !== undefined && Number.isFinite(span.endedAt - span.startedAt) && span.endedAt >= span.startedAt
    ? formatDuration(span.endedAt - span.startedAt) : undefined;
  return { id: span.spanId, name: span.subagent?.type || "agent", state,
    meta: outcome !== undefined ? [outcome, duration].filter(Boolean).join(" · ") : waiting ? "needs approval" : undefined };
}
export function openRecordedAgent(root: ReturnType<typeof useBrainUiRoot>, span: ActivitySpan, runSession?: string) {
  const session = span.sessionId ?? runSession;
  if (session) root.stores.chat.getState().setActiveSession(session);
  root.stores.ui.getState().setActiveView("chat");
  root.stores.ui.getState().pushSubagentView(span.spanId);
}
/** Approvals must belong to this run and its recorded chat, not the foreground chat. */
export function useOrbitAgents(spans: ActivitySpan[]) {
  const buffers = useRootStore("chat", s => s.buffers);
  return useMemo(() => {
    const parent = new Map(spans.map(span => [span.spanId, span]));
    const runSession = spans.find(span => !span.parentSpanId)?.sessionId;
    const pending = new Map<string, Set<string>>();
    for (const span of spans) {
      const session = span.sessionId ?? runSession;
      if (!session || pending.has(session)) continue;
      pending.set(session, new Set((buffers[session]?.messages ?? []).flatMap(message => message.toolCalls.filter(awaitsDecision).map(tool => tool.id))));
    }
    return spans.filter(span => span.kind === "subagent" && span.parentSpanId).sort((a,b) => a.startedAt - b.startedAt || (a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0)).map(span => {
      const session = span.sessionId ?? runSession;
      const waiting = [...(session ? pending.get(session) ?? [] : [])].some(id => {
        const visited = new Set<string>();
        let item = parent.get(id);
        while (item && !visited.has(item.spanId)) {
          if (item.parentSpanId === span.spanId) return true;
          visited.add(item.spanId); item = item.parentSpanId ? parent.get(item.parentSpanId) : undefined;
        }
        return false;
      });
      return orbitAgent(span, waiting);
    });
  }, [spans, buffers]);
}
export function RunOrbit({ agents, onOpen, onOverflow }: { agents: OrbitAgent[]; onOpen: (id: string) => void; onOverflow: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const measure = () => setWidth(Math.floor(node.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const compact = width < 480;
  return <div ref={container} data-run-orbit="" className="w-full py-3">
    <AgentOrbit agents={agents} coreMeta={`${agents.length} agents`} compact={compact}
      width={compact ? Math.min(width || 280, 280) : 340} height={compact ? 236 : 284}
      onOpen={onOpen} onOverflow={onOverflow}/>
  </div>;
}
