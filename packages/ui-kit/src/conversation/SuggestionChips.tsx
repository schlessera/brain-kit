import type { CSSProperties, KeyboardEvent } from "react";

import { warnOnce } from "../internal/dev.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { SuggestionTone } from "../types.js";

/**
 * Follow-ups offered after an answer.
 *
 * Every chip is a prompt the user could have typed, in their voice — not a
 * menu of app features. One of them may carry an effect (drafting, filing),
 * which is why a chip can be amber. Three or four maximum: past that it is a
 * menu, and a menu is the app telling the user what to want.
 *
 * **An untoned chip is DIM INK on the plain card edge**: a chip suggesting a
 * plain question is text-coloured, and the grey accent would make it look
 * disabled. `neutral` is that grey accent (D33), for the one chip that IS
 * machine-flavoured — a re-index, a retry.
 *
 * Interaction states are the design's, from the drop that added them. A chip
 * is pill-shaped, so it takes `.bk-control` — ring outside, all three hover
 * properties, a 1px press. The source spells its own press as
 * `brightness(.95)` with no transform where `.bk-control` uses `.94` with one;
 * the shared implementation wins, because four states with one implementation
 * each is the only reason they stay consistent across thirty components.
 */
export interface SuggestionItem {
  label: string;
  icon?: IconName;
  tone?: SuggestionTone;
  onClick?: () => void;
}

export interface SuggestionChipsProps {
  /** The uppercase mono line above the row. */
  label?: string;
  items?: SuggestionItem[];
  /** Wrap to a second line. On by default; off clips. */
  wrap?: boolean;
}

const INKS: Record<SuggestionTone, string> = {
  neutral: accent.neutral.ink,
  teal: accent.teal.ink,
  amber: accent.amber.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
};

const BORDERS: Record<SuggestionTone, string> = {
  neutral: token("suggestion-border-neutral"),
  teal: token("suggestion-border-teal"),
  amber: token("suggestion-border-amber"),
  purple: token("suggestion-border-purple"),
  blue: token("suggestion-border-blue"),
};

const TINTS: Record<SuggestionTone, string> = {
  neutral: token("suggestion-tint-neutral"),
  teal: token("suggestion-tint-teal"),
  amber: token("suggestion-tint-amber"),
  purple: token("suggestion-tint-purple"),
  blue: token("suggestion-tint-blue"),
};

const HOVER_TINTS: Record<SuggestionTone, string> = {
  neutral: token("suggestion-hover-tint-neutral"),
  teal: token("suggestion-hover-tint-teal"),
  amber: token("suggestion-hover-tint-amber"),
  purple: token("suggestion-hover-tint-purple"),
  blue: token("suggestion-hover-tint-blue"),
};

const HOVER_BORDERS: Record<SuggestionTone, string> = {
  neutral: token("suggestion-hover-border-neutral"),
  teal: token("suggestion-hover-border-teal"),
  amber: token("suggestion-hover-border-amber"),
  purple: token("suggestion-hover-border-purple"),
  blue: token("suggestion-hover-border-blue"),
};

const FALLBACK: SuggestionItem[] = [
  { label: "What happened since leaving Troy?", icon: "digest", tone: "amber" },
  { label: "Who is still owed an offering?", icon: "policy", tone: "purple" },
  { label: "What did I promise Penelope?", icon: "ask", tone: "teal" },
];

export function SuggestionChips(p: SuggestionChipsProps) {
  if (p.items && !Array.isArray(p.items)) warnOnce("SuggestionChips: `items` is not an array; no chips will render.");
  const src = p.items || FALLBACK;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        boxSizing: "border-box",
        width: "100%",
      }}
    >
      {(p.label ?? "Next") ? (
        <div
          style={{
            font: `600 9.5px/1 ${font.mono}`,
            letterSpacing: ".09em",
            textTransform: "uppercase",
            color: accent.neutral.ink,
          }}
        >
          {p.label ?? "Next"}
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          flexWrap: p.wrap === false ? "nowrap" : "wrap",
          gap: 7,
          overflow: "hidden",
        }}
      >
        {src.map((it, i) => {
          const tone = it.tone;
          const ink = tone ? INKS[tone] || color.inkDim : color.inkDim;
          const act = Boolean(it.onClick);
          // The PRESENCE of a tone is what makes a chip toned, not its value:
          // an untoned chip is transparent with the plain card edge, and lifts
          // to the white veil rather than to a tint of nothing.
          const chip: CSSProperties = {
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            flex: "none",
            maxWidth: "100%",
            border: `1px solid ${tone ? BORDERS[tone] || BORDERS.neutral : color.edge}`,
            background: tone ? TINTS[tone] || TINTS.neutral : "transparent",
            borderRadius: 999,
            padding: "7px 12px",
            font: `500 11.5px/1.3 ${font.body}`,
            color: ink,
            cursor: act ? "pointer" : "default",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            ...({
              "--hv-bg": tone ? HOVER_TINTS[tone] || HOVER_TINTS.neutral : token("hover-veil-strong"),
              "--hv-bd": tone ? HOVER_BORDERS[tone] || HOVER_BORDERS.neutral : token("hover-border"),
              // The tone never changes on hover — a control that looks like
              // something else on hover has lied about what it does.
              "--hv-fg": ink,
            } as CSSProperties),
          };

          function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            it.onClick?.();
          }

          return (
            <span
              key={i}
              style={chip}
              className={act ? "bk-control" : undefined}
              role={act ? "button" : undefined}
              tabIndex={act ? 0 : undefined}
              onClick={it.onClick}
              onKeyDown={act ? onKeyDown : undefined}
            >
              {it.icon ? <Icon icon={it.icon} size={12} color={ink} /> : null}
              {it.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
