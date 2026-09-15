import type { CSSProperties } from "react";

import { warnOnce } from "../internal/dev.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * Two to four numbers that answer a question at a glance.
 *
 * The values are display serif so they read as an ANSWER rather than as a
 * dashboard, and a tile is only coloured when its number implies something the
 * user should act on. Never more than four: past that it is a table.
 *
 * **`neutral` here is the ink ramp, not the neutral accent.** An unremarkable
 * number is a number you read, so it takes primary ink; only a number that
 * means something takes a colour. That is the source's table and it is the
 * whole reason the component reads as prose.
 */
export interface StatTile {
  label: string;
  value: string;
  meta?: string;
  icon?: IconName;
  tone?: Tone;
}

export interface StatTilesProps {
  tiles?: StatTile[];
  /** Flex basis per tile. Three up at a phone width, four past ~1100px. */
  minTile?: number;
}

/** Ink for six meanings, and PRIMARY ink for the seventh — see the note. */
const TONES: Record<Tone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: color.ink,
};

/**
 * THE SOURCE'S FALLBACK, VERBATIM. Nine of wave 3's twenty components keep the
 * design's own stand-in content because it carries no brand; the other eleven
 * had to be replaced under D19 and can no longer be parity-compared on their
 * defaults. Keeping this one as the source wrote it is what lets the DC parity
 * harness compare this component with no arguments on either side.
 */
const FALLBACK: StatTile[] = [
  { label: "unfiled", value: "3", icon: "filer", tone: "teal" },
  { label: "deadlines < 14d", value: "1", icon: "deadline", tone: "gold", meta: "Lisbon deck" },
  { label: "failed runs", value: "1", icon: "failed", tone: "red", meta: "ledger_sync" },
  { label: "spend today", value: "$1.90", icon: "wallet", tone: "neutral", meta: "of $5 cap" },
];

export function StatTiles(p: StatTilesProps) {
  if (p.tiles && !Array.isArray(p.tiles)) warnOnce("StatTiles: `tiles` is not an array; no tiles will render.");
  const src = p.tiles || FALLBACK;
  const basis = Number(p.minTile) || 120;

  const grid: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: 9,
    boxSizing: "border-box",
    width: "100%",
  };
  const labelRow: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    font: `600 9px/1.2 ${font.mono}`,
    letterSpacing: ".07em",
    textTransform: "uppercase",
    color: accent.neutral.ink,
  };

  return (
    <div style={grid}>
      {src.map((t, i) => {
        const c = TONES[t.tone || "neutral"] || TONES.neutral;
        return (
          <div
            key={i}
            style={{
              flex: `1 1 ${basis}px`,
              minWidth: 0,
              boxSizing: "border-box",
              border: `1px solid ${color.line}`,
              background: color.surface,
              borderRadius: 14,
              padding: "12px 13px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={labelRow}>
              {t.icon ? <Icon icon={t.icon} size={13} color={c} /> : null}
              {t.label}
            </div>
            <div style={{ font: `400 24px/1 ${font.display}`, color: c }}>{t.value}</div>
            {t.meta ? (
              <div style={{ font: `400 10px/1.4 ${font.mono}`, color: accent.neutral.ink }}>
                {t.meta}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
