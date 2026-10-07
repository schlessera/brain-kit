import type { ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";
export const laneStart = Date.UTC(2026,6,12,6,12);
export function timedSpans(): ActivitySpan[] {
  const base={runId:"crossing-lanes",origin:"cron" as const,startedAt:laneStart};
  return [
    {...base,spanId:"root",kind:"cron",name:"Review the crossing",endedAt:laneStart+60000,outcome:"success"},
    {...base,spanId:"research",parentSpanId:"root",kind:"subagent",name:"invoke_agent",subagent:{type:"researcher"},waitUntil:laneStart+10000,endedAt:laneStart+40000,outcome:"success"},
    {...base,spanId:"ledger",parentSpanId:"root",kind:"subagent",name:"invoke_agent",subagent:{type:"ledger"},startedAt:laneStart+15000,endedAt:laneStart+45000,outcome:"timeout"},
    {...base,spanId:"watch",parentSpanId:"root",kind:"subagent",name:"invoke_agent",subagent:{type:"source-watch"},startedAt:laneStart+30000,endedAt:laneStart+60000,outcome:"cancelled"},
    {...base,spanId:"denied",parentSpanId:"root",kind:"tool",toolName:"Write",name:"execute_tool Write",startedAt:laneStart+5000,endedAt:laneStart+10000,outcome:"denied"},
  ];
}
