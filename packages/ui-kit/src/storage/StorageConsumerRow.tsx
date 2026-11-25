import { useId, type CSSProperties } from "react";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font } from "../tokens.js";
import { OwnerSwatch, ownerPaint } from "./owner-paint.js";
import {
  ELIGIBILITY_WORD,
  eligibilityCopy,
  gitFacetCopy,
  linksCopy,
  rowSizeCopy,
  rowSizeSpoken,
  type StorageEligibility,
  type StorageGitFacet,
} from "./storage-copy.js";
import { OWNER_WORD, shareFraction, type StorageOwner } from "./storage-geometry.js";

export interface StorageConsumerRowProps {
  /** A stable DOM id, e.g. for the legend's jump to the first unknown row. */
  id?: string;
  name: string;
  /** `null` is the "N smaller" aggregate: neutral swatch, no owner word. */
  owner: StorageOwner | null;
  /** `drill` (`›`) re-roots the map on a folder; `inspect` (`⋯`) opens the inspect panel. */
  action: "drill" | "inspect";
  /** What the row is, as a screen reader says it: "folder", "file", "store". */
  kind: string;
  /** Line two after the owner word, pre-formatted: "git · 1,204 files". */
  meta?: string;
  /** Pre-formatted size in the active basis, or `null` when it was not measured. */
  size: string | null;
  /** Partial coverage: `size` is a known lower bound and prints `≥`. */
  atLeast?: boolean;
  /** 0–1, relative to the largest row in view. Decorative: the size is in the name. */
  share?: number;
  /** The share as spoken, e.g. "38% of view". */
  shareLabel?: string;
  /** Why the size is unknown or partial, from `storageUnknownReason`. */
  reason?: string;
  onActivate: () => void;
  /** Its tile is under the pointer or focus: draw the 2px ring. */
  highlighted?: boolean;
  onHighlight?: (active: boolean) => void;
}

const GLYPH: Record<"drill" | "inspect", IconName> = { drill: "next", inspect: "more" };

function UnknownMark() {
  return (
    <span
      aria-hidden="true"
      data-owner-swatch="unknown"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "none",
        width: 16,
        height: 16,
        font: `700 11px/1 ${font.mono}`,
        color: color.ink,
      }}
    >
      ?
    </span>
  );
}

function ShareBar({ owner, share }: { owner: StorageOwner | null; share: number }) {
  return (
    <span aria-hidden="true" className="bk-storage-bar" style={{ background: color.line }}>
      <span style={{ display: "block", height: "100%", width: `${share * 100}%`, background: ownerPaint(owner).bar, borderRadius: 2 }} />
    </span>
  );
}

const NAME: CSSProperties = { font: `600 12.5px/1.3 ${font.body}`, color: color.ink };
const META: CSSProperties = { font: `400 10.5px/1.35 ${font.mono}`, color: color.inkMute };

/**
 * One row of the breakdown list: swatch, name, owner and meta, share bar,
 * size, and one trailing affordance. The whole row is one button; `›` drills
 * into a folder and `⋯` inspects a file (#4544 Q3). There is no per-row
 * Open: it lives in the inspect panel and the breadcrumb's menu.
 *
 * With `size: null` it is the unknown row: a dashed border, `?` in place of
 * the swatch, `? not measured` in place of the size, the reason on line two,
 * and no share bar, so an unknown never draws as 0 B or an empty bar.
 */
export function StorageConsumerRow(p: StorageConsumerRowProps) {
  const metaId = useId();
  const unknown = p.size === null;
  const share = unknown ? 0 : shareFraction(p.share);
  const ownerWord = p.owner ? OWNER_WORD[p.owner] : null;
  const meta = [ownerWord, p.meta, p.reason].filter(Boolean).join(" · ");
  const spoken = [
    p.name,
    ownerWord,
    p.kind,
    rowSizeSpoken(p.size, p.atLeast),
    unknown ? null : p.shareLabel,
    p.reason,
    p.action === "inspect" ? "inspect" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div
      role="row"
      id={p.id}
      className="bk-storage-row"
      data-owner={p.owner ?? "aggregate"}
      data-unknown={unknown ? "true" : undefined}
      data-highlighted={p.highlighted ? "true" : undefined}
    >
      <div role="cell" aria-colspan={2} className="bk-storage-cell">
        <button
          /* raw-button: row — the whole breakdown row is one drill or inspect target */
          type="button"
          className="bk-storage-row-main"
          aria-label={spoken}
          aria-describedby={p.meta ? metaId : undefined}
          data-action={p.action}
          onClick={p.onActivate}
          onMouseEnter={p.onHighlight ? () => p.onHighlight!(true) : undefined}
          onMouseLeave={p.onHighlight ? () => p.onHighlight!(false) : undefined}
          onFocus={p.onHighlight ? () => p.onHighlight!(true) : undefined}
          onBlur={p.onHighlight ? () => p.onHighlight!(false) : undefined}
        >
          <span className="bk-storage-lead">
            {unknown ? <UnknownMark /> : <OwnerSwatch owner={p.owner} size={16} />}
            <span className="bk-storage-text">
              <span className="bk-storage-name" style={NAME}>
                {p.name}
              </span>
              {meta ? (
                <span className="bk-storage-meta" style={META}>
                  {meta}
                </span>
              ) : null}
              {p.meta ? (
                <span id={metaId} hidden>
                  {p.meta}
                </span>
              ) : null}
            </span>
          </span>
          <span className="bk-storage-tail">
            {unknown ? null : <ShareBar owner={p.owner} share={share} />}
            <span className="bk-storage-size" data-size={unknown ? "unknown" : p.atLeast ? "at-least" : "known"} style={{ font: `500 11.5px/1.3 ${font.mono}`, color: color.ink }}>
              {rowSizeCopy(p.size, p.atLeast)}
            </span>
            <span aria-hidden="true" className="bk-storage-glyph" data-glyph={p.action} style={{ color: color.inkDim }}>
              <Icon icon={GLYPH[p.action]} size={16} />
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}

export interface StorageFilterRowProps {
  id?: string;
  name: string;
  /** The containing folder, pre-formatted: "Models/". */
  folder: string;
  size: string | null;
  atLeast?: boolean;
  git: StorageGitFacet;
  /** Known link count, or `null` when references are unknown. */
  links: number | null;
  eligibility: StorageEligibility;
  /** The reason after the eligibility word: "tracked by Git". */
  why?: string;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  /** The content half of the row inspects the file. */
  onInspect: () => void;
}

const ELIGIBILITY: Record<StorageEligibility, { icon: IconName; ink: string }> = {
  "can-remove": { icon: "finished", ink: accent.teal.ink },
  check: { icon: "attention", ink: accent.gold.ink },
  kept: { icon: "unreachable", ink: accent.neutral.ink },
  "cant-tell": { icon: "unverified", ink: accent.neutral.ink },
};

/**
 * A Find large files row (#4537 D11): a real checkbox and the inspect button
 * as two sibling cells, so neither control is inside the other. Space on the
 * checkbox toggles; Enter on the content inspects.
 *
 * Line one is name and size, line two folder, Git facet and link evidence,
 * line three the eligibility glyph and word; from 640px of list width the
 * three collapse into one row of columns. A `Kept` row keeps its checkbox,
 * `aria-disabled` with the reason as its description, so it is still
 * announced and still says why.
 */
export function StorageFilterRow(p: StorageFilterRowProps) {
  const base = useId();
  const eligibilityId = `${base}-eligibility`,
    factsId = `${base}-facts`;
  const kept = p.eligibility === "kept";
  const mark = ELIGIBILITY[p.eligibility];
  const sizeSpoken = rowSizeSpoken(p.size, p.atLeast);
  return (
    <div role="row" id={p.id} className="bk-storage-row bk-storage-filter" data-eligibility={p.eligibility} data-selected={p.selected ? "true" : undefined}>
      <div role="cell" className="bk-storage-cell bk-storage-check-cell">
        <label className="bk-storage-check">
          <input
            type="checkbox"
            checked={p.selected && !kept}
            aria-disabled={kept ? "true" : undefined}
            aria-label={`Select ${p.name}, ${sizeSpoken}, ${ELIGIBILITY_WORD[p.eligibility]}`}
            aria-describedby={eligibilityId}
            onClick={kept ? (event) => event.preventDefault() : undefined}
            onChange={kept ? () => undefined : (event) => p.onSelectedChange(event.target.checked)}
          />
        </label>
      </div>
      <div role="cell" aria-colspan={2} className="bk-storage-cell">
        <button
          /* raw-button: row — the content half of a filter row inspects its file */
          type="button"
          className="bk-storage-row-main bk-storage-filter-main"
          aria-label={`${p.name}, ${sizeSpoken}, inspect`}
          aria-describedby={`${factsId} ${eligibilityId}`}
          onClick={p.onInspect}
        >
          <span className="bk-storage-name bk-storage-f-name" style={NAME}>
            {p.name}
          </span>
          <span className="bk-storage-size bk-storage-f-size" data-size={p.size === null ? "unknown" : p.atLeast ? "at-least" : "known"} style={{ font: `500 11.5px/1.3 ${font.mono}`, color: color.ink }}>
            {p.size === null ? "? size" : rowSizeCopy(p.size, p.atLeast)}
          </span>
          <span id={factsId} className="bk-storage-facts" style={META}>
            <span className="bk-storage-f-folder">{p.folder}</span>
            <span className="bk-storage-sep" aria-hidden="true">
              {" · "}
            </span>
            <span className="bk-storage-f-git">{gitFacetCopy(p.git)}</span>
            <span className="bk-storage-sep" aria-hidden="true">
              {" · "}
            </span>
            <span className="bk-storage-f-links">{linksCopy(p.links)}</span>
          </span>
          <span id={eligibilityId} className="bk-storage-f-elig" style={{ font: `500 11.5px/1.3 ${font.body}`, color: color.ink }}>
            <span aria-hidden="true" data-eligibility-glyph={mark.icon} style={{ display: "inline-flex", color: mark.ink, verticalAlign: "-2px", marginRight: 4 }}>
              <Icon icon={mark.icon} size={13} />
            </span>
            {eligibilityCopy(p.eligibility, p.why)}
          </span>
        </button>
      </div>
    </div>
  );
}
