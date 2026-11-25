import { useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { color, font } from "../tokens.js";
import { EdgeStroke, ownerPaint } from "./owner-paint.js";
import { OWNER_WORD, ownerCue, ownerEdge, storageRectangles, storageTargets, tileLabel, type StorageOwner } from "./storage-geometry.js";

export interface StorageMapItem {
  id: string;
  name: string;
  owner: StorageOwner;
  bytes: number;
  label: string;
  /** The "N smaller" aggregate: neutral outline, no tint and no owner cue, whatever `owner` says. */
  smaller?: boolean;
  interactive?: boolean;
}
export interface StorageMapProps {
  items: readonly StorageMapItem[];
  width: number;
  height: number;
  label: string;
  descriptionId: string;
  onOpen: (id: string) => void;
  onUp: () => void;
  /**
   * The id whose row the pointer or focus is on in the equivalent list. Its
   * tile draws the 2px focus ring, so a tile and its row read as one thing.
   */
  highlightedId?: string | null;
  /** Called with a tile's id when the pointer or focus enters it, and `null` when it leaves. */
  onHighlight?: (id: string | null) => void;
  /**
   * The map is context, not the answer: a search that matched nothing in this
   * folder. Tiles keep their edges at 40% and drop their labels; the caller
   * captions why.
   */
  muted?: boolean;
}

const LINE: CSSProperties = { display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

/**
 * One roving tab stop; the equivalent list remains the complete interaction surface.
 *
 * Ownership is tint, edge and label (#4537 D8, #4544): Brain solid, App inner
 * dotted, Operator dashed, the smaller aggregate a neutral outline. The edge
 * is drawn on every tile at any size; a tile of at least 62 × 40 also carries
 * the owner's letter (`A · Packs`) whatever its width. No hatching.
 * Unknown and nonpositive sizes have no tile. Geometry lives in
 * `storage-geometry.ts`.
 */
export function StorageMap({ items, width, height, label, descriptionId, onOpen, onUp, highlightedId, onHighlight, muted }: StorageMapProps) {
  const prefix = useId(),
    group = useRef<HTMLDivElement>(null),
    [active, setActive] = useState<string | null>(null);
  const rectangles = storageRectangles(items, width, height),
    targets = storageTargets(rectangles);
  const selected = targets.some((rect) => rect.item.id === active) ? active : targets[0]?.item.id;
  function key(event: KeyboardEvent) {
    if (event.key === "Backspace" || (event.altKey && event.key === "ArrowUp")) {
      event.preventDefault();
      onUp();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || !targets.length) return;
    event.preventDefault();
    const current = targets.findIndex((rect) => rect.item.id === selected);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
        ? targets.length - 1
        : (current + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + targets.length) % targets.length;
    const id = targets[next]!.item.id;
    setActive(id);
    group.current?.querySelector<HTMLElement>(`[data-storage-map-index="${next}"]`)?.focus();
  }
  return (
    <div
      ref={group}
      role="group"
      aria-label={label}
      aria-describedby={descriptionId}
      onKeyDown={key}
      tabIndex={targets.length ? undefined : 0}
      data-muted={muted ? "true" : undefined}
      style={{ position: "relative", width: "100%", height, fontFamily: font.body, background: color.surface, borderRadius: 4 }}
    >
      {rectangles.map((rect) => {
        const { item } = rect,
          owner = item.smaller ? null : item.owner,
          paint = ownerPaint(owner),
          target = targets.findIndex((value) => value.item.id === item.id),
          mode = muted ? "none" : tileLabel(rect.width, rect.height),
          cue = owner && mode !== "none" ? ownerCue(owner, mode) : "";
        const skin: CSSProperties = {
          position: "absolute",
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          boxSizing: "border-box",
          margin: 0,
          border: 0,
          padding: "5px 6px",
          overflow: "hidden",
          background: "transparent",
          color: color.ink,
          textAlign: "left",
          fontSize: 12,
          lineHeight: 1.35,
          borderRadius: 3,
          fontFamily: "inherit",
          display: "block",
        };
        const paintLayer = (
          <span
            aria-hidden="true"
            style={{ position: "absolute", inset: 0, borderRadius: 3, background: paint.fill, opacity: muted ? 0.4 : undefined }}
          >
            <EdgeStroke owner={owner} width={rect.width} height={rect.height} />
          </span>
        );
        const contents =
          mode !== "none" ? (
            <span style={{ position: "relative", display: "block", fontSize: 12, lineHeight: 1.35 }}>
              <span style={{ ...LINE, fontWeight: 600 }}>
                {cue ? (
                  <span data-owner-cue={cue} style={{ fontWeight: 700 }}>
                    {cue}{" "}
                  </span>
                ) : null}
                {item.name}
              </span>
              <span style={{ ...LINE, fontFamily: font.mono, fontSize: 11 }}>{item.label}</span>
              {item.smaller && rect.height >= 60 && <span style={{ ...LINE, fontSize: 10.5 }}>Open list</span>}
            </span>
          ) : null;
        const common = {
          "data-owner": owner ?? "aggregate",
          "data-edge": ownerEdge(owner).edge,
          "data-label": mode,
          "data-highlighted": highlightedId === item.id ? "true" : undefined,
          onMouseEnter: onHighlight ? () => onHighlight(item.id) : undefined,
          onMouseLeave: onHighlight ? () => onHighlight(null) : undefined,
        };
        return target >= 0 ? (
          <button
            /* raw-button: canvas — a roving proportional map tile */
            key={item.id}
            id={`${prefix}-${target}`}
            type="button"
            className="bk-storage-tile"
            data-storage-map-index={target}
            aria-label={item.smaller ? `${item.name}, ${item.label}. Open list.` : `${item.name}, ${OWNER_WORD[item.owner]}, ${item.label}`}
            tabIndex={selected === item.id ? 0 : -1}
            onFocus={() => {
              setActive(item.id);
              onHighlight?.(item.id);
            }}
            onBlur={onHighlight ? () => onHighlight(null) : undefined}
            onClick={() => onOpen(item.id)}
            style={skin}
            {...common}
          >
            {paintLayer}
            {contents}
          </button>
        ) : (
          <div key={item.id} aria-hidden="true" className="bk-storage-tile" style={skin} {...common}>
            {paintLayer}
            {contents}
          </div>
        );
      })}
    </div>
  );
}
