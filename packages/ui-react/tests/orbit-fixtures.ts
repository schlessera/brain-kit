import type { ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";
export const orbitStart = Date.UTC(2026, 6, 12, 6, 12);
export function parallelSpans(): ActivitySpan[] {
  const base = { runId: "crossing-run", origin: "cron" as const, sessionId: "crossing-chat", startedAt: orbitStart };
  const agents: ActivitySpan[] = [
    { ...base, spanId: "research", parentSpanId: "root", kind: "subagent", name: "invoke_agent", subagent: { type: "researcher", description: "Compare Circe’s directions." } },
    { ...base, spanId: "coast", parentSpanId: "root", kind: "subagent", name: "invoke_agent", startedAt: orbitStart + 1, subagent: { type: "chart-coast" } },
    { ...base, spanId: "tides", parentSpanId: "root", kind: "subagent", name: "invoke_agent", startedAt: orbitStart + 2, subagent: { type: "tide-tables" } },
    { ...base, spanId: "filer", parentSpanId: "root", kind: "subagent", name: "invoke_agent", endedAt: orbitStart + 42000, outcome: "success", subagent: { type: "note-filer" } },
    { ...base, spanId: "ledger", parentSpanId: "root", kind: "subagent", name: "invoke_agent", startedAt: orbitStart + 3, endedAt: orbitStart + 63003, outcome: "error", subagent: { type: "ledger" } },
    { ...base, spanId: "watch", parentSpanId: "root", kind: "subagent", name: "invoke_agent", startedAt: orbitStart + 4, endedAt: orbitStart + 8004, outcome: "cancelled", subagent: { type: "source-watch" } },
  ];
  return [{ ...base, spanId: "root", kind: "cron", name: "Review the crossing" }, ...agents,
    { ...base, spanId: "approval-write", parentSpanId: "research", kind: "tool", name: "execute_tool Write", toolName: "Write" }];
}
