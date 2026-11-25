import { useId, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { Chip } from "../primitives/Chip.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { edgeFor, focusEdge, focusSibling } from "../internal/roving.js";
import { color, font, token } from "../tokens.js";
import type { Tone } from "../types.js";
import { CapacityGauge, type CapacityLevel } from "./CapacityGauge.js";
import type { CapacityFigures, CapacityThresholds } from "./capacity-geometry.js";

/**
 * One capacity scope as a card: name, status, the available figure, the
 * gauge, Trend and Runway, and the stores that write to it (#4542, epic
 * #4537 D3/D5/D7). The approved design is the brief on #4542 and the
 * maintainer's 2026-11-25 decisions.
 *
 * ## Status reads without colour
 *
 * The chip says the status in a word, and every status that asks something
 * of the reader adds a glyph from the kit's cue vocabulary (`tone-cue.ts`,
 * #309): Low `fyi`, Very low `failed`, Not measured `unverified`. OK is
 * the unmarked state and carries its word alone. The three glyphs have
 * distinct silhouettes, so they survive greyscale.
 *
 * ## Selection
 *
 * A card with `onSelect` is a `radio` (the group around it is
 * {@link VolumeGroup}'s `radiogroup`). The radio is a transparent layer over
 * the whole card rather than the card itself. A `radio`'s children are
 * presentational, so a card that was the radio would hide the gauge's
 * `meter` and nest the stores button inside another control. The layer is
 * named by the volume and described by the status and headline. It takes
 * the kit's control focus ring, 2px outside the card's edge, so focus never
 * looks like selection.
 *
 * Selection has three cues, none of them colour: the radio mark (filled
 * ring or empty), a 2px edge for the 1px one, and, when the cards sit side by
 * side above the chart, a notch on the bottom edge pointing at it.
 *
 * There is no link to Free up space on the card. The banner's single link
 * covers it (D4), and a link inside a selectable card would make a click
 * ambiguous between selecting and leaving.
 *
 * ## Stores
 *
 * The stores line ellipsises. With more than one store it is a disclosure
 * button that shows the full list. It is the card's only control besides
 * the radio. In a selectable card it is a tab stop only while the card is
 * selected, so Tab still enters the group once, at the selected card.
 * Clicking it also selects its card, so it never opens one card's detail
 * while another card drives the chart.
 */
export type VolumeStatus = "ok" | "low" | "very-low" | "not-measured";

export interface VolumeCardProps {
  /** Named from the volume's contents by the caller (D7), e.g. "Data volume". */
  name: string;
  status: VolumeStatus;
  /** The figures in bytes. Omit when capacity wasn't measured. */
  capacity?: CapacityFigures;
  /** Why capacity wasn't measured, e.g. "statfs unavailable". */
  unknownReason?: string;
  /**
   * The scope couldn't be identified. This is the event that says so, e.g.
   * "Write refused 12 Jul 14:02". The card then shows no headline, no gauge
   * and no Trend or Runway.
   */
  unidentified?: string;
  thresholds: CapacityThresholds;
  format: (bytes: number) => string;
  /** Pre-formatted, e.g. "−1.2 GB/day", "unknown". Omit to drop the row. */
  trend?: string;
  /** Pre-formatted, e.g. "~14 days", "not projected · growth flat". */
  runway?: string;
  /** Store labels that write to this volume. */
  stores?: readonly string[];
  /** The figures are out of date (the caller's verdict). */
  stale?: boolean;
  /** When the figures were taken, e.g. "Measured 3 h ago". Shown when stale. */
  measured?: string;
  /** When the scope changed, e.g. "12 Jul 09:10". */
  scopeChanged?: string;
  selected?: boolean;
  /** Makes the card a selectable radio. */
  onSelect?: () => void;
  /**
   * Whether the radio is a tab stop. {@link VolumeGroup} sets it for its
   * roving tabindex; a card on its own is always one.
   */
  tabStop?: boolean;
}

interface StatusSkin {
  label: string;
  tone: Tone;
  icon?: IconName;
  level: CapacityLevel;
}

/** The glyphs are `VALUE_CUE`'s, by meaning: gold watch-it is `fyi`, red bad
 * is `failed`, and an unknown is `unverified`. */
const STATUS: Record<VolumeStatus, StatusSkin> = {
  ok: { label: "OK", tone: "neutral", level: "ok" },
  low: { label: "Low", tone: "gold", icon: "fyi", level: "low" },
  "very-low": { label: "Very low", tone: "red", icon: "failed", level: "very-low" },
  "not-measured": { label: "Not measured", tone: "neutral", icon: "unverified", level: "ok" },
};

/** The radio mark: a ring, filled when selected. Geometry, not a glyph. */
function RadioMark({ on }: { on: boolean }) {
  return (
    <svg aria-hidden="true" width={14} height={14} viewBox="0 0 14 14" style={{ flex: "none", display: "block" }}>
      <circle cx={7} cy={7} r={6} fill="none" stroke={on ? color.ink : color.inkMute} strokeWidth={1.5} />
      {on ? <circle cx={7} cy={7} r={3.25} fill={color.ink} /> : null}
    </svg>
  );
}

function Note({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <p
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        margin: 0,
        font: `400 12px/16px ${font.body}`,
        color: color.inkDim,
        overflowWrap: "anywhere",
      }}
    >
      <span aria-hidden="true" style={{ display: "inline-flex", paddingTop: 2, flex: "none" }}>
        <Icon icon={icon} size={12} />
      </span>
      <span>{children}</span>
    </p>
  );
}

const factKey: CSSProperties = { font: `400 11px/16px ${font.mono}`, color: color.inkMute };
const factValue: CSSProperties = { margin: 0, font: `500 11px/16px ${font.mono}`, color: color.ink, overflowWrap: "anywhere", minWidth: 0 };

function Stores({ stores, listId, tabStop, onOpen }: { stores: readonly string[]; listId: string; tabStop: boolean; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const count = `${stores.length} ${stores.length === 1 ? "store" : "stores"}`;
  const line: CSSProperties = { font: `400 12px/16px ${font.body}`, color: color.inkDim, minWidth: 0 };
  if (stores.length < 2) {
    return stores.length ? <p style={{ ...line, margin: 0, overflowWrap: "anywhere" }}>{stores[0]}</p> : null;
  }
  return (
    <div style={{ position: "relative", zIndex: 2, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <button
        /* raw-button: a disclosure inside a selectable card; Button's block
         * paint would turn one quiet line into a second primary control */
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        tabIndex={tabStop ? 0 : -1}
        onClick={() => {
          onOpen?.();
          setOpen((v) => !v);
        }}
        className="bk-control bk-hit"
        style={{
          ...line,
          display: "flex",
          alignItems: "center",
          gap: 4,
          width: "100%",
          // 24px of paint, so the coarse-pointer reach is 10px a side: half
          // the 20px to the next card's edge (12px padding plus the 8px gap).
          minHeight: 24,
          padding: 0,
          border: "none",
          borderRadius: 4,
          background: "transparent",
          textAlign: "start",
          cursor: "pointer",
          ...({
            "--hv-bg": token("hover-veil-firm"),
            "--hv-bd": "transparent",
            "--hv-fg": color.ink,
          } as CSSProperties),
        }}
      >
        <span style={{ flex: "none", color: color.ink }}>{count}</span>
        <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {` · ${stores.join(", ")}`}
        </span>
        <span aria-hidden="true" style={{ display: "inline-flex", flex: "none" }}>
          <Icon icon={open ? "collapse" : "next"} size={12} />
        </span>
      </button>
      <ul id={listId} hidden={!open} style={{ margin: 0, padding: "0 0 0 14px", font: `400 12px/18px ${font.body}`, color: color.inkDim, overflowWrap: "anywhere" }}>
        {stores.map((store, i) => (
          <li key={`${store}-${i}`}>{store}</li>
        ))}
      </ul>
    </div>
  );
}

export function VolumeCard(p: VolumeCardProps) {
  const id = useId();
  const nameId = `${id}-name`;
  const descriptionId = `${id}-description`;
  const skin = STATUS[p.status] ?? STATUS["not-measured"];
  const selectable = Boolean(p.onSelect);
  const selected = Boolean(p.selected);
  const identified = !p.unidentified;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      p.onSelect?.();
    }
  }

  const card: CSSProperties = {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    padding: "12px 14px",
    borderRadius: 10,
    background: color.surface,
    border: `1px solid ${selected ? color.ink : color.edge}`,
    // The second pixel of the selected edge is a shadow, so selecting a card
    // never moves its contents.
    boxShadow: selected ? `inset 0 0 0 1px ${color.ink}` : undefined,
    fontFamily: font.body,
    color: color.ink,
  };

  const notes: Array<[string, IconName, string]> = [];
  if (p.unidentified) notes.push(["unidentified", "unverified", `${p.unidentified} · couldn't tell which volume`]);
  if (p.stale) notes.push(["stale", "later", p.measured ? `${p.measured} · out of date` : "Out of date"]);
  if (p.scopeChanged) notes.push(["scope", "history", `Scope changed ${p.scopeChanged} · earlier history is a different volume`]);

  const figure = p.capacity ? p.format(p.capacity.available) : "?";
  const ofTotal = p.capacity ? `available of ${p.format(p.capacity.total)}` : "available · capacity not reported";
  const facts = identified ? ([["Trend", p.trend], ["Runway", p.runway]] as const).filter(([, v]) => v !== undefined) : [];
  // The radio's description, spelled out once rather than computed from the
  // visible spans: flex items carry no whitespace between them, so a
  // description built from the DOM would read "16.4 GBavailable".
  const description = [skin.label, identified ? `${figure} ${ofTotal}` : null, ...notes.map(([, , text]) => text)]
    .filter(Boolean)
    .join(", ");

  return (
    <div data-volume-card="" data-selected={selectable ? String(selected) : undefined} style={card}>
      {selectable ? (
        <div
          role="radio"
          aria-checked={selected}
          aria-labelledby={nameId}
          aria-describedby={descriptionId}
          title={p.name}
          data-volume-radio=""
          className="bk-control"
          tabIndex={p.tabStop === false ? -1 : 0}
          onClick={p.onSelect}
          onKeyDown={onKeyDown}
          style={{
            position: "absolute",
            inset: -1,
            zIndex: 1,
            borderRadius: 10,
            cursor: "pointer",
            ...({ "--hv-bg": token("hover-veil-firm"), "--hv-bd": "transparent", "--hv-fg": color.ink } as CSSProperties),
          }}
        />
      ) : null}

      <div style={{ display: "flex", alignItems: "flex-start", flexWrap: "wrap", columnGap: 8, rowGap: 6 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flex: "1 1 140px", minWidth: 0 }}>
          {selectable ? (
            <span style={{ paddingTop: 2 }}>
              <RadioMark on={selected} />
            </span>
          ) : null}
          <span
            id={nameId}
            data-volume-name=""
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              font: `600 14px/18px ${font.body}`,
              overflowWrap: "anywhere",
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2,
              overflow: "hidden",
            }}
          >
            {p.name}
          </span>
        </div>
        <span data-volume-status="" style={{ display: "inline-flex", alignItems: "center", gap: 4, flex: "none", marginLeft: "auto" }}>
          {p.stale ? (
            <span aria-hidden="true" style={{ display: "inline-flex", color: color.inkDim }}>
              <Icon icon="later" size={12} />
            </span>
          ) : null}
          <Chip label={skin.label} tone={skin.tone} icon={skin.icon} />
        </span>
      </div>

      {identified ? (
        <p style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 6, margin: 0, minWidth: 0 }}>
          <span style={{ font: `600 22px/26px ${font.body}`, whiteSpace: "nowrap" }}>{figure}</span>
          <span style={{ font: `400 13px/18px ${font.body}`, color: color.inkDim }}>{ofTotal}</span>
        </p>
      ) : null}

      {identified ? (
        <CapacityGauge
          capacity={p.capacity}
          unknownReason={p.unknownReason}
          thresholds={p.thresholds}
          format={p.format}
          level={skin.level}
          stale={p.stale}
          label={`Available space on ${p.name}`}
        />
      ) : null}

      {notes.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {notes.map(([key, icon, text]) => (
            <Note key={key} icon={icon}>
              {text}
            </Note>
          ))}
        </div>
      ) : null}

      {facts.length ? (
        <dl style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", columnGap: 12, rowGap: 2, margin: 0 }}>
          {facts.map(([key, value]) => (
            <div key={key} style={{ display: "contents" }}>
              <dt style={factKey}>{key}</dt>
              <dd style={factValue}>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {identified && p.stores?.length ? (
        <Stores stores={p.stores} listId={`${id}-stores`} tabStop={!selectable || selected} onOpen={p.onSelect} />
      ) : null}

      {selectable ? (
        <span id={descriptionId} hidden>
          {description}
        </span>
      ) : null}
      {selectable && selected ? <span aria-hidden="true" className="bk-volume-notch" /> : null}
    </div>
  );
}

/** One card of a {@link VolumeGroup}, without the selection props the group owns. */
export interface VolumeGroupItem extends Omit<VolumeCardProps, "selected" | "onSelect" | "tabStop" | "thresholds" | "format"> {
  id: string;
}

export interface VolumeGroupProps {
  volumes: readonly VolumeGroupItem[];
  /** The selected volume's id. */
  selected?: string;
  onSelect: (id: string) => void;
  thresholds: CapacityThresholds;
  format: (bytes: number) => string;
  /** The group's accessible name. */
  label?: string;
}

/**
 * The volume cards as one `radiogroup` with a roving tabindex: Tab enters at
 * the selected card and then leaves the group, and the arrow keys (with
 * Home and End) move the selection, wrapping at both ends. Enter and Space
 * select too.
 *
 * The cards sit in a grid, `auto-fit, minmax(260px, 1fr)` (#4549's ruling),
 * capped at the container's width so a narrow container never scrolls
 * sideways. That gives one to three cards a row on desktop and one column on
 * a phone, gap 12 and 8. Capacities are never added together, so the group
 * draws no total.
 *
 * The tab stop is the selected card, or the first card when none is
 * selected, and nothing else. It does not use `useRoving`'s memory of the
 * radio focused last. Here selection follows focus, so the two agree for
 * the arrow keys. But the selection also moves without focus: through a
 * card's stores button, or from the caller (`selected` is a prop). Then the
 * remembered radio would keep the stop while another one was checked, and
 * Tab would enter the group at an unchecked card.
 */
export function VolumeGroup(p: VolumeGroupProps) {
  const selectedIndex = p.volumes.findIndex((v) => v.id === p.selected);
  const stop = selectedIndex >= 0 ? selectedIndex : 0;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const from = event.target as HTMLElement;
    if (from.getAttribute("role") !== "radio") return;
    const edge = edgeFor(event.key);
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!edge && delta === 0) return;
    event.preventDefault();
    const RADIO = '[role="radio"]';
    const GROUP = '[role="radiogroup"]';
    const next = edge ? focusEdge(from, edge, RADIO, GROUP) : focusSibling(from, delta, RADIO, GROUP);
    // Selection follows focus, as a radio group's does. Driven off the
    // element, as FilterRow is.
    next?.click();
  }

  return (
    <div className="bk-volume-group">
      <div role="radiogroup" aria-label={p.label ?? "Volumes"} className="bk-volume-grid" onKeyDown={onKeyDown}>
        {p.volumes.map((volume, i) => {
          const { id, ...card } = volume;
          return (
            <div key={id} data-volume-id={id} style={{ display: "flex", minWidth: 0 }}>
              <VolumeCard
                {...card}
                thresholds={p.thresholds}
                format={p.format}
                selected={id === p.selected}
                onSelect={() => p.onSelect(id)}
                tabStop={i === stop}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
