import { useId, useState, type CSSProperties } from "react";

import { Icon } from "../primitives/Icon.js";
import { accent, color, font } from "../tokens.js";
import { Disclosure } from "./Disclosure.js";
import { MapView, type MapCluster, type MapLand, type MapPath } from "./MapView.js";

/**
 * Several named places in an answer: one map, two, or none, and ALWAYS the
 * list (#44).
 *
 * **The list is the record; the map illustrates it.** Every place the answer
 * names is a numbered row, in the order given, whatever the map could fit: a
 * place with no position, a place merged into a cluster and a place too far
 * away to share a frame are all rows that say so. Nothing here truncates a
 * name, and nothing here is dropped.
 *
 * Presentation only, like `MapView`: the plan (which mode, which frames, why)
 * and the geometry arrive as data. `@schlessera/brain-ui-sdk`'s `planPlaces`
 * makes the plan and the app fetches geometry per frame; a story hands both
 * in literally. The kit fetches nothing.
 *
 * **Positions are the brain's claim, and the card says so** once, above the
 * credit: the coastline under a pin is real, which says nothing about whether
 * the pin is. A row states what its position rests on: the digits it was given
 * with, an accuracy only if a source stated one, and the source.
 */
export interface PlaceListRow {
  /** 1-based, the answer's own order. */
  n: number;
  label: string;
  meta?: string;
  source?: string;
  coord?: string;
  precision?: string;
  accuracy?: string;
  pinned: boolean;
  unpinnedWhy?: string;
}

export interface PlaceListProps {
  rows: PlaceListRow[];
  /** Rows past this many sit behind a disclosure that names the total. Default 8. */
  collapseAfter?: number;
  /**
   * Seeds the disclosure; see `Disclosure` for the controlled mode. Default
   * open: the kit cannot see the viewport, and a static render (a shared
   * page, a print) must never hide a row behind a control nobody can press.
   * The design collapses it below 480px of viewport, which the container
   * knows and passes in.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * What the drawing did to each row, by `n`: `in A` for a lettered cluster,
   * `drawn with 1` for a pin merged under another's label. Only the drawing
   * knows, at the width it was drawn, so it comes from `MapView.onClusters`.
   */
  drawn?: Record<number, string>;
  id?: string;
}

export interface PlaceMapFrame {
  pins: { n: number; lat: number; lon: number }[];
  height: number;
  spanKm?: number;
  /** A lone pin's stated accuracy, drawn as the kit's ring. */
  accuracyM?: number;
  /** Roughly the ground the frame shows across, for its accessible name. */
  acrossKm?: number;
  /** `1–3 · Vathy`, under a frame in a pair. */
  caption?: string;
  /**
   * `"pending"` draws the graticule, the pins and the scale bar, all of which
   * need no geometry. `"none"` is an answer: the frame collapses to one line
   * and the list carries the places. Geometry with nothing in it is `"none"`.
   */
  geometry: "pending" | "none" | { paths: MapPath[]; land?: MapLand; attribution?: string };
}

export interface PlaceMapProps {
  title?: string;
  rows: PlaceListRow[];
  mode: "map" | "pair" | "list";
  /** Why there is no single map: `Too far apart for one map · 508 km between them`. */
  reason?: string;
  frames: PlaceMapFrame[];
  /** Names beside the pins (all of them), or numbered badges (all of them). */
  onMapLabels?: boolean;
  /** Seeds the list's disclosure; see `PlaceListProps.open`. */
  listOpen?: boolean;
}

/** The statement the card makes about every position it draws. */
export const PLACE_MAP_POSITIONS_LINE = "Positions as given by the brain · the map does not check them";

/** What a frame says instead of drawing, when there is no geometry to draw. */
export const PLACE_MAP_NO_GEOMETRY = "No map for this area · places listed below";

const BADGE = 18;

const mono = (size: number, weight = 500): string => `${weight} ${size}px/1.45 ${font.mono}`;

/** `1 to 3, 5`: the numbers a frame or a merge holds, for a sentence. */
function spoken(ns: number[]): string {
  const sorted = [...ns].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    runs.push(i === j ? `${sorted[i]}` : j === i + 1 ? `${sorted[i]} and ${sorted[j]}` : `${sorted[i]} to ${sorted[j]}`);
    i = j + 1;
  }
  return runs.join(", ");
}

function about(km: number): string {
  if (km < 1) return `${Math.max(100, Math.round((km * 1000) / 100) * 100)} m`;
  if (km < 10) return `${Number(km.toFixed(1))} km`;
  return `${Math.round(km).toLocaleString("en-US")} km`;
}

function hasGeometry(frame: PlaceMapFrame): frame is PlaceMapFrame & { geometry: { paths: MapPath[]; land?: MapLand; attribution?: string } } {
  const g = frame.geometry;
  return typeof g === "object" && (g.paths.length > 0 || (g.land?.rings.length ?? 0) > 0);
}

const hidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

function Badge({ n, pinned }: { n: number; pinned: boolean }) {
  // Filled for a pin on the map, hollow for a place that is only a row: the
  // row's own text says why, so the outline is never the only cue.
  return (
    <span
      aria-hidden="true"
      style={{
        boxSizing: "border-box",
        flex: "none",
        minWidth: BADGE,
        height: BADGE,
        padding: "0 4px",
        borderRadius: BADGE / 2,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        font: mono(10, 700),
        lineHeight: 1,
        background: pinned ? accent.amber.fill : "transparent",
        border: pinned ? "none" : `1.5px solid ${accent.amber.ink}`,
        color: pinned ? color.onFill : accent.amber.ink,
      }}
    >
      {n}
    </span>
  );
}

function Row({ row, drawn }: { row: PlaceListRow; drawn?: string }) {
  const facts = [
    row.coord,
    row.precision,
    row.accuracy,
    row.source ? `per ${row.source}` : undefined,
    row.pinned ? drawn : row.unpinnedWhy,
  ].filter((fact): fact is string => !!fact);
  return (
    <li
      data-place={row.n}
      style={{ display: "flex", gap: 9, alignItems: "flex-start", minWidth: 0 }}
    >
      <Badge n={row.n} pinned={row.pinned} />
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 10, rowGap: 1 }}>
          <span
            style={{
              flex: "1 1 12em",
              minWidth: 0,
              font: `600 12.5px/1.35 ${font.body}`,
              color: color.ink,
              overflowWrap: "anywhere",
            }}
          >
            <span style={hidden}>{`${row.n}. `}</span>
            {row.label}
          </span>
          {row.meta ? (
            <span style={{ flex: "none", font: mono(10), color: accent.teal.ink, overflowWrap: "anywhere" }}>
              {row.meta}
            </span>
          ) : null}
        </span>
        {facts.length ? (
          <span style={{ font: mono(9.5), color: accent.neutral.ink, overflowWrap: "anywhere" }}>
            {facts.join(" · ")}
          </span>
        ) : null}
      </span>
    </li>
  );
}

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

/**
 * The list under a place map, and the text equivalent of every frame above
 * it. Past `collapseAfter` rows, the rest sit behind a disclosure whose label
 * states the total, so a collapsed list never hides that there is more.
 */
export function PlaceList(p: PlaceListProps) {
  const after = Math.max(1, Math.floor(Number(p.collapseAfter) || 8));
  const [open] = useState(() => p.open ?? true);
  const head = p.rows.slice(0, after);
  const rest = p.rows.slice(after);
  return (
    <div id={p.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <ol style={listStyle}>
        {head.map((row) => (
          <Row key={row.n} row={row} drawn={p.drawn?.[row.n]} />
        ))}
      </ol>
      {rest.length ? (
        <Disclosure
          label={`Show all ${p.rows.length} places`}
          icon="steps"
          open={p.onOpenChange ? p.open === true : open}
          onOpenChange={p.onOpenChange}
        >
          <ol start={after + 1} style={listStyle}>
            {rest.map((row) => (
              <Row key={row.n} row={row} drawn={p.drawn?.[row.n]} />
            ))}
          </ol>
        </Disclosure>
      ) : null}
    </div>
  );
}

/** The reason line, and the collapsed frame: machine fact, so mono. */
function Line({ children }: { children: string }) {
  return (
    <div data-place-line style={{ font: mono(10), color: accent.neutral.ink, overflowWrap: "anywhere" }}>
      {children}
    </div>
  );
}

export function PlaceMap(p: PlaceMapProps) {
  const listId = useId();
  const [clusters, setClusters] = useState<MapCluster[][]>([]);
  const numbered = !p.onMapLabels;
  const totalPinned = p.rows.filter((row) => row.pinned).length;
  const byN = new Map(p.rows.map((row) => [row.n, row]));

  // What each row says about the drawing. A lettered merge names every
  // member, the first included, so no count ever stands in for a name; a
  // labelled merge names the pin whose label carries the `+N`.
  const drawn: Record<number, string> = {};
  for (const frameClusters of clusters) {
    for (const cluster of frameClusters ?? []) {
      const [first, ...others] = cluster.members;
      if (numbered) for (const n of cluster.members) drawn[n] = `in ${cluster.letter}`;
      else for (const n of others) drawn[n] = `drawn with ${first}`;
    }
  }

  const drawnFrames = p.frames.filter(hasGeometry);
  const attribution = drawnFrames.find((frame) => frame.geometry.attribution)?.geometry.attribution;

  const frame = (f: PlaceMapFrame, i: number, framed: boolean) => {
    if (f.geometry === "none") return <Line>{PLACE_MAP_NO_GEOMETRY}</Line>;
    const g = hasGeometry(f) ? f.geometry : undefined;
    const letterFrom = clusters.slice(0, i).reduce((sum, c) => sum + (c?.length ?? 0), 0);
    const own = clusters[i] ?? [];
    const label =
      `Map${f.acrossKm ? `, about ${about(f.acrossKm)} across,` : ""} with ` +
      `${f.pins.length === 1 ? "place" : "places"} ${spoken(f.pins.map((pin) => pin.n))}` +
      own.map((c) => `; ${c.members.length === 1 ? "place" : "places"} ${spoken(c.members)} drawn together${numbered ? ` as ${c.letter}` : ""}`).join("");
    return (
      <MapView
        framed={framed}
        maxWidth={420}
        pins={f.pins.map((pin) => ({
          lat: pin.lat,
          lon: pin.lon,
          n: pin.n,
          label: numbered ? undefined : byN.get(pin.n)?.label,
          tone: "amber",
        }))}
        pinMode={numbered ? "number" : "label"}
        clusterPx={numbered ? 22 : 34}
        letterFrom={letterFrom}
        onClusters={(next) =>
          setClusters((current) => {
            const copy = [...current];
            copy[i] = next;
            return copy;
          })
        }
        coordChip={totalPinned === 1}
        spanKm={f.spanKm}
        accuracyM={f.accuracyM}
        height={f.height}
        paths={g?.paths ?? []}
        land={g?.land}
        // The card owns the foot row and the credit, once for every frame.
        title=""
        subtitle=""
        meta=""
        describe={{ label, describedBy: listId }}
      />
    );
  };

  const pad = "10px 12px";
  const divider = `1px solid ${color.line}`;
  const caption = p.title || `Map of ${p.rows.length} ${p.rows.length === 1 ? "place" : "places"}`;

  return (
    <figure
      data-place-map={p.mode}
      style={{
        position: "relative",
        margin: 0,
        border: divider,
        background: color.surface,
        borderRadius: 14,
        overflow: "hidden",
        boxSizing: "border-box",
        width: "100%",
        maxWidth: p.mode === "pair" ? 720 : 420,
        flex: "none",
      }}
    >
      <figcaption style={hidden}>{caption}</figcaption>
      {p.reason ? (
        <div style={{ padding: pad, borderBottom: divider }}>
          <Line>{p.reason}</Line>
        </div>
      ) : null}
      {p.mode === "map" && p.frames[0] ? (
        p.frames[0].geometry === "none" ? (
          <div style={{ padding: pad, borderBottom: divider }}>{frame(p.frames[0], 0, false)}</div>
        ) : (
          <div style={{ borderBottom: divider }}>{frame(p.frames[0], 0, false)}</div>
        )
      ) : null}
      {p.mode === "pair" ? (
        <div style={{ padding: pad, borderBottom: divider, display: "flex", flexWrap: "wrap", gap: 12 }}>
          {p.frames.map((f, i) => (
            // 274px each and a 12px gap: side by side from a 560px card up,
            // stacked below it.
            <div key={i} data-place-frame={i} style={{ flex: "1 1 274px", minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {f.geometry === "none" ? (
                <div style={{ border: divider, borderRadius: 10, padding: pad }}>{frame(f, i, false)}</div>
              ) : (
                frame(f, i, true)
              )}
              {f.caption ? <Line>{f.caption}</Line> : null}
            </div>
          ))}
        </div>
      ) : null}
      {p.title || totalPinned > 0 ? (
        <div style={{ padding: pad, borderBottom: divider, display: "flex", gap: 9, alignItems: "flex-start" }}>
          {p.title ? <Icon icon="graph" size={14} color={accent.teal.ink} /> : null}
          <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
            {p.title ? (
              <b aria-hidden="true" style={{ font: `600 12.5px/1.35 ${font.body}`, color: color.ink }}>
                {p.title}
              </b>
            ) : null}
            {totalPinned > 0 ? (
              <span data-place-positions style={{ font: mono(9.5), color: accent.neutral.ink }}>
                {PLACE_MAP_POSITIONS_LINE}
              </span>
            ) : null}
            {attribution ? (
              // The licence's credit, exactly when OpenStreetMap geometry is on
              // the card, and once however many frames carry it (map-geometry §5).
              <span data-place-credit style={{ font: `400 9px/1.3 ${font.mono}`, color: color.inkMute }}>
                {attribution}
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
      <div style={{ padding: pad }}>
        <PlaceList id={listId} rows={p.rows} drawn={drawn} open={p.listOpen} />
      </div>
    </figure>
  );
}
