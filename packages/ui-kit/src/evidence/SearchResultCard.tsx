import { GhostBand } from "../internal/GhostBand.js";
import { useId, type CSSProperties, type KeyboardEvent } from "react";

import { Ghosted, ghostLength, useArrival, useLastLengths, useLoadingValue, type GhostTextProps } from "../internal/GhostText.js";
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
 * Loading is the card itself in ghost text (#1116): the frame and the teal
 * file icon are final from the first frame, the path and score are mono
 * ghosts, and the snippet is a sans ghost as long as the snippet will be —
 * `snippetLength` when the search knows it, else the last one shown, else a
 * typical 120 characters. One band sweeps the whole frame (#1126).
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
  /** All snippet segments, in order. Overrides the single-highlight fields. */
  segments?: readonly { text: string; hit: boolean }[];
  /** Supplied result identity, above the snippet; absent renders no title. */
  title?: string;
  type?: string;
  /** Keyboard-selected result, controlled by the surrounding search list. */
  active?: boolean;
  icon?: IconName;
  stateMessage?: string;
  stateDetail?: string;
  stateAction?: string;
  /** Makes the error state's re-index real. See the note above. */
  onStateAction?: () => void;
  /** Loading only: the snippet's length, when the search reports it. */
  snippetLength?: number;
  /** Result rank, retained for compatibility; block sweeps no longer stagger. */
  index?: number;
  onClick?: () => void;
}

export function SearchResultCard(p: SearchResultCardProps) {
  const view = p.view || "ready";
  const loading = view === "loading";
  const arriving = useArrival(loading);
  // The ghost's seed is this instance — kept per item key, not per list
  // position — so re-ranking a row never regenerates its glyphs.
  const id = useId();
  const path = p.path ?? "knowledge/scylla.md";
  const score = p.score ?? "0.94";
  const before = p.before ?? "…she named her before we were out of the bay: ";
  const highlight = p.highlight ?? "six heads, six men, one pass";
  const after = p.after ?? ". Not a fight. Row hard and accept the count…";
  const last = useLastLengths(view === "ready", {
    path: path.length,
    score: score.length,
    snippet: p.segments?.reduce((n, segment) => n + segment.text.length, 0) ?? before.length + highlight.length + after.length,
  });
  const lengths = useLoadingValue(loading, {
    path: ghostLength(last.path, undefined, 26),
    score: ghostLength(last.score, undefined, 4),
    snippet: ghostLength(last.snippet, p.snippetLength, 120),
  });
  const act = Boolean(p.onClick) && !loading;

  if (view !== "ready" && !loading) {
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
        radius={12}
        onAction={p.onStateAction}
      />
    );
  }

  const box: CSSProperties = {
    border: `1px solid ${color.line}`,
    background: p.active ? color.raised : color.surface,
    borderRadius: 12,
    padding: "10px 12px",
    boxSizing: "border-box",
    width: "100%",
    minHeight: act ? 44 : undefined,
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
    position: "relative",
    flex: 1,
    minWidth: 0,
    overflow: loading || arriving ? "visible" : "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
  const scoreStyle: CSSProperties = { position: "relative", flex: "none", color: color.inkMute };
  const snippetStyle: CSSProperties = {
    position: "relative",
    marginTop: 6,
    font: `400 12px/1.6 ${font.body}`,
    color: color.inkDim,
    overflowWrap: "anywhere",
  };
  const ghost = (slot: string, length: number, _line: number, role: "sans" | "mono"): GhostTextProps => ({
    role,
    line: role === "mono",
    size: role === "mono" ? 11 : 12,
    length,
    seed: `${id}:${slot}`,
    path: slot === "path",
  });
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
      style={{ ...box, position: "relative" }}
      data-search-result-card=""
      aria-busy={loading ? true : undefined}
      className={act ? "bk-row" : undefined}
      role={act ? "button" : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={act ? p.onClick : undefined}
      onKeyDown={act ? onKeyDown : undefined}
    >
      <div style={head}>
        <Icon icon={p.icon || "file"} size={12} color={accent.teal.ink} />
        {/* The design's own defaults for this component name a real company and
            quote its rates. Replaced with this world's, which is the standing
            rule for fixture content and applies to a runtime fallback too. */}
        <span style={pathStyle} title={loading ? undefined : path}>
          <Ghosted loading={loading} arriving={arriving} ghost={ghost("path", lengths.path, 0, "mono")}>
            {path}
          </Ghosted>
        </span>
        {/* `score` carries a fallback in the source, so an unset score still
            renders one — it is content the card cannot be understood without,
            which is the design's own test for which props get a fallback. */}
        {score ? (
          <span style={scoreStyle}>
            <Ghosted loading={loading} arriving={arriving} ghost={ghost("score", lengths.score, 0, "mono")}>
              {score}
            </Ghosted>
          </span>
        ) : null}
      </div>
      {p.title || p.type ? (
        <div style={{ marginTop: 6, color: color.ink, font: `500 12px/1.5 ${font.body}`, overflowWrap: "anywhere" }}>
          {p.title ? <span>{p.title}</span> : null}
          {p.type ? <span style={{ marginLeft: p.title ? 7 : 0, color: color.inkMute, font: `400 10px/1.5 ${font.mono}` }}>{p.type}</span> : null}
        </div>
      ) : null}
      <div style={snippetStyle}>
        <Ghosted loading={loading} arriving={arriving} ghost={ghost("snippet", lengths.snippet, 1, "sans")}>
          {p.segments ? p.segments.map((segment, index) => segment.hit
            ? <mark key={index} style={markStyle}>{segment.text}</mark>
            : <span key={index}>{segment.text}</span>) : <>{before}<mark style={markStyle}>{highlight}</mark>{after}</>}
        </Ghosted>
      </div>
      <GhostBand loading={loading} arriving={arriving} />
    </div>
  );
}
