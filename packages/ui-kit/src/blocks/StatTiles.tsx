import type { CSSProperties } from "react";

import { Cue } from "../internal/cue.js";
import { warnOnce } from "../internal/dev.js";
import { VALUE_CUE } from "../internal/tone-cue.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font } from "../tokens.js";
import type { ValueTone } from "../types.js";

/**
 * Two to four numbers that answer a question at a glance.
 *
 * The values are display serif so they read as an ANSWER rather than as a
 * dashboard, and a tile is only coloured when its number implies something the
 * user should act on. Never more than four: past that it is a table.
 *
 * A tile that asks for action also draws its tone's glyph AFTER the value
 * (`internal/tone-cue.ts`, #309): the glyph attaches to the number, not the
 * label, and the optional `icon` keeps naming the subject (a wallet, the
 * filer), which is a different question from the judgement. On a tile that
 * has both, each has its own place.
 */
export interface StatTile {
  label: string;
  value: string;
  meta?: string;
  icon?: IconName;
  tone?: ValueTone;
}

export interface StatTilesProps {
  tiles?: StatTile[];
  /** Minimum tile width. At most three columns, or four past ~1100px. */
  minTile?: number;
}

/** Every accent's ink, plus the two inks. An UNTONED value is primary ink —
 * an unremarkable number is still a number you read — and `neutral` is the
 * grey accent, as everywhere else (D33). */
const TONES: Record<ValueTone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
  ink: color.ink,
  dim: color.inkDim,
};

/**
 * A no-props example from the Odysseus world. The example-corpus decision
 * supersedes the old source-persona split; new presentations use this world.
 */
const FALLBACK: StatTile[] = [
  { label: "unfiled", value: "3", icon: "filer", tone: "teal" },
  { label: "deadlines < 14d", value: "1", icon: "deadline", tone: "gold", meta: "Launch the raft" },
  { label: "failed runs", value: "1", icon: "failed", tone: "red", meta: "wind service" },
  { label: "spend today", value: "$1.90", icon: "wallet", tone: "ink", meta: "of $5 cap" },
];

export function StatTiles(p: StatTilesProps) {
  if (p.tiles && !Array.isArray(p.tiles)) warnOnce("StatTiles: `tiles` is not an array; no tiles will render.");
  const src = p.tiles || FALLBACK;
  const requestedBasis = Number(p.minTile);
  const basis = Number.isFinite(requestedBasis) && requestedBasis > 0 ? requestedBasis : 96;

  const grid: CSSProperties & { "--bk-stattiles-min": string } = {
    "--bk-stattiles-min": `${basis}px`,
    display: "grid",
    gap: 9,
    boxSizing: "border-box",
    width: "100%",
    overflowWrap: "anywhere",
  };
  const labelRow: CSSProperties = {
    display: "flex",
    alignSelf: "stretch",
    alignItems: "center",
    gap: 6,
    font: `600 9px/1.2 ${font.mono}`,
    letterSpacing: ".07em",
    textTransform: "uppercase",
    color: accent.neutral.ink,
  };

  return (
    <div style={{ width: "100%", containerType: "inline-size", containerName: "bk-stattiles" }}>
      <div className="bk-stattiles-grid" style={grid}>
        {src.map((t, i) => {
          const tone = t.tone || "ink";
          const c = TONES[tone] || TONES.dim;
          const cue = VALUE_CUE[tone];
          return (
            <div
              key={i}
              style={{
                minWidth: 0,
                boxSizing: "border-box",
                border: `1px solid ${color.line}`,
                background: color.surface,
                borderRadius: 14,
                padding: "12px 13px",
                display: "grid",
                gridTemplateRows: "subgrid",
                gridRow: "span 3",
                alignItems: "start",
                gap: 6,
              }}
            >
              <div style={labelRow}>
                {t.icon ? <Icon icon={t.icon} size={13} color={c} /> : null}
                {t.label}
              </div>
              <div
                data-tone={tone}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  font: `400 24px/1 ${font.display}`,
                  color: c,
                }}
              >
                <span style={{ minWidth: 0 }}>{t.value}</span>
                {cue ? <Cue icon={cue} size={13} /> : null}
              </div>
              {t.meta ? (
                <div style={{ font: `400 10px/1.4 ${font.mono}`, color: accent.neutral.ink }}>
                  {t.meta}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
