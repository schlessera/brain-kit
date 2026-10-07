import type { CSSProperties, KeyboardEvent } from "react";

import { warnOnce } from "../internal/dev.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * The expansion behind "3 files touched".
 *
 * Each row states WHY that file was read — the one thing a bare list of paths
 * cannot tell you, and the thing that makes a wrong answer debuggable.
 *
 * Read-only: opening a file is navigation, never an effect, so no row carries
 * an effect chip and no row asks for confirmation.
 *
 * Interaction states are the design's, and they are ROW states: hover lifts
 * the background only, the ring is drawn at **-2** because the row fills its
 * container, and pressed is `brightness(.97)` with no transform. Gated per
 * item — a list where only one path is openable gives only that row a role and
 * a tab stop.
 */
export interface RelatedFileItem {
  path: string;
  /** Why this file was read. The reason is the point of the component. */
  reason?: string;
  /** Relevance, as the retriever reported it. */
  score?: string;
  icon?: IconName;
  tone?: Tone;
  onClick?: () => void;
}

export interface RelatedFilesProps {
  /** The uppercase mono heading. */
  label?: string;
  /** How many of how many — "3 of 4,812". */
  meta?: string;
  items?: RelatedFileItem[];
}

const INKS: Record<Tone, string> = {
  teal: accent.teal.ink,
  blue: accent.blue.ink,
  purple: accent.purple.ink,
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
};

const FALLBACK: RelatedFileItem[] = [
  {
    path: "decisions/scylla-or-charybdis.md",
    reason: "the file the question was about",
    score: "0.98",
    tone: "amber",
  },
  { path: "knowledge/scylla.md", reason: "names the cost in men", score: "0.91" },
  { path: "people/circe.md", reason: "where the directions came from", score: "0.74" },
];

export function RelatedFiles(p: RelatedFilesProps) {
  if (p.items && !Array.isArray(p.items)) warnOnce("RelatedFiles: `items` is not an array; no files will render.");
  const src = p.items || FALLBACK;
  const label = p.label ?? "Files read";
  const meta = p.meta ?? "3 of 4,812";

  const labelRow: CSSProperties = {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    marginBottom: 2,
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        boxSizing: "border-box",
        width: "100%",
      }}
    >
      {label ? (
        <div style={labelRow}>
          <span
            style={{
              font: `600 9.5px/1 ${font.mono}`,
              letterSpacing: ".09em",
              textTransform: "uppercase",
              color: accent.neutral.ink,
            }}
          >
            {label}
          </span>
          {meta ? (
            <span
              style={{
                marginLeft: "auto",
                font: `400 9.5px/1 ${font.mono}`,
                color: accent.neutral.ink,
              }}
            >
              {meta}
            </span>
          ) : null}
        </div>
      ) : null}
      {src.map((it, i) => {
        const ink = INKS[it.tone || "teal"] || INKS.teal;
        const act = Boolean(it.onClick);
        const row: CSSProperties = {
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "8px 10px",
          boxSizing: "border-box",
          minHeight: act ? 44 : undefined,
          borderRadius: 10,
          background: color.surface,
          border: `1px solid ${color.line}`,
          cursor: act ? "pointer" : "default",
          // A row with no handler "hovers" to where it already is. The class is
          // gated anyway; this keeps the custom property honest.
          ...({ "--hv-bg": act ? color.raised : color.surface } as CSSProperties),
        };

        function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          it.onClick?.();
        }

        return (
          <div
            key={i}
            style={row}
            className={act ? "bk-row" : undefined}
            role={act ? "button" : undefined}
            tabIndex={act ? 0 : undefined}
            onClick={it.onClick}
            onKeyDown={act ? onKeyDown : undefined}
          >
            <Icon icon={it.icon || "file"} size={13} color={ink} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    font: `500 11px/1.4 ${font.mono}`,
                    color: ink,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {it.path}
                </span>
                {it.score ? (
                  <span
                    style={{
                      flex: "none",
                      font: `400 9.5px/1.4 ${font.mono}`,
                      color: accent.neutral.ink,
                    }}
                  >
                    {it.score}
                  </span>
                ) : null}
              </div>
              {it.reason ? (
                <div
                  style={{
                    marginTop: 3,
                    overflowWrap: "anywhere",
                    font: `400 11px/1.5 ${font.body}`,
                    color: accent.neutral.ink,
                  }}
                >
                  {it.reason}
                </div>
              ) : null}
            </div>
            <Icon icon="next" size={13} color={accent.neutral.ink} />
          </div>
        );
      })}
    </div>
  );
}
