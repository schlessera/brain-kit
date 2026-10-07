import type { CSSProperties, ReactNode } from "react";

import { accent, color, font } from "../tokens.js";

/**
 * Commands and config the user is meant to run or paste.
 *
 * The host can supply a highlighted body and a real copy action. The kit
 * stays free of highlighting, clipboard access and browser globals (D13).
 * Absent source, language and action draw no example or false affordance.
 */
export interface CodeBlockProps {
  code?: string;
  /** Pre-rendered body; falls back to the source string. */
  children?: ReactNode;
  /** Host-owned control at the right of the head. */
  action?: ReactNode;
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
    padding: p.action ? "4px 11px" : "8px 11px",
    borderBottom: `1px solid ${color.line}`,
  };

  return (
    <div style={box} data-kit-code-block>
      {p.head !== false ? (
        <div style={head}>
          {p.lang ? <span
            style={{
              minWidth: 0,
              overflowWrap: "anywhere",
              font: `600 9px/1 ${font.mono}`,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: accent.amber.ink,
            }}
          >
            {p.lang}
          </span> : null}
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
          {p.action ? <div style={{ marginLeft: "auto", flex: "none", display: "flex" }}>{p.action}</div> : null}
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
        {p.children ?? p.code ?? ""}
      </pre>
    </div>
  );
}
