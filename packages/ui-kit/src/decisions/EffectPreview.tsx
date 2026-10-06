import type { CSSProperties } from "react";

import { Button } from "../primitives/Button.js";
import { accent, color, font } from "../tokens.js";

/**
 * The exact effect a decision will have, shown before the control that
 * commits it.
 *
 * A durable Action asks to run one stored operation: a tool, a full input and
 * a target path. This card prints all three as text — never as markdown, HTML
 * or a link — so what a reader approves is what they read. Paths wrap and are
 * never truncated: the path IS the record.
 *
 * Inputs longer than `maxLines` are collapsed behind a reveal control whose
 * label says how much is hidden. The caller pairs `revealed` with its commit
 * control: until the whole input has been displayed, the commit is replaced
 * by a review prompt (see `DispositionBar`). The rule is "it has been shown",
 * not "it has been scrolled".
 *
 * Three other variants exist because a decision is not always an edit:
 * `cancel` prints the queued work it stops, `unavailable` marks an effect this
 * version does not carry out (the caller disables its option), and
 * `malformed` says the effect cannot be displayed and prints the raw record
 * as escaped text, so a broken payload is never a blank card and never markup.
 */
export interface EffectPreviewProps {
  variant?: "enqueue" | "cancel" | "unavailable" | "malformed";
  /** The band's heading: "If approved", "If you choose this". */
  heading?: string;
  /** The effect's name, in the same vocabulary as its button. */
  effect?: string;
  tool?: string;
  path?: string;
  /** The follow-up instruction, as plain text. */
  instruction?: string;
  /** The full input, already serialised. Shown verbatim. */
  input?: string;
  /** The capability sentence: what approving grants, and nothing wider. */
  scope?: string;
  /** The honest cost line. Omit when no model call follows. */
  cost?: string;
  /** `cancel` / `unavailable` / `malformed`: the sentence that replaces rows. */
  message?: string;
  /** `malformed`: the raw record, already serialised. Printed as text. */
  raw?: string;
  /** Lines shown before the input collapses. 12 by default. */
  maxLines?: number;
  /** Whether a collapsed input has been revealed. The caller owns it. */
  revealed?: boolean;
  onReveal?: () => void;
}

/** How many lines `text` occupies, counting a trailing partial line. */
export function effectLineCount(text: string | undefined): number {
  return text ? text.split("\n").length : 0;
}

function sizeLabel(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function EffectPreview(p: EffectPreviewProps) {
  const variant = p.variant ?? "enqueue";
  const max = p.maxLines ?? 12;
  const lines = effectLineCount(p.input);
  const gated = lines > max && p.revealed !== true;
  const shown = gated ? p.input!.split("\n").slice(0, max).join("\n") : p.input;
  const tone = variant === "malformed" ? accent.red.ink : variant === "unavailable" ? color.inkMute : accent.amber.ink;

  const box: CSSProperties = {
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    border: `1px solid ${color.line}`,
    borderRadius: 10,
    background: color.canvas,
    padding: "9px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  };
  const head: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    font: `600 9.5px/1.2 ${font.mono}`,
    letterSpacing: ".06em",
    textTransform: "uppercase",
    color: tone,
  };
  const chip: CSSProperties = {
    marginLeft: "auto",
    border: `1px solid ${color.edge}`,
    borderRadius: 5,
    padding: "2px 6px",
    font: `600 9px/1.3 ${font.mono}`,
    textTransform: "none",
    letterSpacing: 0,
    color: color.inkMute,
  };
  const row: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "56px minmax(0, 1fr)",
    gap: 8,
    alignItems: "baseline",
    font: `400 11.5px/1.5 ${font.body}`,
    color: color.ink,
  };
  const key: CSSProperties = { font: `500 10px/1.5 ${font.mono}`, color: color.inkMute };
  const wrap: CSSProperties = { minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word", whiteSpace: "pre-wrap" };
  const mono: CSSProperties = { ...wrap, font: `500 11px/1.5 ${font.mono}` };
  const pathStyle: CSSProperties = { ...mono, color: accent.teal.ink, wordBreak: "break-all" };
  const pre: CSSProperties = {
    ...mono,
    margin: 0,
    padding: "6px 8px",
    borderRadius: 6,
    background: color.surface,
    border: `1px solid ${color.line}`,
    fontSize: 10.5,
  };
  const note: CSSProperties = { ...wrap, font: `400 11.5px/1.5 ${font.body}`, color: color.inkMute };

  return (
    <div style={box} data-effect-preview={variant}>
      <div style={head}>
        <span>{p.heading ?? (variant === "malformed" ? "Effect" : "If approved")}</span>
        {p.effect ? <span style={chip}>{p.effect}</span> : null}
      </div>
      {variant === "enqueue" ? (
        <>
          {p.tool ? (
            <div style={row}>
              <span style={key}>tool</span>
              <span style={mono}>{p.tool}</span>
            </div>
          ) : null}
          {p.path ? (
            <div style={row}>
              <span style={key}>path</span>
              <span style={pathStyle} data-effect-path="">{p.path}</span>
            </div>
          ) : null}
          {p.instruction ? (
            <div style={row}>
              <span style={key}>task</span>
              <span style={wrap}>{p.instruction}</span>
            </div>
          ) : null}
          {p.input !== undefined ? (
            <div style={row}>
              <span style={key}>input</span>
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                <pre style={pre} data-effect-input="">{shown}</pre>
                {gated ? (
                  <Button
                    label={`Show all ${lines} lines · ${sizeLabel(p.input!)}`}
                    tone="ghost"
                    size="sm"
                    block={false}
                    style={{ minHeight: 44 }}
                    onClick={p.onReveal}
                  />
                ) : null}
              </div>
            </div>
          ) : null}
          {p.scope ? (
            <div style={row}>
              <span style={key}>grants</span>
              <span style={wrap}>{p.scope}</span>
            </div>
          ) : null}
          {p.cost ? (
            <div style={row}>
              <span style={key}>cost</span>
              <span style={wrap}>{p.cost}</span>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {p.message ? <div style={note}>{p.message}</div> : null}
          {variant === "malformed" && p.raw !== undefined ? (
            <pre style={pre} data-effect-raw="">{p.raw}</pre>
          ) : null}
        </>
      )}
    </div>
  );
}
