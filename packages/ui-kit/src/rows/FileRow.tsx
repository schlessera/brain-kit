import type { CSSProperties, KeyboardEvent } from "react";

import { Chip } from "../primitives/Chip.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { StatusDot } from "../primitives/StatusDot.js";
import { edgeFor, focusEdge, focusSibling } from "../internal/roving.js";
import { Placeholder } from "../states/Placeholder.js";
import { accent, color, font, token } from "../tokens.js";
import type { FileKind, Tone, ViewState } from "../types.js";

/**
 * File tree row. `badge` is the unprocessed count — the one badge in the tree —
 * `flag` is a dot meaning the folder needs attention, and `meta` is a child
 * count or a staleness note. All three optional.
 *
 * `view` swaps the whole row for a `Placeholder` at row size, with this
 * component's own copy: "Empty folder", "Folder unreadable / Permission denied
 * on the host." Both overridable through `stateMessage` / `stateDetail`.
 *
 * The error variant's retry becomes a real control when the caller passes
 * `onStateAction`, and stays the label the source draws when they do not. The
 * source has no such prop — it relies on its editor to wire buttons — so this
 * is the one place this port widens the API, and it widens it in the direction
 * the design's own gating rule already points: a control with no handler is
 * not a control. `onClick` is NOT reused for it, because "open this" and "try
 * the fetch again" are different actions and a callback that means both is a
 * bug waiting for its first caller.
 *
 * EVERY OPERABLE ROW IS A `treeitem`, folder and file alike, and that is a
 * deliberate correction to the source rather than a port (wave 1b). The source
 * picks per row — `treeitem` for a folder, `option` for a file — and the two
 * are unsatisfiable together: `treeitem` requires a `tree` parent and `option`
 * requires a `listbox`, so whichever container the caller renders, half the
 * rows are invalid inside it. Axe failed both halves at once — `aria-required-
 * parent` on the rows and `aria-required-children` on the tree holding them —
 * and no call site could have fixed it, because the container it would need
 * does not exist. The design's own role table names `button` / `treeitem` for
 * this component and never mentions `option`, so `treeitem` is also the reading
 * that matches the spec. `.plan/design-feedback.md` records the divergence.
 *
 * `aria-expanded` still tells a folder from a file, which is the distinction
 * the role was carrying, and it is the attribute a tree is read by anyway.
 *
 * The `tree` container is still the CALLER'S — this component is one row and
 * cannot render it — and the stories show the wrapper. That part is unchanged.
 */
export interface FileRowProps {
  /** `ready` renders the row; the other three render a `Placeholder`. */
  view?: ViewState;
  /** The design calls it `label`, not `name`, because `name` is reserved by the
   * source's own import syntax. Kept, so catalog and code stay comparable. */
  label?: string;
  kind?: FileKind;
  /** Indent level; each step is 22px. */
  depth?: number;
  /** Unprocessed count. */
  badge?: string;
  meta?: string;
  metaTone?: Tone;
  /** A left-edge dot: stale, failing, or fine. */
  flag?: Tone;
  /** The row the viewer is on. Amber glyph, raised ground. */
  active?: boolean;
  /** Name colour override. */
  tone?: Tone;
  stateMessage?: string;
  stateDetail?: string;
  stateAction?: string;
  /** Makes the error state's retry real. See the note above. */
  onStateAction?: () => void;
  onClick?: () => void;
}

const TONES: Record<Tone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
};

const ICONS: Record<FileKind, IconName> = {
  folder: "folder",
  open: "folder-open",
  file: "file",
  image: "image",
};

export function FileRow(p: FileRowProps) {
  const kind = p.kind || "folder";
  const open = kind === "open";
  const active = p.active === true;
  const depth = Number(p.depth) || 0;
  const act = Boolean(p.onClick);
  const view = p.view || "ready";

  if (view !== "ready") {
    return (
      <Placeholder
        variant={view}
        message={p.stateMessage ?? (view === "empty" ? "Empty folder" : view === "error" ? "Folder unreadable" : undefined)}
        detail={p.stateDetail ?? (view === "error" ? "Permission denied on the host." : undefined)}
        actionLabel={view === "error" ? (p.stateAction ?? "Retry") : undefined}
        icon={view === "empty" ? "folder" : "failed"}
        lines={1}
        pad={9}
        radius={9}
        bordered={view !== "loading"}
        onAction={p.onStateAction}
      />
    );
  }

  const isFolder = kind === "folder" || open;

  const box: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    boxSizing: "border-box",
    width: "100%",
    padding: "9px 8px",
    paddingLeft: 8 + depth * 22,
    borderRadius: 8,
    background: active ? color.raised : "transparent",
    font: `400 13px/1 ${font.body}`,
    cursor: act ? "pointer" : "default",
    // The active row does not lift: it is already raised. A custom property is
    // not in React's CSSProperties, so the entry is cast.
    ...({ "--hv-bg": active ? color.raised : act ? token("hover-veil") : "transparent" } as CSSProperties),
  };
  const nameStyle: CSSProperties = {
    flex: "none",
    maxWidth: "68%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: p.tone ? TONES[p.tone] : kind === "file" || kind === "image" ? color.inkDim : color.ink,
  };
  const metaStyle: CSSProperties = {
    marginLeft: "auto",
    flex: "none",
    font: `400 10px/1 ${font.mono}`,
    color: p.metaTone ? TONES[p.metaTone] : color.inkMute,
  };

  // The design's key table also gives FileRow ←→ to fold, which this component
  // has no callback for: `kind` is a prop, and there is no `onToggle` in the
  // source's prop table to route an arrow key to. Adding one would widen the
  // API during a port, so it is recorded in `.plan/PLAN.md` for the wave that
  // builds the tree rather than invented here. ↑↓ and Home/End move between
  // the sibling rows of whatever container the caller stacked them in (the
  // fourth drop's answer to design-feedback §11: "Home / End wherever a
  // roving tab stop exists … and the file tree").
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      p.onClick?.();
      return;
    }
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    const edge = edgeFor(event.key);
    if (delta === 0 && !edge) return;
    event.preventDefault();
    if (edge) focusEdge(event.currentTarget, edge, '[role="treeitem"]');
    else focusSibling(event.currentTarget, delta, '[role="treeitem"]');
  }

  return (
    <div
      style={box}
      className={act ? "bk-row" : undefined}
      role={act ? "treeitem" : undefined}
      aria-expanded={act ? (kind === "folder" ? false : open ? true : undefined) : undefined}
      aria-selected={act && active ? true : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={p.onClick}
      onKeyDown={act ? onKeyDown : undefined}
    >
      {isFolder ? <Icon icon="next" size={12} color={color.inkMute} /> : null}
      <Icon
        icon={ICONS[kind] || "file"}
        size={isFolder ? 16 : 14}
        color={open ? token("file-icon-open") : active ? accent.amber.ink : color.inkMute}
      />
      <span style={nameStyle}>{p.label ?? "notes"}</span>
      {p.badge ? <Chip label={p.badge} variant="count" tone="red" /> : null}
      {p.flag ? <StatusDot tone={p.flag} pulse={false} size={6} /> : null}
      {p.meta ? <span style={metaStyle}>{p.meta}</span> : null}
    </div>
  );
}
