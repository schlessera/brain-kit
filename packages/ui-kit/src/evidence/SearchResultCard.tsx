import type { CSSProperties, KeyboardEvent } from "react";

import { Icon, type IconName } from "../primitives/Icon.js";
import { Placeholder } from "../states/Placeholder.js";
import { accent, color, font, token } from "../tokens.js";
import type { ViewState } from "../types.js";

/**
 * A hybrid-search hit. The score is shown because the user is entitled to know
 * how confident the retrieval was; the highlight is the matched term, amber.
 *
 * The snippet arrives pre-split as `before` / `highlight` / `after` rather than
 * as a string with markup in it. That is the design's shape and it is the right
 * one: a component that took HTML would be a component that could be made to
 * render anything the corpus contains.
 *
 * `view` swaps the card for a `Placeholder` with this component's own copy —
 * "No matches / Searched 4,812 docs · try fewer words", "Search index offline"
 * with a "Re-index" affordance.
 *
 * The error variant's retry becomes a real control when the caller passes
 * `onStateAction`, and stays the label the source draws when they do not. The
 * source has no such prop — it relies on its editor to wire buttons — so this
 * is the one place this port widens the API, and it widens it in the direction
 * the design's own gating rule already points: a control with no handler is
 * not a control. `onClick` is NOT reused for it, because "open this" and "try
 * the fetch again" are different actions and a callback that means both is a
 * bug waiting for its first caller.
 */
export interface SearchResultCardProps {
  view?: ViewState;
  path?: string;
  /** The retrieval score, shown as given. */
  score?: string;
  before?: string;
  /** The matched term, drawn in a `<mark>`. */
  highlight?: string;
  after?: string;
  icon?: IconName;
  stateMessage?: string;
  stateDetail?: string;
  stateAction?: string;
  /** Makes the error state's re-index real. See the note above. */
  onStateAction?: () => void;
  onClick?: () => void;
}

export function SearchResultCard(p: SearchResultCardProps) {
  const view = p.view || "ready";
  const act = Boolean(p.onClick);

  if (view !== "ready") {
    return (
      <Placeholder
        variant={view}
        message={p.stateMessage ?? (view === "empty" ? "No matches" : view === "error" ? "Search index offline" : undefined)}
        detail={
          p.stateDetail ??
          (view === "empty"
            ? "Searched 4,812 docs · try fewer words."
            : view === "error"
              ? "Re-index was interrupted at 06:04."
              : undefined)
        }
        actionLabel={view === "error" ? (p.stateAction ?? "Re-index") : undefined}
        icon={view === "empty" ? "search" : "failed"}
        lines={2}
        radius={12}
        onAction={p.onStateAction}
      />
    );
  }

  const box: CSSProperties = {
    border: `1px solid ${color.line}`,
    background: color.surface,
    borderRadius: 12,
    padding: "10px 12px",
    boxSizing: "border-box",
    width: "100%",
    cursor: act ? "pointer" : "default",
    // A custom property is not in React's CSSProperties, so the entry is cast.
    ...({ "--hv-bg": act ? color.raised : color.surface } as CSSProperties),
  };
  const head: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 7,
    font: `500 11px/1.3 ${font.mono}`,
    color: accent.teal.ink,
  };
  const pathStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
  const scoreStyle: CSSProperties = { flex: "none", color: color.inkMute };
  const snippetStyle: CSSProperties = { marginTop: 6, font: `400 12px/1.6 ${font.body}`, color: color.inkDim };
  const markStyle: CSSProperties = {
    background: token("search-mark-bg"),
    color: accent.gold.ink,
    borderRadius: 3,
    padding: "0 2px",
  };

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    p.onClick?.();
  }

  return (
    <div
      style={box}
      className={act ? "bk-row" : undefined}
      role={act ? "button" : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={p.onClick}
      onKeyDown={act ? onKeyDown : undefined}
    >
      <div style={head}>
        <Icon icon={p.icon || "file"} size={12} color={accent.teal.ink} />
        {/* The design's own defaults for this component name a real company and
            quote its rates. Replaced with this world's, which is the standing
            rule for fixture content and applies to a runtime fallback too. */}
        <span style={pathStyle}>{p.path ?? "knowledge/scylla.md"}</span>
        {/* `score` carries a fallback in the source, so an unset score still
            renders one — it is content the card cannot be understood without,
            which is the design's own test for which props get a fallback. */}
        {p.score ?? "0.94" ? <span style={scoreStyle}>{p.score ?? "0.94"}</span> : null}
      </div>
      <div style={snippetStyle}>
        {p.before ?? "…she named her before we were out of the bay: "}
        <mark style={markStyle}>{p.highlight ?? "six heads, six men, one pass"}</mark>
        {p.after ?? ". Not a fight. Row hard and accept the count…"}
      </div>
    </div>
  );
}
