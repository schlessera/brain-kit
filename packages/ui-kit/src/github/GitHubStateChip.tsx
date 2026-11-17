import type { CSSProperties } from "react";
import { Icon } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import { STATES, stateWord, type GitHubState } from "./shared.js";

/**
 * `GitHubStateChip` — one GitHub state as a glyph and a word (#3800, design
 * #3795 §5). Colour only reinforces: every state reads without it.
 *
 * Absent is never passing. `none-reported` (checks the payload does not
 * carry) and `not-reported` (an unknown review state) draw a dash in neutral
 * ink, never teal and never ✓.
 *
 * - `chip`: a pill, for an object's own state in its header.
 * - `inline`: glyph and word only, for facts, reviewer rows and events.
 */
export interface GitHubStateChipProps {
  state: GitHubState;
  /** Which object an `open` state belongs to; picks the PR or issue glyph. Defaults to `issue`. */
  kind?: "pr" | "issue";
  /** For `failing`, `running`, `passed`, `approved` and `changes-requested`: how many. */
  count?: number;
  variant?: "chip" | "inline";
}

export function GitHubStateChip(p: GitHubStateChipProps) {
  const look = STATES[p.state];
  const variant = p.variant ?? "chip";
  const tone = accent[look.tone];
  const ink = look.tone === "neutral" ? (look.quiet ? color.inkMute : color.inkDim) : tone.ink;
  const icon = p.state === "open" && p.kind === "pr" ? "pr-open" : look.icon;
  const word = stateWord(p.state, p.count);

  const box: CSSProperties =
    variant === "chip"
      ? {
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          flex: "none",
          padding: "3px 9px",
          borderRadius: 999,
          border: `1px ${look.dashed ? "dashed" : "solid"} ${look.tone === "neutral" ? color.edge : token(`chip-border-${look.tone}`)}`,
          background: look.tone === "neutral" || look.dashed ? "transparent" : token(`chip-tint-${look.tone}`),
          font: `500 11px/1.35 ${font.body}`,
          color: ink,
          whiteSpace: "nowrap",
        }
      : {
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          font: `500 11.5px/1.35 ${font.body}`,
          color: ink,
        };

  return (
    <span style={box} data-github-state={p.state}>
      {icon ? <Icon icon={icon} size={variant === "chip" ? 12 : 12} /> : <span aria-hidden="true">—</span>}
      {word}
    </span>
  );
}
