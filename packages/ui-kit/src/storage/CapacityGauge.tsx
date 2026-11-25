import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { Icon } from "../primitives/Icon.js";
import { warnOnce } from "../internal/dev.js";
import { accent, color, font } from "../tokens.js";
import {
  capacitySegments,
  percentLabel,
  thresholdsValid,
  tickLayout,
  type CapacityFigures,
  type CapacitySegmentKind,
  type CapacityThresholds,
} from "./capacity-geometry.js";

/**
 * One volume's capacity as a track: used → reserved → available, against
 * total, with the Low and Very low threshold ticks (#4542, epic #4537 D5).
 *
 * The segments carry pattern as well as colour: used is solid neutral,
 * reserved is hatched (it is free on disk, but the caller can't write it),
 * and available takes the status tone. The two ticks differ by shape: Low is
 * one rule, Very low a pair of rules. A greyscale capture still tells all
 * five apart.
 *
 * **An unknown is a mark, never a bar.** With no `capacity`, or figures that
 * don't add up, the gauge draws no track and no segment at all. A text mark
 * takes its place: "Capacity not measured · {reason}".
 *
 * **Accessibility.** A measured gauge is `role="meter"`, valued in bytes, with
 * `aria-valuetext` "{available} available of {total}". Its description is a
 * visually hidden sentence naming both thresholds in bytes and percent, so
 * they stay readable however narrow the track is. The visible caption repeats
 * them for sighted readers and is hidden from the accessibility tree.
 *
 * Presentational: the caller supplies the figures, the thresholds (the
 * ui-sdk pressure-policy constants) and a byte formatter. The gauge derives
 * nothing about the volume's status; `level` only picks the available tone.
 */
export type CapacityLevel = "ok" | "low" | "very-low";

export interface CapacityGaugeProps {
  /** The volume's figures in bytes. Omit when capacity wasn't measured. */
  capacity?: CapacityFigures;
  /** Why capacity is unknown, e.g. "statfs unavailable". Printed after the mark. */
  unknownReason?: string;
  /** Low and Very low, as fractions of total. Ticks sit at `1 − fraction`. */
  thresholds: CapacityThresholds;
  /** Bytes to display text, e.g. decimal GB to three significant figures. */
  format: (bytes: number) => string;
  /** Picks the available segment's tone. Defaults to `ok`. */
  level?: CapacityLevel;
  /** The figures are out of date: the track gets a dashed border. */
  stale?: boolean;
  /** The meter's accessible name. */
  label?: string;
}

const LEVEL_FILL: Record<CapacityLevel, string> = {
  ok: accent.teal.fill,
  low: accent.gold.fill,
  "very-low": accent.red.fill,
};

const TRACK_PX = 8;
/** A tick reaches past the track by this much, above and below. */
const TICK_REACH_PX = 3;

function segmentPaint(kind: CapacitySegmentKind, level: CapacityLevel): string {
  if (kind === "used") return accent.neutral.fill;
  if (kind === "available") return LEVEL_FILL[level];
  // Reserved: hatched, so it never reads as a third solid colour.
  return `repeating-linear-gradient(135deg, ${accent.neutral.fill} 0 1.5px, ${color.line} 1.5px 4px)`;
}

/** The rule a tick is drawn with: ink, with a 1px ground halo so it reads on
 * every segment fill. */
const rule: CSSProperties = {
  position: "absolute",
  top: 0,
  width: 1,
  height: "100%",
  background: color.ink,
  boxShadow: `0 0 0 1px ${color.surface}`,
};

/** A tick at `fraction` of the track: one rule, or a pair 2px apart. */
function Tick({ at, kind }: { at: number; kind: "low" | "very-low" | "both" }) {
  const pair = kind !== "low";
  const box: CSSProperties = {
    position: "absolute",
    top: -TICK_REACH_PX,
    height: TRACK_PX + TICK_REACH_PX * 2,
    width: pair ? 4 : 1,
    left: `calc(${at * 100}% - ${pair ? 2 : 0.5}px)`,
    pointerEvents: "none",
  };
  return (
    <span data-tick={kind} style={box}>
      <span style={{ ...rule, left: 0 }} />
      {pair ? <span style={{ ...rule, left: 3 }} /> : null}
    </span>
  );
}

/** The caption's key: the same shape as the tick it labels. */
function TickKey({ pair }: { pair: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        flex: "none",
        width: pair ? 4 : 1,
        height: 9,
        marginRight: 4,
        boxSizing: "border-box",
        borderLeft: `1px solid ${color.inkDim}`,
        borderRight: pair ? `1px solid ${color.inkDim}` : undefined,
      }}
    />
  );
}

/** The track's measured width, or null before layout (and with no layout engine). */
function useWidth(present: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(el.getBoundingClientRect().width || null);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [present]);
  return [ref, width] as const;
}

const caption: CSSProperties = {
  font: `400 11px/14px ${font.mono}`,
  color: color.inkMute,
};

export function CapacityGauge(p: CapacityGaugeProps) {
  const descriptionId = useId();
  const level = p.level ?? "ok";
  const segments = p.capacity ? capacitySegments(p.capacity) : null;
  const [trackRef, width] = useWidth(segments !== null);

  if (!p.capacity || !segments) {
    const reason = p.capacity
      ? `Capacity not shown · figures inconsistent`
      : `Capacity not measured${p.unknownReason ? ` · ${p.unknownReason}` : ""}`;
    return (
      <p
        data-capacity-unknown=""
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 6,
          margin: 0,
          width: "100%",
          font: `400 12px/16px ${font.body}`,
          color: color.inkDim,
          overflowWrap: "anywhere",
        }}
      >
        <span aria-hidden="true" style={{ display: "inline-flex", paddingTop: 2 }}>
          <Icon icon="unverified" size={12} />
        </span>
        <span>{reason}</span>
      </p>
    );
  }

  const { total, available } = p.capacity;
  const validThresholds = thresholdsValid(p.thresholds);
  if (!validThresholds) warnOnce(`CapacityGauge: thresholds must satisfy 0 < veryLow < low < 1; no ticks drawn.`);
  const lowLabel = `Low ${percentLabel(p.thresholds.low)}`;
  const veryLowLabel = `Very low ${percentLabel(p.thresholds.veryLow)}`;
  const ticks = validThresholds ? tickLayout(width, p.thresholds, { low: lowLabel, veryLow: veryLowLabel }) : null;
  const description = validThresholds
    ? `Low below ${p.format(total * p.thresholds.low)} (${percentLabel(p.thresholds.low)}), ` +
      `very low below ${p.format(total * p.thresholds.veryLow)} (${percentLabel(p.thresholds.veryLow)})`
    : null;

  const track: CSSProperties = {
    position: "relative",
    height: TRACK_PX,
    width: "100%",
    // The tick reach sits inside the gauge's own box, so nothing above or
    // below the gauge has to leave room for it.
    margin: `${TICK_REACH_PX}px 0`,
    borderRadius: 2,
    background: color.line,
    outline: p.stale ? `1px dashed ${color.inkMute}` : undefined,
    outlineOffset: p.stale ? 1 : undefined,
  };

  return (
    <div data-capacity-gauge="" style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%", minWidth: 0 }}>
      <div
        ref={trackRef}
        role="meter"
        aria-label={p.label ?? "Available space"}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={available}
        aria-valuetext={`${p.format(available)} available of ${p.format(total)}`}
        aria-describedby={description ? descriptionId : undefined}
        data-stale={p.stale ? "" : undefined}
        style={track}
      >
        <span style={{ display: "flex", width: "100%", height: "100%", borderRadius: 2, overflow: "hidden" }}>
          {segments.map((s, i) => (
            <span
              key={s.kind}
              data-segment={s.kind}
              style={{
                display: "block",
                flex: "none",
                boxSizing: "border-box",
                width: `${s.size * 100}%`,
                height: "100%",
                background: segmentPaint(s.kind, level),
                // A 1px ground seam between segments, so two solid fills of
                // similar lightness still read as two in greyscale.
                borderLeft: i > 0 ? `1px solid ${color.surface}` : undefined,
              }}
            />
          ))}
        </span>
        {ticks ? (
          ticks.collapsed ? (
            <Tick kind="both" at={(ticks.low + ticks.veryLow) / 2} />
          ) : (
            <>
              <Tick kind="low" at={ticks.low} />
              <Tick kind="very-low" at={ticks.veryLow} />
            </>
          )
        ) : null}
      </div>
      {ticks ? (
        ticks.split ? (
          <div aria-hidden="true" data-threshold-caption="split" style={{ ...caption, position: "relative", height: 14 }}>
            <span style={{ position: "absolute", right: `${(1 - ticks.low) * 100}%`, display: "inline-flex", alignItems: "center", paddingRight: 4, whiteSpace: "nowrap" }}>
              <TickKey pair={false} />
              {lowLabel}
            </span>
            <span style={{ position: "absolute", left: `${ticks.veryLow * 100}%`, display: "inline-flex", alignItems: "center", paddingLeft: 4, whiteSpace: "nowrap" }}>
              <TickKey pair />
              {veryLowLabel}
            </span>
          </div>
        ) : (
          <div
            aria-hidden="true"
            data-threshold-caption="merged"
            style={{ ...caption, display: "flex", flexWrap: "wrap", justifyContent: "flex-end", columnGap: 6 }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", whiteSpace: "nowrap" }}>
              <TickKey pair={false} />
              {lowLabel}
              <span style={{ marginLeft: 6 }}>·</span>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", whiteSpace: "nowrap" }}>
              <TickKey pair />
              {veryLowLabel}
            </span>
          </div>
        )
      ) : null}
      {description ? (
        <span id={descriptionId} className="bk-sr-only">
          {description}
        </span>
      ) : null}
    </div>
  );
}
