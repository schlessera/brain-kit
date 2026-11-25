import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { TextButton } from "../primitives/TextButton.js";
import { accent, color, font, token } from "../tokens.js";
import { EventList } from "./EventList.js";
import {
  HISTORY_COPY,
  LABEL_SIZE,
  historyLayout,
  textWidth,
  type HistoryLayout,
  type HistoryMarker,
  type HistoryPoint,
  type HistoryScenario,
  type HistoryScenarioWindow,
  type HistoryThresholds,
} from "./history-geometry.js";

/**
 * Available space over time for one volume (#4543, #4537 D3 and D12): a
 * hand-rolled SVG with its geometry in `history-geometry.ts`.
 *
 * What it draws, and the non-colour cue each one carries:
 *
 * | Layer | Cue |
 * | --- | --- |
 * | the series: a 2px line over a 16% area | the line itself |
 * | Low and Very low bands, from props | `△ Low < …` / `▲ Very low < …`, dashed and dotted edges |
 * | a gap | the line and area break, a 45° hatch, `?` and "no observation · not zero" |
 * | the current bucket | a hollow point and a dotted last edge; the table says "provisional" |
 * | now | a rule and a bold `now` on the axis, with the value beside the point |
 * | the future | a tinted zone and the word `future` |
 * | one line per qualified window (D9) | its dash: short `7 4`, long `2 3`; labelled with its window |
 * | a scope change | a solid rule, `↺ scope changed`, and a mute dotted series for `other volume` |
 * | events | a dotted rule and a numbered box under the axis, matched by `EventList` |
 *
 * There is no cone and no fill between scenario lines: a range is not a
 * confidence interval. With no qualified window the caption says why.
 *
 * **Width decides the layout.** From 600px the scenario labels sit in a right
 * gutter beside their lines (maintainer ruling, 2026-11-25); below that the
 * lines are told apart by dash alone and the caption repeats each dash with its
 * copy. The chart measures its own container unless `width` is given.
 *
 * **The table is the inspector.** There is no scrubbable point readout. The
 * SVG is one `role="img"` with a summary name, and `View as table` discloses
 * an equivalent table (time, value, state, then the events), which is the
 * screen-reader path. Pointer hover shows a native `<title>` per point.
 * Nothing animates, so there is no reduced-motion variant to keep.
 *
 * Presentational only: the series, thresholds, scenario endpoints and event
 * markers all arrive as props, and every number is formatted by the caller's
 * formatters. Tier switching (Recent, Daily, Weekly) stays outside, with
 * `FilterRow`.
 */
export interface HistoryChartProps {
  /** Leads the accessible name and the table caption: "Available space, Data volume, last 16 days". */
  label: string;
  points: readonly HistoryPoint[];
  /** Epoch ms. Defaults to the last point's time. */
  now?: number;
  /** The tier's bucket interval in ms: pads a sparse or single-point domain. */
  intervalMs?: number;
  /** The same interval, pre-formatted ("6 h"), for the single-point caption. */
  intervalLabel?: string;
  thresholds?: HistoryThresholds;
  /** At most one per window. A scenario without `to` is unavailable and needs a `reason`. */
  scenarios?: readonly HistoryScenario[];
  markers?: readonly HistoryMarker[];
  /** The volume's state now, for the accessible name: "Low". */
  nowState?: string;
  /** Extra caption lines, e.g. "Weekly history starts 28 Jun · 3 points so far". */
  notes?: readonly string[];
  /** Why an all-unknown range has no measurements. */
  unmeasuredReason?: string;
  /** The value column's heading in the table. */
  valueHeading?: string;
  /** Renders the numbered `EventList` under the chart. Default true. */
  showEvents?: boolean;
  formatValue: (value: number) => string;
  /** Axis labels: "27 Jun". */
  formatTick: (at: number) => string;
  /** Table rows and gap captions: "2 Jul 06:00". Defaults to `formatTick`. */
  formatTime?: (at: number) => string;
  /** A gap's span: "2 Jul 06:00–12:00". Defaults to two `formatTime`s. */
  formatSpan?: (from: number, to: number) => string;
  /** A fixed width in px. Without it the chart measures its container. */
  width?: number;
}

/** Dash per window, and the glyph that names it in the caption. */
export const SCENARIO_DASH: Record<HistoryScenarioWindow, { dash: string; glyph: string }> = {
  short: { dash: "7 4", glyph: "╌" },
  long: { dash: "2 3", glyph: "┄" },
};

const LOW_GLYPH = "△";
const VERY_LOW_GLYPH = "▲";
const GAP_GLYPH = "▨";
const DOT = "·";

const MARKER_EDGES: Record<NonNullable<HistoryMarker["tone"]>, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: color.inkDim,
};

function useMeasuredWidth(fixed: number | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (fixed !== undefined) return;
    const el = ref.current;
    if (!el) return;
    const read = () => setMeasured(Math.floor(el.clientWidth));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fixed]);
  return { ref, width: fixed ?? measured };
}

/** "~20 Jul" reads as "tilde" aloud; the spoken name says "about". */
const spoken = (text: string) => text.replace(/~\s*/g, "about ");

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The caption's projection lines, the accessible name's projection clause, and which scenarios drew. */
function projection(layout: HistoryLayout, scenarios: readonly HistoryScenario[]) {
  const drawn = new Set(layout.scenarioLines.map((l) => l.scenario));
  const unavailable = scenarios.filter((s) => !drawn.has(s));
  const lines: Array<{ glyph?: string; text: string; window?: HistoryScenarioWindow }> = [];
  const spokenParts: string[] = [];
  if (drawn.size) {
    for (const line of layout.scenarioLines) {
      const s = line.scenario;
      const text = `${s.name} rate${s.detail ? ` ${DOT} ${s.detail}` : ""}`;
      if (!layout.frame.wide) lines.push({ glyph: SCENARIO_DASH[s.window].glyph, text, window: s.window });
      spokenParts.push(`${s.name} rate${s.detail ? `: ${spoken(s.detail)}` : ""}`);
    }
    for (const s of unavailable) {
      lines.push({ text: `${s.name}: no projection${s.reason ? ` ${DOT} ${s.reason}` : ""}` });
      spokenParts.push(`${s.name}: no projection`);
    }
  } else {
    const first = unavailable.find((s) => s.window === "short") ?? unavailable[0];
    const reason = layout.measuredCount === 1 ? "one measurement so far" : first?.reason;
    lines.push({ text: `No projection${reason ? ` ${DOT} ${reason}` : ""}` });
    spokenParts.push(`No projection${reason ? `, ${reason}` : ""}`);
  }
  return { lines, spoken: spokenParts.join(". ") };
}

export function HistoryChart(p: HistoryChartProps) {
  const { ref, width } = useMeasuredWidth(p.width);
  const rawId = useId();
  const id = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const [tableOpen, setTableOpen] = useState(false);
  const formatTime = p.formatTime ?? p.formatTick;
  const formatSpan = p.formatSpan ?? ((a: number, b: number) => (a === b ? formatTime(a) : `${formatTime(a)}–${formatTime(b)}`));
  const scenarios = p.scenarios ?? [];
  const markers = p.markers ?? [];

  const layout = useMemo(
    () =>
      width === null
        ? null
        : historyLayout({ width, points: p.points, now: p.now, intervalMs: p.intervalMs, thresholds: p.thresholds, scenarios, markers }),
    // `scenarios` and `markers` default to fresh arrays; the props themselves are the inputs.
    [width, p.points, p.now, p.intervalMs, p.thresholds, p.scenarios, p.markers],
  );

  const wrap: CSSProperties = { width: "100%", minWidth: 0, display: "flex", flexDirection: "column", gap: 8 };
  if (!layout) return <div ref={ref} style={wrap} data-part="history-chart" />;

  const proj = projection(layout, scenarios);
  const latest = layout.latest && layout.latest.kind === "current" ? layout.latest : null;

  const nameParts = [p.label];
  if (layout.allUnknown) nameParts.push("No measurements in this range");
  else {
    if (latest) nameParts.push(`Now ${p.formatValue(latest.value)}${p.nowState ? `, ${p.nowState}` : ""}`);
    nameParts.push(proj.spoken);
  }
  if (layout.gaps.length) nameParts.push(plural(layout.gaps.length, "gap"));
  if (layout.scopeBreaks.length) nameParts.push("Scope changed");
  if (markers.length) nameParts.push(plural(markers.length, "event"));
  const name = `${nameParts.filter(Boolean).join(". ")}.`;

  const captionLines: ReactNode[] = [];
  const caption: CSSProperties = { margin: 0, font: `400 11px/1.5 ${font.mono}`, color: color.inkDim, overflowWrap: "anywhere" };
  if (layout.allUnknown) {
    captionLines.push(
      <p key="unknown" style={caption}>
        ? not measured {DOT} {p.unmeasuredReason ?? "no measurements in this range"}
      </p>,
    );
  } else {
    proj.lines.forEach((line, i) =>
      captionLines.push(
        <p key={`p${i}`} style={caption} data-part="projection-caption" data-window={line.window}>
          {line.glyph ? (
            <span aria-hidden="true" style={{ color: color.ink }}>
              {line.glyph}{" "}
            </span>
          ) : null}
          {line.text}
        </p>,
      ),
    );
  }
  const notes: ReactNode[] = [];
  for (const g of layout.gaps) {
    if (!g.captioned) continue;
    notes.push(
      <p key={`g${g.first}`} style={caption} data-part="gap-caption">
        <span aria-hidden="true">{GAP_GLYPH} </span>? {formatSpan(g.first, g.last)} {DOT} no observation {DOT} not zero
      </p>,
    );
  }
  if (layout.measuredCount === 1 && p.intervalLabel) {
    notes.push(
      <p key="next" style={caption}>
        The line starts with the next measurement (~{p.intervalLabel})
      </p>,
    );
  }
  for (const [i, note] of (p.notes ?? []).entries()) {
    notes.push(
      <p key={`n${i}`} style={caption}>
        {note}
      </p>,
    );
  }

  const { frame } = layout;
  // Threshold labels sit inside their bands. Where the plot is too narrow to
  // hold them (200% zoom on a phone), they move to the caption whole rather
  // than being clipped at the plot's edge.
  const bandText = (kind: "low" | "veryLow", level: number) =>
    `${kind === "low" ? LOW_GLYPH : VERY_LOW_GLYPH} ${kind === "low" ? "Low" : "Very low"} < ${p.formatValue(level)}`;
  const bandsInPlot = layout.bands.every((b) => textWidth(bandText(b.kind, b.level)) + 8 <= frame.right - frame.left);
  if (!bandsInPlot && layout.bands.length) {
    notes.unshift(
      <p key="bands" style={caption} data-part="band-caption">
        {[...layout.bands].reverse().map((b) => bandText(b.kind, b.level)).join(` ${DOT} `)}
      </p>,
    );
  }
  const mono = (size = LABEL_SIZE, weight = 400) => ({ fontFamily: font.mono, fontSize: size, fontWeight: weight });
  const hatch = `${id}-hatch`;
  const clip = `${id}-plot`;
  const plotW = frame.right - frame.left;
  const plotH = frame.bottom - frame.top;
  const sorted = [...p.points].sort((a, b) => a.at - b.at);

  // The now value: right of the point if it fits, else above it, reading
  // into the future zone, where only the scenario lines (heading down and
  // right) and the latest point's own edge can be.
  const nowLabel = latest
    ? (() => {
        const text = p.formatValue(latest.value);
        const w = textWidth(text, 10);
        const high = latest.y - 10 >= frame.top + 18;
        const y = high ? latest.y - 10 : latest.y + 18;
        if (latest.x + 7 + w <= frame.right) return { text, x: latest.x + 7, y: high ? latest.y - 6 : y, anchor: "start" as const };
        if (latest.x - 2 + w <= frame.width) return { text, x: latest.x - 2, y, anchor: "start" as const };
        return { text, x: latest.x + 2, y, anchor: "end" as const };
      })()
    : null;

  const svg = (
    <svg
      role="img"
      aria-label={name}
      width={frame.width}
      height={frame.height}
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      style={{ display: "block", overflow: "visible", maxWidth: "100%" }}
      data-part="history-svg"
      data-layout={frame.wide ? "gutter" : "caption"}
    >
      <defs>
        <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke={color.edge} strokeWidth="2" />
        </pattern>
        <clipPath id={clip}>
          <rect x={frame.left} y={frame.top - 1} width={plotW} height={plotH + 2} />
        </clipPath>
      </defs>

      {/* Grid and y labels. */}
      {layout.yTicks.map((t) => (
        <g key={`y${t.value}`} data-part="y-tick">
          <line x1={frame.left} x2={frame.right} y1={t.y} y2={t.y} stroke={color.line} strokeWidth={1} />
          <text x={frame.left - 6} y={t.y + 3} textAnchor="end" fill={color.inkMute} style={mono()}>
            {p.formatValue(t.value)}
          </text>
        </g>
      ))}

      {/* Future zone. */}
      <rect data-part="future" x={layout.future.x} y={frame.top} width={Math.max(0, layout.future.width)} height={plotH} fill={color.raised} />

      {/* Bands, under the series. */}
      {layout.bands.map((b) => (
        <g key={b.kind} data-part={`band-${b.kind}`}>
          <rect x={b.x} y={b.y} width={b.width} height={b.height} fill={token(b.kind === "low" ? "chip-tint-amber" : "chip-tint-red")} />
          <line
            x1={b.x}
            x2={b.x + b.width}
            y1={b.edgeY}
            y2={b.edgeY}
            stroke={b.kind === "low" ? accent.amber.ink : accent.red.ink}
            strokeWidth={b.kind === "low" ? 1 : 1.5}
            strokeDasharray={b.kind === "low" ? "4 3" : "1.5 2.5"}
          />
        </g>
      ))}

      {/* Gaps: hatched, never bridged. */}
      {layout.gaps.map((g) => (
        <rect key={`gap${g.first}`} data-part="gap" x={g.x0} y={frame.top} width={Math.max(2, g.x1 - g.x0)} height={plotH} fill={`url(#${hatch})`} />
      ))}

      <g clipPath={`url(#${clip})`}>
        {/* The series. Each segment is its own path: a gap or a scope change is never joined. */}
        {layout.segments.map((s, i) => {
          const other = s.kind === "other";
          const stroke = other ? color.inkMute : accent.teal.ink;
          return (
            <g key={`s${i}`} data-part="segment" data-kind={s.kind}>
              {s.area ? <path data-part="area" d={s.area} fill={other ? color.inkMute : accent.teal.fill} fillOpacity={other ? 0.08 : 0.16} stroke="none" /> : null}
              {s.line ? (
                <path
                  data-part="line"
                  d={s.line}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={other ? 1.5 : 2}
                  strokeDasharray={other ? "1.5 3" : undefined}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ) : null}
              {s.tail ? <path data-part="tail" d={s.tail} fill="none" stroke={stroke} strokeWidth={2} strokeDasharray="1.5 3" strokeLinecap="round" /> : null}
            </g>
          );
        })}
      </g>

      {/* Scope change: a solid rule, never crossed by the series. */}
      {layout.scopeBreaks.map((b) => (
        <line key={`scope${b.at}`} data-part="scope-break" x1={b.x} x2={b.x} y1={frame.top} y2={frame.bottom} stroke={color.ink} strokeWidth={1.5} />
      ))}

      {/* Event rules: one per event, even when their boxes merge. */}
      {markers.map((m) => (
        <line
          key={`rule${m.n}`}
          data-part="event-rule"
          x1={layout.x(m.at)}
          x2={layout.x(m.at)}
          y1={frame.top}
          y2={frame.bottom}
          stroke={color.inkMute}
          strokeWidth={1}
          strokeDasharray="1 3"
        />
      ))}

      {/* Now. */}
      <line data-part="now-rule" x1={layout.nowX} x2={layout.nowX} y1={frame.top} y2={frame.bottom} stroke={color.edge} strokeWidth={1} />

      {/* One line per qualified window. Never a filled shape. */}
      {layout.scenarioLines.map((l) => (
        <line
          key={`sc${l.scenario.window}`}
          data-part="scenario"
          data-window={l.scenario.window}
          x1={l.x1}
          y1={l.y1}
          x2={l.x2}
          y2={l.y2}
          stroke={color.ink}
          strokeWidth={1.5}
          strokeDasharray={SCENARIO_DASH[l.scenario.window].dash}
          fill="none"
        />
      ))}

      {/* Dots: countable points, and any point that stands alone between gaps. */}
      {layout.dots
        .filter((d) => !(d.provisional && d === layout.latest))
        .map((d) => (
          <circle key={`d${d.at}`} data-part="dot" cx={d.x} cy={d.y} r={3.5} fill={d.kind === "other" ? color.inkMute : accent.teal.ink} />
        ))}
      {layout.latest ? (
        <circle
          data-part="latest"
          data-provisional={layout.latest.provisional}
          cx={layout.latest.x}
          cy={layout.latest.y}
          r={4.5}
          fill={layout.latest.provisional ? color.surface : layout.latest.kind === "other" ? color.inkMute : accent.teal.ink}
          stroke={layout.latest.kind === "other" ? color.inkMute : accent.teal.ink}
          strokeWidth={2}
        />
      ) : null}

      {/* Labels: bands, then the top row, then the now value. */}
      {(bandsInPlot ? layout.bands : []).map((b) => {
        const isLow = b.kind === "low";
        const below = b.height >= 14;
        return (
          <text
            key={`bl${b.kind}`}
            data-part="band-label"
            x={frame.left + 6}
            y={below ? b.edgeY + 11 : b.edgeY - 4}
            fill={isLow ? accent.amber.ink : accent.red.ink}
            style={mono()}
          >
            {bandText(b.kind, b.level)}
          </text>
        );
      })}
      {layout.gaps
        .filter((g) => g.label)
        .map((g) => (
          <text key={`gl${g.first}`} data-part="gap-label" x={g.labelX} y={frame.top + 11} textAnchor="middle" fill={color.inkDim} style={mono()}>
            {g.label}
          </text>
        ))}
      {layout.topLabels
        .filter((t) => t.role !== "gap")
        .map((t) => (
          <text
            key={`tl${t.role}${t.x}`}
            data-part={`${t.role}-label`}
            x={t.x}
            y={frame.top + 11}
            textAnchor={t.anchor}
            fill={t.role === "scope" ? color.ink : color.inkMute}
            style={mono(LABEL_SIZE, t.role === "scope" ? 600 : 400)}
          >
            {t.text}
          </text>
        ))}
      {nowLabel ? (
        <text data-part="now-value" x={nowLabel.x} y={nowLabel.y} textAnchor={nowLabel.anchor} fill={color.ink} style={mono(10, 600)}>
          {nowLabel.text}
        </text>
      ) : null}

      {/* X axis. */}
      {layout.xTicks.map((t) => (
        <text
          key={`x${t.at}`}
          data-part="x-tick"
          data-now={t.now ? "" : undefined}
          x={t.x}
          y={frame.bottom + 13}
          textAnchor={t.now ? "middle" : t.x - frame.left < 24 ? "start" : "middle"}
          fill={t.now ? color.ink : color.inkMute}
          style={mono(LABEL_SIZE, t.now ? 700 : 400)}
        >
          {t.now ? HISTORY_COPY.now : p.formatTick(t.at)}
        </text>
      ))}

      {/* Gutter scenario labels, from 600px. */}
      {layout.scenarioLabels.map(({ line, y }) => {
        const s = line.scenario;
        const x0 = frame.right + 6;
        return (
          <g key={`lab${s.window}`} data-part="scenario-label" data-window={s.window}>
            {/* A leader only for a label pushed off its line's exit at the edge. A
                line that meets zero first ends there: a leader along the baseline
                would read as the scenario running on at zero. */}
            {line.x2 >= frame.right - 0.5 && Math.abs(y - line.y2) > 1 ? (
              <polyline data-part="leader" points={`${line.x2},${line.y2} ${x0 - 2},${y}`} fill="none" stroke={color.inkMute} strokeWidth={0.75} />
            ) : null}
            <line x1={x0} x2={x0 + 12} y1={y} y2={y} stroke={color.ink} strokeWidth={1.5} strokeDasharray={SCENARIO_DASH[s.window].dash} />
            <text x={x0 + 16} y={y + 3} fill={color.ink} style={mono(10, 600)}>
              {`${s.name} rate`}
            </text>
            {s.detail ? (
              <text x={x0 + 16} y={y + 15} fill={color.inkDim} style={mono(10)}>
                {s.detail}
              </text>
            ) : null}
          </g>
        );
      })}

      {/* Event boxes, in their own lane under the axis. */}
      {layout.markers.map((c) => {
        const tone = c.markers.length === 1 ? c.markers[0]!.tone ?? "neutral" : "neutral";
        const top = frame.bottom + 22;
        return (
          <g key={`m${c.label}`} data-part="event-box" data-events={c.markers.map((m) => m.n).join(",")}>
            <rect x={c.boxX - c.boxWidth / 2} y={top} width={c.boxWidth} height={16} rx={3} fill={color.surface} stroke={MARKER_EDGES[tone] ?? color.inkDim} strokeWidth={1} />
            <text x={c.boxX} y={top + 11.5} textAnchor="middle" fill={color.ink} style={mono(10, 600)}>
              {c.label}
            </text>
          </g>
        );
      })}

      {/* Hover targets: a native title per measured point, and nothing else. */}
      <g data-part="point-titles">
        {layout.segments.flatMap((s) =>
          s.points.map((pt) => (
            <circle key={`t${pt.at}`} data-part="point" data-at={pt.at} data-value={pt.value} cx={pt.x} cy={pt.y} r={5} fill="transparent">
              <title>{`${formatTime(pt.at)} ${DOT} ${p.formatValue(pt.value)}${pt.provisional ? " (provisional)" : ""}${pt.kind === "other" ? " (other volume)" : ""}`}</title>
            </circle>
          )),
        )}
      </g>
    </svg>
  );

  const tableId = `${id}-table`;
  const cell: CSSProperties = { padding: "3px 8px 3px 0", textAlign: "start", verticalAlign: "top", overflowWrap: "anywhere" };
  const stateOf = (pt: HistoryPoint) =>
    pt.value === null ? "? no observation" : pt.otherScope ? "↺ other volume" : pt.provisional ? "provisional" : "measured";

  return (
    <div ref={ref} style={wrap} data-part="history-chart">
      {svg}
      {captionLines.length ? <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>{captionLines}</div> : null}
      {p.showEvents !== false && markers.length ? <EventList events={markers} /> : null}
      {notes.length ? <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>{notes}</div> : null}
      <div style={{ display: "flex" }}>
        <TextButton
          label="View as table"
          iconEnd={tableOpen ? "down" : "next"}
          expanded={tableOpen}
          controls={tableId}
          onClick={() => setTableOpen((open) => !open)}
        />
      </div>
      <div id={tableId} hidden={!tableOpen} style={{ width: "100%", minWidth: 0 }}>
        {tableOpen ? (
          <table data-part="history-table" style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", font: `400 11px/1.4 ${font.mono}`, color: color.inkDim }}>
            <caption style={{ textAlign: "start", paddingBottom: 4, font: `500 11px/1.4 ${font.body}`, color: color.ink }}>{p.label}</caption>
            <thead>
              <tr style={{ color: color.inkMute, boxShadow: `inset 0 -1px 0 ${color.line}` }}>
                <th scope="col" style={cell}>Time</th>
                <th scope="col" style={cell}>{p.valueHeading ?? "Available"}</th>
                <th scope="col" style={cell}>State</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((pt) => (
                <tr key={`r${pt.at}`} data-at={pt.at} data-state={stateOf(pt)}>
                  <td style={cell}>{formatTime(pt.at)}</td>
                  <td style={cell} data-value={pt.value ?? undefined}>{pt.value === null ? "?" : p.formatValue(pt.value)}</td>
                  <td style={cell}>{stateOf(pt)}</td>
                </tr>
              ))}
              {[...markers]
                .sort((a, b) => a.n - b.n)
                .map((m) => (
                  <tr key={`e${m.n}`} data-event={m.n}>
                    <td style={cell}>{m.time ?? formatTime(m.at)}</td>
                    <td style={cell}>{"—"}</td>
                    <td style={cell}>{`event ${m.n} ${DOT} ${m.label}`}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  );
}
