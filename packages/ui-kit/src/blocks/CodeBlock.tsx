import type { CSSProperties } from "react";

import { Icon } from "../primitives/Icon.js";
import { accent, color, font } from "../tokens.js";

/**
 * Commands and config the user is meant to run or paste.
 *
 * Deliberately not syntax-highlighted: in this app mono type already means
 * "machine", and colour is reserved for decisions. Use `DiffBlock` instead
 * when the point is a change rather than a thing to copy.
 *
 * The copy glyph is DECORATIVE, exactly as in the source — the component has
 * no clipboard access and `ui-kit` has no browser globals (D13). A caller that
 * wants a working copy button composes one; this is the affordance the design
 * drew, and giving it a handler here would make the kit impure for one glyph.
 */
export interface CodeBlockProps {
  code?: string;
  /** The uppercase amber tag on the left of the head. */
  lang?: string;
  /** A quiet note beside it — where to run this, not what it does. */
  caption?: string;
  /** Show the head. On by default. */
  head?: boolean;
  /** Wrap long lines. On by default; off enables native horizontal scrolling. */
  wrap?: boolean;
  fontSize?: number;
  /* Read by the source's renderVals(), absent from its data-props. */
  radius?: number;
  pad?: number;
}

export function CodeBlock(p: CodeBlockProps) {
  const box: CSSProperties = {
    border: `1px solid ${color.edge}`,
    background: color.surface,
    borderRadius: Number(p.radius) || 12,
    overflow: "hidden",
    boxSizing: "border-box",
    width: "100%",
  };
  const head: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "8px 11px",
    borderBottom: `1px solid ${color.line}`,
  };

  return (
    <div style={box}>
      {p.head !== false ? (
        <div style={head}>
          <span
            style={{
              flex: "none",
              font: `600 9px/1 ${font.mono}`,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: accent.amber.ink,
            }}
          >
            {p.lang ?? "bash"}
          </span>
          {p.caption ? (
            <span
              style={{
                flex: 1,
                minWidth: 0,
                font: `400 10px/1.4 ${font.mono}`,
                color: accent.neutral.ink,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {p.caption}
            </span>
          ) : null}
          <Icon icon="copy" size={13} color={accent.neutral.ink} />
        </div>
      ) : null}
      <pre
        className={p.wrap === false ? "bk-scroll-x" : undefined}
        tabIndex={p.wrap === false ? 0 : undefined}
        role={p.wrap === false ? "region" : undefined}
        aria-label={p.wrap === false ? "Code" : undefined}
        style={{
          margin: 0,
          padding: Number(p.pad) || 11,
          font: `400 ${Number(p.fontSize) || 11}px/1.7 ${font.mono}`,
          color: color.inkDim,
          whiteSpace: p.wrap === false ? "pre" : "pre-wrap",
          overflowX: p.wrap === false ? "auto" : "hidden",
          overflowWrap: p.wrap === false ? undefined : "anywhere",
        }}
      >
        {p.code ?? "brain reindex --path talks/ --force"}
      </pre>
    </div>
  );
}
