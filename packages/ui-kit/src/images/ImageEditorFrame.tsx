/**
 * The shared shell of the image editors (#3983): a fullscreen dark overlay
 * with a header (title, one context line and the close control), a stage that
 * takes the remaining height, an error line and a toolbar slot.
 *
 * The mask editor and the markup editor draw different things with different
 * tools, so each brings its own stage and toolbar. They share this frame so
 * they look and behave the same: one title placement, one dismissal path
 * (the X, Escape and the overlay's close request all reach `onClose`), and a
 * photograph's dark chrome in both themes.
 *
 * The mask editor's frame moved here unchanged; its layout values are the
 * ones it had in ui-react (12px insets and gaps, a 14px header, a 44px close
 * control).
 */

import { useId, useState, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";

import { Overlay, type OverlayCloseReason } from "../chrome/Overlay.js";
import { Icon } from "../primitives/Icon.js";
import { accent, color } from "../tokens.js";

export interface ImageEditorFrameProps {
  open: boolean;
  /** Fixed per editor: it also names the dialog. */
  title: string;
  /**
   * The context line under the title: the agent's instruction, or the image
   * path when there is none. Always plain text, never rendered as markup.
   */
  subtitle?: string;
  /** Shown before the subtitle in the same line, such as "Agent asks:". */
  subtitlePrefix?: string;
  /**
   * `truncate` keeps one line with an ellipsis (the mask editor). `expand`
   * clamps to two lines and expands on tap, with `aria-expanded`.
   */
  subtitleMode?: "truncate" | "expand";
  /** The close control's accessible name. */
  closeLabel: string;
  /** A request: the caller decides whether to close (and may ask first). */
  onClose: (reason: OverlayCloseReason | "close-button") => void;
  /** A refusal stated under the stage, in the destructive ink. */
  error?: string | null;
  /** The editor's own controls, under the stage. */
  toolbar: ReactNode;
  /** The stage: the image and whatever is drawn on it. */
  children: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
  /** The stage element, for measuring and gesture handling. */
  stageRef?: Ref<HTMLDivElement>;
  /** Stage padding; the mask editor's is 12px, the markup canvas fills the stage. */
  stagePadding?: number;
  [data: `data-${string}`]: string | undefined;
}

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: 12,
  fontSize: 14,
  lineHeight: "20px",
  color: color.ink,
};


export function ImageEditorFrame(p: ImageEditorFrameProps) {
  const titleId = useId();
  const subtitleId = useId();
  const [expanded, setExpanded] = useState(false);
  const mode = p.subtitleMode ?? "truncate";
  const data = Object.fromEntries(Object.entries(p).filter(([key]) => key.startsWith("data-")));

  const subtitle = p.subtitle ? (
    <>
      {p.subtitlePrefix ? <span style={{ color: color.inkDim, fontWeight: 500 }}>{p.subtitlePrefix} </span> : null}
      {p.subtitle}
    </>
  ) : null;

  return (
    <Overlay
      open={p.open}
      variant="fullscreen"
      theme="dark"
      labelledBy={titleId}
      onClose={p.onClose}
      initialFocus={p.initialFocus}
      {...data}
    >
      <div style={{ display: "flex", height: "100%", flexDirection: "column" }} data-bk-image-editor="">
        <div style={header}>
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} style={{ margin: 0, fontSize: "inherit", fontWeight: 500 }}>
              {p.title}
            </h2>
            {subtitle && mode === "truncate" ? (
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: color.inkMute }}>
                {subtitle}
              </div>
            ) : null}
            {subtitle && mode === "expand" ? (
              // raw-button: kit — The instruction is text that expands in place; a Button would restyle it.
              <button
                type="button"
                id={subtitleId}
                aria-expanded={expanded}
                onClick={() => setExpanded(open => !open)}
                className="bk-hit"
                style={{
                  appearance: "none",
                  display: "block",
                  margin: 0,
                  padding: 0,
                  border: "none",
                  background: "transparent",
                  font: "inherit",
                  textAlign: "left",
                  color: color.inkMute,
                  cursor: "pointer",
                  overflowWrap: "anywhere",
                }}
                data-bk-editor-instruction=""
              >
                {/* The clamp sits inside, so it cannot clip the button's coarse-pointer reach. */}
                <span
                  style={{
                    display: "-webkit-box",
                    WebkitBoxOrient: "vertical",
                    WebkitLineClamp: expanded ? "unset" : 2,
                    overflow: "hidden",
                  }}
                >
                  {subtitle}
                </span>
              </button>
            ) : null}
          </div>
          {/* raw-button: kit — The photograph chrome's 20px close glyph, drawn as it was in the mask editor. */}
          <button
            type="button"
            className="bk-editor-close"
            aria-label={p.closeLabel}
            onClick={() => p.onClose("close-button")}
            data-bk-editor-close=""
          >
            <Icon icon="dismiss" size={20} />
          </button>
        </div>

        <div
          ref={p.stageRef}
          style={{
            position: "relative",
            display: "flex",
            minHeight: 0,
            flex: "1 1 0%",
            alignItems: "center",
            justifyContent: "center",
            padding: p.stagePadding ?? 12,
          }}
          data-bk-editor-stage=""
        >
          {p.children}
        </div>

        {p.error ? (
          <div
            role="alert"
            style={{ padding: "0 12px 4px", textAlign: "center", fontSize: 14, lineHeight: "20px", color: accent.red.fill }}
            data-bk-editor-error=""
          >
            {p.error}
          </div>
        ) : null}

        <div style={{ padding: 12 }} data-bk-editor-toolbar="">
          {p.toolbar}
        </div>
      </div>
    </Overlay>
  );
}
