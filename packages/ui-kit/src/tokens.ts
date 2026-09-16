/**
 * The design tokens as the components spell them: `var(--bk-x)`.
 *
 * Every `.dc.html` component opens with its own copy of the same tone table —
 * `C = { amber: '#e09f3e', … }` or `T = { amber: { fg, border, tint }, … }`.
 * The design's own port notes call those "the only colour literals worth
 * hoisting into a shared theme"; this is the hoist. Each component still keeps
 * its table, and the table still speaks the design's vocabulary (`amber`,
 * `teal`, `fg`, `border`, `tint`) — but every value in it comes from here.
 *
 * ── Why no `var(--bk-x, #fallback)` ──────────────────────────────────────
 *
 * A fallback looks free. It is not, and the reason is the light theme.
 *
 * A consumer who forgets the stylesheet gets, with a fallback, a page that
 * renders — in the DARK palette, whatever theme they asked for. That is a quiet
 * failure: it looks deliberate, it survives review, and it ships. Without the
 * fallback they get a colourless page, which is a loud failure that gets fixed
 * in minutes. Between a bug that announces itself and one that does not, take
 * the loud one.
 *
 * Two smaller reasons point the same way: a fallback puts every literal back
 * into the component bundle, and it masks a missing stylesheet rather than
 * reporting one.
 *
 * THE COST, AND IT IS REAL: `@schlessera/brain-ui-kit/styles.css` (or
 * `theme.css` into the consumer's own Tailwind v4 build) is MANDATORY, not
 * recommended. Without it every component renders with no colour at all — an
 * undefined custom property is not a wrong colour, it is no declaration.
 *
 * ── What the custom property buys ────────────────────────────────────────
 *
 * The design ships a full paper palette and is explicit that it is routed
 * "through custom properties on a `[data-theme]` root", so every component
 * inherits both themes. Hex baked into JavaScript cannot be switched by an
 * attribute — it would need a runtime theme context, which is heavier and
 * worse. The `--bk-` prefix is not decoration either: this is a published
 * package, and a consumer defining their own `--color-red` would otherwise
 * silently restyle the kit.
 *
 * THIS FILE IS THE ONLY PLACE IN `src/` THAT MAY CONTAIN A COLOUR LITERAL, and
 * the literals below are a MIRROR of `theme.css`, never a rendered value.
 * `tests/tokens-match-theme.test.ts` enforces both: that no other source file
 * has one, and that every value here matches the stylesheet in both directions.
 */

/**
 * Token name -> its dark value, which is also its fallback.
 *
 * Kept as data rather than as ~115 exported constants: it is what the test
 * compares against `theme.css`, and a table is a thing you can diff.
 */
export const TOKENS = {
  "color-canvas": "#0c0e12",
  "color-surface": "#141619",
  "color-raised": "#1a1d22",
  "color-line": "#1f2229",
  "color-edge": "#2a2d35",
  "color-ink": "#e8e4df",
  "color-ink-dim": "#c0bcb5",
  "color-ink-mute": "#8a8691",
  "color-amber": "#e09f3e",
  "color-gold": "#eab354",
  "color-teal": "#5bb5a2",
  "color-purple": "#b197d4",
  "color-blue": "#67b8e3",
  "color-red": "#f87171",
  "color-amber-lift": "#eab354",
  "color-teal-lift": "#7fd0be",
  "amber-ink": "#e09f3e",
  "amber-fill": "#e09f3e",
  "amber-mark": "#e09f3e",
  "gold-ink": "#eab354",
  "gold-fill": "#eab354",
  "gold-mark": "#eab354",
  "teal-ink": "#5bb5a2",
  "teal-fill": "#5bb5a2",
  "teal-mark": "#5bb5a2",
  "purple-ink": "#b197d4",
  "purple-fill": "#b197d4",
  "purple-mark": "#b197d4",
  "blue-ink": "#67b8e3",
  "blue-fill": "#67b8e3",
  "blue-mark": "#67b8e3",
  "red-ink": "#f87171",
  "red-fill": "#f87171",
  "red-mark": "#f87171",
  "neutral-ink": "#8a8691",
  "neutral-fill": "#8a8691",
  "neutral-mark": "#8a8691",
  "chip-border-amber": "rgba(224,159,62,0.4)",
  "chip-border-gold": "rgba(234,179,84,0.45)",
  "chip-border-teal": "rgba(91,181,162,0.4)",
  "chip-border-purple": "rgba(177,151,212,0.4)",
  "chip-border-blue": "rgba(103,184,227,0.4)",
  "chip-border-red": "rgba(248,113,113,0.4)",
  "chip-border-neutral": "#2a2d35",
  "chip-tint-amber": "rgba(224,159,62,0.1)",
  "chip-tint-gold": "rgba(234,179,84,0.1)",
  "chip-tint-teal": "rgba(91,181,162,0.1)",
  "chip-tint-purple": "rgba(177,151,212,0.09)",
  "chip-tint-blue": "rgba(103,184,227,0.09)",
  "chip-tint-red": "rgba(248,113,113,0.09)",
  "chip-tint-neutral": "rgba(255,255,255,0.04)",
  "surface-border-amber": "rgba(224,159,62,0.4)",
  "surface-border-gold": "rgba(234,179,84,0.45)",
  "surface-border-teal": "rgba(91,181,162,0.4)",
  "surface-border-purple": "rgba(177,151,212,0.4)",
  "surface-border-blue": "rgba(103,184,227,0.4)",
  "surface-border-red": "rgba(248,113,113,0.35)",
  "surface-border-neutral": "#1f2229",
  "surface-tint-amber": "rgba(224,159,62,0.05)",
  "surface-tint-gold": "rgba(234,179,84,0.05)",
  "surface-tint-teal": "rgba(91,181,162,0.06)",
  "surface-tint-purple": "rgba(177,151,212,0.06)",
  "surface-tint-blue": "rgba(103,184,227,0.06)",
  "surface-tint-red": "rgba(248,113,113,0.05)",
  "surface-tint-neutral": "#141619",
  "surface-hover-tint-amber": "rgba(224,159,62,0.09)",
  "surface-hover-tint-gold": "rgba(234,179,84,0.09)",
  "surface-hover-tint-teal": "rgba(91,181,162,0.1)",
  "surface-hover-tint-purple": "rgba(177,151,212,0.1)",
  "surface-hover-tint-blue": "rgba(103,184,227,0.1)",
  "surface-hover-tint-red": "rgba(248,113,113,0.09)",
  "surface-hover-tint-neutral": "var(--bk-color-raised)",
  "callout-border-amber": "rgba(224,159,62,0.3)",
  "callout-border-gold": "rgba(234,179,84,0.4)",
  "callout-border-teal": "rgba(91,181,162,0.4)",
  "callout-border-purple": "rgba(177,151,212,0.4)",
  "callout-border-blue": "rgba(103,184,227,0.4)",
  "callout-border-red": "rgba(248,113,113,0.35)",
  "callout-border-neutral": "#1f2229",
  "callout-tint-amber": "rgba(224,159,62,0.06)",
  "callout-tint-gold": "rgba(234,179,84,0.06)",
  "callout-tint-teal": "rgba(91,181,162,0.08)",
  "callout-tint-purple": "rgba(177,151,212,0.07)",
  "callout-tint-blue": "rgba(103,184,227,0.07)",
  "callout-tint-red": "rgba(248,113,113,0.06)",
  "callout-tint-neutral": "#141619",
  "placeholder-action-border-amber": "rgba(224,159,62,0.35)",
  "placeholder-action-border-gold": "rgba(234,179,84,0.35)",
  "placeholder-action-border-teal": "rgba(91,181,162,0.35)",
  "placeholder-action-border-purple": "rgba(177,151,212,0.35)",
  "placeholder-action-border-blue": "rgba(103,184,227,0.35)",
  "placeholder-action-border-red": "rgba(248,113,113,0.35)",
  "placeholder-action-border-neutral": "rgba(138,134,145,0.35)",
  "placeholder-error-tint": "rgba(248,113,113,0.05)",
  "placeholder-error-border": "rgba(248,113,113,0.35)",
  "button-border-danger": "rgba(248,113,113,0.35)",
  "button-tint-suggest": "rgba(224,159,62,0.06)",
  "button-border-suggest": "rgba(224,159,62,0.3)",
  "button-ink-on-solid": "rgba(12,14,18,0.62)",
  "button-effect-bg-on-solid": "rgba(12,14,18,0.18)",
  "button-hover-bg-primary": "var(--bk-color-amber-lift)",
  "button-hover-border-primary": "var(--bk-color-amber-lift)",
  "button-hover-fg-primary": "var(--bk-color-canvas)",
  "button-hover-bg-affirm": "var(--bk-color-teal-lift)",
  "button-hover-border-affirm": "var(--bk-color-teal-lift)",
  "button-hover-fg-affirm": "var(--bk-color-canvas)",
  "button-hover-bg-ghost": "var(--bk-color-raised)",
  "button-hover-border-ghost": "var(--bk-hover-border)",
  "button-hover-fg-ghost": "var(--bk-color-ink)",
  "button-hover-bg-quiet": "var(--bk-color-raised)",
  "button-hover-border-quiet": "var(--bk-hover-border)",
  "button-hover-fg-quiet": "var(--bk-color-ink-dim)",
  "button-hover-bg-danger": "rgba(248,113,113,0.1)",
  "button-hover-border-danger": "rgba(248,113,113,0.6)",
  "button-hover-fg-danger": "var(--bk-red-ink)",
  "button-hover-bg-suggest": "rgba(224,159,62,0.12)",
  "button-hover-border-suggest": "rgba(224,159,62,0.5)",
  "button-hover-fg-suggest": "var(--bk-amber-ink)",
  "hover-border": "#3a3e47",
  "focus-ring": "var(--bk-color-ink)",
  "hover-veil-soft": "rgba(255,255,255,0.03)",
  "hover-veil": "rgba(255,255,255,0.035)",
  "hover-veil-firm": "rgba(255,255,255,0.04)",
  "listrow-border-selected": "rgba(91,181,162,0.5)",
  "listrow-tint-selected": "rgba(91,181,162,0.08)",
  "choice-border-selected": "rgba(91,181,162,0.6)",
  "choice-tint-selected": "rgba(91,181,162,0.1)",
  "file-icon-open": "rgba(224,159,62,0.8)",
  "queue-border-blocked": "rgba(224,159,62,0.35)",
  "queue-tint-blocked": "rgba(224,159,62,0.04)",
  "queue-border-failed": "rgba(248,113,113,0.3)",
  "search-mark-bg": "rgba(224,159,62,0.22)",
  "action-tint-amber": "rgba(224,159,62,0.05)",
  "action-tint-gold": "rgba(234,179,84,0.05)",
  "action-tint-teal": "rgba(91,181,162,0.05)",
  "action-tint-red": "rgba(248,113,113,0.05)",
  "action-tint-neutral": "rgba(138,134,145,0.05)",
  "action-border-bold-amber": "rgba(224,159,62,0.4)",
  "action-border-bold-gold": "rgba(234,179,84,0.4)",
  "action-border-bold-teal": "rgba(91,181,162,0.4)",
  "action-border-bold-red": "rgba(248,113,113,0.4)",
  "action-border-bold-neutral": "rgba(138,134,145,0.4)",
  "action-border-tinted-amber": "rgba(224,159,62,0.35)",
  "action-border-tinted-gold": "rgba(234,179,84,0.35)",
  "action-border-tinted-teal": "rgba(91,181,162,0.35)",
  "action-border-tinted-red": "rgba(248,113,113,0.35)",
  "action-border-tinted-neutral": "rgba(138,134,145,0.35)",
  "action-border-dashed-amber": "rgba(224,159,62,0.45)",
  "action-border-dashed-gold": "rgba(234,179,84,0.45)",
  "action-border-dashed-teal": "rgba(91,181,162,0.45)",
  "action-border-dashed-red": "rgba(248,113,113,0.45)",
  "action-border-dashed-neutral": "rgba(138,134,145,0.45)",
  "ask-border-amber": "rgba(224,159,62,0.3)",
  "ask-border-teal": "rgba(91,181,162,0.3)",
  "ask-border-purple": "rgba(177,151,212,0.3)",
  "ask-head-amber": "rgba(224,159,62,0.85)",
  "ask-head-teal": "rgba(91,181,162,0.85)",
  "ask-head-purple": "rgba(177,151,212,0.85)",
  "notification-bg-rich": "rgba(26,29,34,0.92)",
  "notification-bg-compact": "rgba(20,22,25,0.9)",
  "notification-bg-dim": "rgba(20,22,25,0.72)",
  "inset-well-bg": "rgba(12,14,18,0.7)",
  "chip-count-ink": "#fff",
  "map-graticule": "rgba(91,181,162,0.13)",
  "map-sky-inner": "#101318",
  "map-sky-outer": "#0b0d11",
  "map-label-bg": "rgba(12,14,18,0.86)",
  "map-coord-bg": "rgba(12,14,18,0.6)",
  "map-halo": "rgba(12,14,18,0.8)",
  "map-scale-bar": "rgba(232,228,223,0.5)",
  "map-scale-cap": "rgba(232,228,223,0.8)",
  "map-land": "rgba(232,228,223,0.06)",
  "map-pin-ring-amber": "rgba(224,159,62,0.2)",
  "map-pin-ring-gold": "rgba(234,179,84,0.2)",
  "map-pin-ring-teal": "rgba(91,181,162,0.2)",
  "map-pin-ring-purple": "rgba(177,151,212,0.2)",
  "map-pin-ring-blue": "rgba(103,184,227,0.2)",
  "map-pin-ring-red": "rgba(248,113,113,0.2)",
  "map-pin-ring-neutral": "rgba(138,134,145,0.2)",
  "map-pin-border-amber": "rgba(224,159,62,0.35)",
  "map-pin-border-gold": "rgba(234,179,84,0.35)",
  "map-pin-border-teal": "rgba(91,181,162,0.35)",
  "map-pin-border-purple": "rgba(177,151,212,0.35)",
  "map-pin-border-blue": "rgba(103,184,227,0.35)",
  "map-pin-border-red": "rgba(248,113,113,0.35)",
  "map-pin-border-neutral": "rgba(138,134,145,0.35)",
  "step-rail-done": "rgba(91,181,162,0.4)",
  "step-bubble-tint-current": "rgba(224,159,62,0.14)",
  "schedule-tag-border-amber": "rgba(224,159,62,0.4)",
  "schedule-tag-border-gold": "rgba(234,179,84,0.4)",
  "schedule-tag-border-teal": "rgba(91,181,162,0.4)",
  "schedule-tag-border-purple": "rgba(177,151,212,0.4)",
  "schedule-tag-border-blue": "rgba(103,184,227,0.4)",
  "schedule-tag-border-red": "rgba(248,113,113,0.4)",
  "schedule-tag-border-neutral": "rgba(42,45,53,0.4)",
  "quote-tint-teal": "rgba(91,181,162,0.06)",
  "quote-tint-amber": "rgba(224,159,62,0.06)",
  "quote-tint-purple": "rgba(177,151,212,0.06)",
  "quote-tint-blue": "rgba(103,184,227,0.06)",
  "quote-tint-neutral": "rgba(138,134,145,0.06)",
  "provenance-border": "rgba(177,151,212,0.35)",
  "hatch-stripe": "#22262c",
  "avatar-tint-teal": "rgba(91,181,162,0.12)",
  "avatar-tint-blue": "rgba(103,184,227,0.12)",
  "avatar-tint-purple": "rgba(177,151,212,0.12)",
  "avatar-tint-amber": "rgba(224,159,62,0.12)",
  "avatar-tint-neutral": "rgba(138,134,145,0.12)",
  "avatar-border-teal": "rgba(91,181,162,0.35)",
  "avatar-border-blue": "rgba(103,184,227,0.35)",
  "avatar-border-purple": "rgba(177,151,212,0.35)",
  "avatar-border-amber": "rgba(224,159,62,0.35)",
  "avatar-border-neutral": "rgba(138,134,145,0.35)",
  "trend-track": "rgba(31,34,41,0.55)",
  "trend-bar-amber": "rgba(224,159,62,0.45)",
  "trend-bar-gold": "rgba(234,179,84,0.45)",
  "trend-bar-teal": "rgba(91,181,162,0.45)",
  "trend-bar-purple": "rgba(177,151,212,0.45)",
  "trend-bar-blue": "rgba(103,184,227,0.45)",
  "trend-bar-red": "rgba(248,113,113,0.45)",
  "trend-bar-neutral": "rgba(138,134,145,0.45)",
  "suggestion-border-teal": "rgba(91,181,162,0.3)",
  "suggestion-border-amber": "rgba(224,159,62,0.3)",
  "suggestion-border-purple": "rgba(177,151,212,0.3)",
  "suggestion-border-blue": "rgba(103,184,227,0.3)",
  "suggestion-border-neutral": "rgba(192,188,181,0.3)",
  "suggestion-tint-teal": "rgba(91,181,162,0.05)",
  "suggestion-tint-amber": "rgba(224,159,62,0.05)",
  "suggestion-tint-purple": "rgba(177,151,212,0.05)",
  "suggestion-tint-blue": "rgba(103,184,227,0.05)",
  "suggestion-tint-neutral": "rgba(192,188,181,0.05)",
  "suggestion-hover-tint-teal": "rgba(91,181,162,0.12)",
  "suggestion-hover-tint-amber": "rgba(224,159,62,0.12)",
  "suggestion-hover-tint-purple": "rgba(177,151,212,0.12)",
  "suggestion-hover-tint-blue": "rgba(103,184,227,0.12)",
  "suggestion-hover-tint-neutral": "rgba(192,188,181,0.12)",
  "suggestion-hover-border-teal": "rgba(91,181,162,0.5)",
  "suggestion-hover-border-amber": "rgba(224,159,62,0.5)",
  "suggestion-hover-border-purple": "rgba(177,151,212,0.5)",
  "suggestion-hover-border-blue": "rgba(103,184,227,0.5)",
  "suggestion-hover-border-neutral": "rgba(192,188,181,0.5)",
  "hover-veil-strong": "rgba(255,255,255,0.05)",
  "attach-thumb-tint-teal": "rgba(91,181,162,0.08)",
  "attach-thumb-tint-amber": "rgba(224,159,62,0.08)",
  "attach-thumb-tint-purple": "rgba(177,151,212,0.08)",
  "attach-thumb-tint-blue": "rgba(103,184,227,0.08)",
  "attach-thumb-tint-neutral": "rgba(138,134,145,0.08)",
  "attach-thumb-border-teal": "rgba(91,181,162,0.19)",
  "attach-thumb-border-amber": "rgba(224,159,62,0.19)",
  "attach-thumb-border-purple": "rgba(177,151,212,0.19)",
  "attach-thumb-border-blue": "rgba(103,184,227,0.19)",
  "attach-thumb-border-neutral": "rgba(138,134,145,0.19)",
  "toast-border-teal": "rgba(91,181,162,0.4)",
  "toast-border-amber": "rgba(224,159,62,0.4)",
  "toast-border-purple": "rgba(177,151,212,0.4)",
  "toast-border-red": "rgba(248,113,113,0.35)",
  "toast-border-neutral": "#2a2d35",
  "toast-tint-teal": "rgba(91,181,162,0.08)",
  "toast-tint-amber": "rgba(224,159,62,0.07)",
  "toast-tint-purple": "rgba(177,151,212,0.07)",
  "toast-tint-red": "rgba(248,113,113,0.06)",
  "toast-tint-neutral": "#141619",
  "compare-recommended-head": "rgba(91,181,162,0.08)",
  "compare-recommended-cell": "rgba(91,181,162,0.06)",
  "medallion-tint-amber": "rgba(224,159,62,0.08)",
  "medallion-tint-gold": "rgba(234,179,84,0.08)",
  "medallion-tint-teal": "rgba(91,181,162,0.08)",
  "medallion-tint-purple": "rgba(177,151,212,0.08)",
  "medallion-tint-red": "rgba(248,113,113,0.08)",
  "medallion-tint-neutral": "rgba(138,134,145,0.08)",
  "medallion-border-amber": "rgba(224,159,62,0.24)",
  "medallion-border-gold": "rgba(234,179,84,0.24)",
  "medallion-border-teal": "rgba(91,181,162,0.24)",
  "medallion-border-purple": "rgba(177,151,212,0.24)",
  "medallion-border-red": "rgba(248,113,113,0.24)",
  "medallion-border-neutral": "rgba(138,134,145,0.24)",

  /* Wave 4 — agent views, chrome, desktop. See `theme.css` for the reasoning
   * next to each family; this table is its mirror, never a rendered value. */
  "orbit-border-running": "var(--bk-chip-border-amber)",
  "orbit-border-waiting": "rgba(91,181,162,0.45)",
  "orbit-border-done": "var(--bk-color-edge)",
  "orbit-border-failed": "var(--bk-surface-border-red)",
  "orbit-ring-inner": "rgba(224,159,62,0.14)",
  "orbit-ring-mid": "rgba(224,159,62,0.2)",
  "orbit-ring-outer": "rgba(224,159,62,0.1)",
  "orbit-glow": "rgba(224,159,62,0.09)",
  "lane-hatch-amber": "rgba(224,159,62,0.5)",
  "lane-hatch-gold": "rgba(234,179,84,0.5)",
  "lane-hatch-teal": "rgba(91,181,162,0.5)",
  "lane-hatch-purple": "rgba(177,151,212,0.5)",
  "lane-hatch-blue": "rgba(103,184,227,0.5)",
  "lane-hatch-red": "rgba(248,113,113,0.5)",
  "lane-hatch-neutral": "rgba(138,134,145,0.5)",
  "lane-fade-amber": "rgba(224,159,62,0.55)",
  "lane-fade-gold": "rgba(234,179,84,0.55)",
  "lane-fade-teal": "rgba(91,181,162,0.55)",
  "lane-fade-purple": "rgba(177,151,212,0.55)",
  "lane-fade-blue": "rgba(103,184,227,0.55)",
  "lane-fade-red": "rgba(248,113,113,0.55)",
  "lane-fade-neutral": "rgba(138,134,145,0.55)",
  "graph-canvas-bg": "#0e1014",
  "graph-node-focus-tint": "rgba(224,159,62,0.14)",
  "composer-voice-glow": "rgba(224,159,62,0.35)",
  "rail-bg": "#101216",
  "rail-tint-active": "rgba(224,159,62,0.1)",
  "rail-tint-active-hover": "rgba(224,159,62,0.14)",
  "palette-tint-selected": "rgba(224,159,62,0.09)",
  "palette-tint-selected-hover": "rgba(224,159,62,0.12)",
  "palette-foot-bg": "rgba(12,14,18,0.5)",
  "palette-shadow": "rgba(0,0,0,0.55)",
} as const;

export type TokenName = keyof typeof TOKENS;

/**
 * `var(--bk-<name>)` — how every colour reaches the DOM.
 *
 * Deliberately no fallback. The argument is typed, so the name is checked; the
 * VALUE comes from the stylesheet and nowhere else, which is what makes a theme
 * swap total rather than partial.
 */
export function token(name: TokenName): string {
  return `var(--bk-${name})`;
}

/**
 * Backgrounds, rules and the ink ramp.
 *
 * `line` is the hairline INSIDE a card; `edge` is the card's own border. Ink
 * never comes from alpha — hierarchy is weight and size, and these three are
 * the only source of it, because alpha-muted ink drops 9-12px type under
 * 4.5:1.
 */
export const color = {
  canvas: token("color-canvas"),
  surface: token("color-surface"),
  raised: token("color-raised"),
  line: token("color-line"),
  edge: token("color-edge"),
  ink: token("color-ink"),
  inkDim: token("color-ink-dim"),
  inkMute: token("color-ink-mute"),
  /** Teal one step up: the meter gradient's lighter stop, and `affirm`'s hover
   * fill. Every other tone lifts to `gold`, which already has a name. */
  tealLift: token("color-teal-lift"),
} as const;

/**
 * The accents, by the job the colour is doing.
 *
 * In the dark theme all three are the same value, because an accent chosen to
 * glow against `#0c0e12` works as text, as a fill and as a 7px dot alike. On
 * paper they diverge, which is why the call sites below pick a role rather than
 * "the amber one":
 *
 *   ink   text, icons, borders
 *   fill  solid surfaces that take near-black text on top
 *   mark  6-8px marks, where a darkened accent would read black
 *
 * Choosing the wrong one costs nothing today and breaks the light theme later,
 * which is exactly the kind of mistake worth making impossible early.
 */
export const accent = {
  amber: { ink: token("amber-ink"), fill: token("amber-fill"), mark: token("amber-mark") },
  gold: { ink: token("gold-ink"), fill: token("gold-fill"), mark: token("gold-mark") },
  teal: { ink: token("teal-ink"), fill: token("teal-fill"), mark: token("teal-mark") },
  purple: { ink: token("purple-ink"), fill: token("purple-fill"), mark: token("purple-mark") },
  blue: { ink: token("blue-ink"), fill: token("blue-fill"), mark: token("blue-mark") },
  red: { ink: token("red-ink"), fill: token("red-fill"), mark: token("red-mark") },
  neutral: { ink: token("neutral-ink"), fill: token("neutral-fill"), mark: token("neutral-mark") },
} as const;

/**
 * The three families, each with one job: DM Serif Text for titles, Plus Jakarta
 * Sans for body and labels, JetBrains Mono for paths, states and effects.
 *
 * Literals rather than `var(--font-*)`: they go into the `font` shorthand,
 * which is already doing four things, and they are not a theming axis — a light
 * theme changes colour, not typeface.
 *
 * The source spells the mono stack two ways (`'JetBrains Mono',monospace` and
 * `'JetBrains Mono',ui-monospace,monospace`). Normalised to the longer form;
 * the first family is identical, so the rendered result is too.
 */
export const font = {
  display: "'DM Serif Text',Georgia,serif",
  body: "'Plus Jakarta Sans',sans-serif",
  mono: "'JetBrains Mono',ui-monospace,monospace",
} as const;
