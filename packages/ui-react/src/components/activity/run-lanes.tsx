import { useEffect, useMemo, useState } from "react";
import { HATCH_GLYPH, LaneChart, type Lane, type LaneLegendItem } from "@schlessera/brain-ui-kit";
import { isFailureOutcome, type ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";
import { formatDuration } from "../chat/tool-views.js";
import { spanToolLabel } from "./span-bits.js";

interface Interval {
  span: ActivitySpan;
  name: string;
  start?: number;
  end?: number;
  wait?: number;
  active: boolean;
  missing?: string;
}
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
/** One axis for recorded intervals. Never infer a terminal end or approval boundary. */
export function recordedLanes(spans: ActivitySpan[], now: number, liveRun: boolean) {
  const rows: Interval[] = spans.filter(span => span.parentSpanId).map(span => {
    const name = span.subagent?.type || spanToolLabel(span);
    const active = liveRun && span.outcome === undefined && span.endedAt === undefined;
    if (!timestamp(span.startedAt)) return { span, name, active: false, missing: "Start not recorded" };
    const start = span.startedAt;
    const end = active ? now : span.endedAt;
    if (!timestamp(end) || end < start) return { span, name, start, active: false, missing: "End not recorded" };
    const hasWait = span.waitUntil !== undefined;
    const wait = timestamp(span.waitUntil) && span.waitUntil >= start && span.waitUntil <= end ? span.waitUntil : undefined;
    return { span, name, start, end, wait, active, missing: hasWait && wait === undefined ? "Approval boundary unavailable" : undefined };
  });
  const timed = rows.filter((row): row is Interval & { start: number; end: number } => row.start !== undefined && row.end !== undefined);
  const root = spans.find(span => !span.parentSpanId);
  const start = timed.length ? timed.reduce((min, row) => Math.min(min, row.start), timestamp(root?.startedAt) ? root.startedAt : timed[0]!.start) : undefined;
  const end = timed.length ? timed.reduce((max, row) => Math.max(max, row.end), timestamp(root?.endedAt) ? root.endedAt : timed[0]!.end) : undefined;
  const duration = start !== undefined && end !== undefined ? end - start : 0;
  const lanes: Lane[] = duration <= 0 ? [] : timed.map(row => {
    const position = (time: number) => 100 * (time - start!) / duration;
    const segments: Lane['segments'] = [];
    if (row.wait !== undefined && row.wait > row.start) segments.push({ start: position(row.start), width: 100 * (row.wait - row.start) / duration, hatch: true });
    const executing = row.wait ?? row.start;
    if (row.end > executing) segments.push({ start: position(executing), width: 100 * (row.end - executing) / duration, ...(row.active ? { fade: true } : {}) });
    return { name: row.name, tone: row.active ? "amber" : row.span.outcome === "success" ? "teal" : isFailureOutcome(row.span.outcome) ? "red" : "neutral", segments };
  });
  const ticks = duration <= 0 ? [] : [0,1,2,3].map(i => formatDuration(duration * i / 3));
  const legend: LaneLegendItem[] = [];
  if (timed.some(row => !row.active && row.span.outcome === undefined)) legend.push({ label: "outcome not recorded", tone: "neutral" });
  if (timed.some(row => row.active)) legend.push({ label: "active · open tail", tone: "amber" });
  if (timed.some(row => row.span.outcome === "success")) legend.push({ label: "success", tone: "teal" });
  if (timed.some(row => isFailureOutcome(row.span.outcome))) legend.push({ label: "failure", tone: "red" });
  if (timed.some(row => row.span.outcome === "denied" || row.span.outcome === "cancelled")) legend.push({ label: "stopped", tone: "neutral" });
  if (timed.some(row => row.wait !== undefined && row.wait > row.start)) legend.push({ label: "waiting on you", tone: "neutral", glyph: HATCH_GLYPH });
  return { rows, lanes, ticks, legend, start, duration };
}
export function RunLanes({ spans, liveRun }: { spans: ActivitySpan[]; liveRun: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const running = liveRun && spans.some(span => span.parentSpanId && span.outcome === undefined && span.endedAt === undefined);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const chart = useMemo(() => recordedLanes(spans, now, liveRun), [spans, now, liveRun]);
  if (!chart.rows.length) return null;
  const elapsed = (time: number) => formatDuration(time - chart.start!);
  return <section data-run-lanes="" aria-label="Recorded timing" className="py-3">
    <h2 className="mb-2 text-xs font-medium text-foreground">Recorded timing</h2>
    {chart.start !== undefined && <p className="mb-2 break-words text-[10px] text-muted-foreground">Elapsed from {new Date(chart.start).toISOString()}</p>}
    {chart.lanes.length ? <div aria-hidden="true"><LaneChart lanes={chart.lanes} ticks={chart.ticks} legend={chart.legend} labelWidth={88}/></div>
      : <p className="text-xs text-muted-foreground">No complete nonzero intervals recorded.</p>}
    <p className="mt-2 text-[10px] text-muted-foreground">Hatching uses recorded approval boundaries. Unrecorded waits cannot be separated.</p>
    <ul aria-label="Recorded span intervals" className="mt-2 space-y-1 text-[11px] text-muted-foreground">
      {chart.rows.map(row => <li key={row.span.spanId} data-lane-record={row.span.spanId} className="break-words [overflow-wrap:anywhere]">
        {row.name} · {row.span.outcome ?? (row.active ? "active" : "outcome not recorded")}
        {row.start !== undefined && row.end !== undefined ? ` · ${elapsed(row.start)}–${elapsed(row.end)}${row.active ? " · open tail" : ""}` : ""}
        {row.wait !== undefined && row.start !== undefined ? ` · waiting on you ${elapsed(row.start)}–${elapsed(row.wait)}` : ""}
        {row.missing ? ` · ${row.missing}` : ""}
      </li>)}
    </ul>
  </section>;
}
