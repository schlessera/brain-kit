import type { CSSProperties, KeyboardEvent } from "react";

import { warnOnce } from "../internal/dev.js";
import { Chip } from "../primitives/Chip.js";
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
 *
 * **Cost and unavailability are printed, never hovered** (D52 §2). `cost` is
 * a gold effect chip after the label; a `disabled` chip keeps it, dims only
 * its label and icon, and prints `why` after them in mono. Neither appears
 * unless the caller passes it, so an existing chip renders exactly as before.
 * A chip with a cost or a reason wraps instead of ellipsising: a clipped cost
 * or reason is not an honest one.
 *
 * Under a coarse pointer every interactive chip is at least 44px tall
 * (`.bk-suggestion`, D52 §7). The 7px gap stays, so neighbouring targets
 * never overlap.
 */
export interface SuggestionItem {
  label: string;
  icon?: IconName;
  tone?: SuggestionTone;
  onClick?: () => void;
  /**
   * What running the chip costs, printed on it at rest as a gold effect chip
   * (`spends`, D38 §5). The caller's own word: the kit never estimates one,
   * and a chip that cannot spend passes nothing.
   */
  cost?: string;
  /**
   * The chip cannot run now. It stays focusable and announced
   * (`aria-disabled`), keeps its `cost`, and ignores taps, clicks, Enter and
   * Space. Pair it with `why`.
   */
  disabled?: boolean;
  /**
   * Why a disabled chip cannot run (`needs the host`), printed on the chip
   * after its label rather than in a tooltip. Ignored while enabled.
   */
  why?: string;
}

export interface SuggestionChipsProps {
  /** The uppercase mono line above the row. */
  label?: string;
  items?: SuggestionItem[];
  /** Wrap to a second line. On by default; off enables native horizontal scrolling. */
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
        className={p.wrap === false ? "bk-scroll-x" : undefined}
        tabIndex={p.wrap === false ? 0 : undefined}
        role={p.wrap === false ? "region" : undefined}
        aria-label={p.wrap === false ? (p.label || "Next") : undefined}
        style={{
          display: "flex",
          flexWrap: p.wrap === false ? "nowrap" : "wrap",
          gap: 7,
          overflowX: p.wrap === false ? "auto" : "hidden",
          ...(p.wrap === false ? { padding: 4 } : {}),
        }}
      >
        {src.map((it, i) => {
          const tone = it.tone;
          const ink = tone ? INKS[tone] || color.inkDim : color.inkDim;
          const off = it.disabled === true;
          // A disabled chip is still a control: it is the chip a user would
          // tap, and it has to be reachable to announce why it cannot run.
          const act = Boolean(it.onClick) || off;
          const why = off && it.why ? it.why : undefined;
          // The PRESENCE of a tone is what makes a chip toned, not its value:
          // an untoned chip is transparent with the plain card edge, and lifts
          // to the white veil rather than to a tint of nothing.
          const chip: CSSProperties = {
            display: "inline-flex",
            alignItems: "center",
            // Longhands only, with rowGap always set: a chip whose reason
            // comes and goes on a rerender would otherwise drop a rowGap
            // beside a `gap` shorthand, which React refuses to reconcile.
            columnGap: 6,
            rowGap: why || it.cost ? 3 : 6,
            flex: "none",
            maxWidth: p.wrap === false && !why && !it.cost ? undefined : "100%",
            border: `1px solid ${tone ? BORDERS[tone] || BORDERS.neutral : color.edge}`,
            background: tone ? TINTS[tone] || TINTS.neutral : "transparent",
            borderRadius: 999,
            padding: "7px 12px",
            font: `500 11.5px/1.3 ${font.body}`,
            color: ink,
            cursor: off ? "not-allowed" : act ? "pointer" : "default",
            // A chip that prints a cost or a reason wraps rather than clips:
            // the label's text cannot shrink, so an ellipsis would push the
            // printed word past the clipped edge first.
            ...(why || it.cost
              ? { flexWrap: "wrap", whiteSpace: "normal", overflowWrap: "anywhere" }
              : { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }),
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
            if (!off) it.onClick?.();
          }

          const glyph = it.icon ? <Icon icon={it.icon} size={12} color={ink} /> : null;
          return (
            <span
              key={i}
              style={chip}
              className={off ? "bk-suggestion" : act ? "bk-control bk-suggestion" : undefined}
              role={act ? "button" : undefined}
              tabIndex={act ? 0 : undefined}
              aria-disabled={off ? true : undefined}
              onClick={off ? undefined : it.onClick}
              onKeyDown={act ? onKeyDown : undefined}
            >
              {off ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, opacity: 0.45 }}>
                  {glyph}
                  {it.label}
                </span>
              ) : (
                <>
                  {glyph}
                  {it.label}
                </>
              )}
              {it.cost ? <Chip variant="effect" tone="gold" label={it.cost} /> : null}
              {why ? (
                <span style={{ font: `500 10px/1.3 ${font.mono}`, color: color.inkMute }}>{why}</span>
              ) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}
