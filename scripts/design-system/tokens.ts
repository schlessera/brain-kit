/**
 * `tokens.json` for the Brain Kit Design System artifact, read from the kit's
 * own stylesheet rather than restated.
 *
 * `packages/ui-kit/src/tokens.css` declares every `--bk-*` colour once in
 * `:root` as `light-dark(<paper>, <dark>)` and re-declares the ones Print
 * changes under `[data-theme="print"]`. Each becomes one colour token with a
 * value per theme, named exactly as the variable (minus `--`), so the
 * artifact's compiled `tokens.css` and the kit's `bundle.css` define the same
 * custom properties and the theme switch drives the real components.
 *
 * The type, spacing and radius scales mirror `packages/ui-kit/src/theme.css`.
 * The body and mono text styles are the most-used `font` shorthands in the
 * kit's components; the kit itself states only their ranges.
 */

export type ThemeValues = { dark: string; light: string; print: string };
export interface ParsedToken {
  name: string;
  section: string;
  value: ThemeValues;
}

/** Splits `light-dark(a, b)` on its top-level comma. */
function splitLightDark(value: string): [string, string] | null {
  const m = /^light-dark\((.*)\)$/.exec(value.trim());
  if (!m) return null;
  let depth = 0;
  for (let i = 0; i < m[1].length; i++) {
    const c = m[1][i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) return [m[1].slice(0, i).trim(), m[1].slice(i + 1).trim()];
  }
  return null;
}

/** A CSS colour as the artifact's grammar accepts it, or undefined. */
export function toArtifactColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const alias = /^var\(--(bk-[a-z0-9-]+)\)$/.exec(value);
  if (alias) return `{${alias[1]}}`;
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value.toLowerCase();
  if (/^(rgba?|hsla?)\([0-9.,\s%]+\)$/.test(value)) return value.replace(/\s+/g, "");
  // The grammar refuses named colours; transparent is black at zero alpha.
  if (value === "transparent") return "#00000000";
  return undefined;
}

/** Every colour `--bk-*` in `:root`, outside the separate layer fence, with its Print override. */
export function parseTokensCss(css: string): { tokens: ParsedToken[]; skipped: string[] } {
  type Raw = { name: string; section: string; dark: string; light: string; print?: string };
  const raw = new Map<string, Raw>();
  let section = "";
  let block: "root" | "print" | "other" | null = null;
  let depth = 0;
  let inComment = false;
  let inLayers = false;

  for (const source of css.split("\n")) {
    const line = source.trim();
    // D54's numeric layer scale has its own reader and is not colour data.
    if (line === "/* @layers:start */") { inLayers = true; continue; }
    if (line === "/* @layers:end */") { inLayers = false; continue; }
    if (inLayers) continue;
    if (!inComment && line.startsWith("/*")) {
      inComment = !line.includes("*/");
      const heading = /\/\* ── (.+?) ─/.exec(line);
      if (heading && depth === 1 && block === "root") section = heading[1].trim();
      continue;
    }
    if (inComment) {
      if (line.includes("*/")) inComment = false;
      continue;
    }
    if (depth === 0 && line.endsWith("{")) {
      const selector = line.slice(0, -1).trim();
      block = selector === ":root" ? "root" : selector === '[data-theme="print"]' ? "print" : "other";
    }
    for (const c of line) {
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    if (depth === 0) block = null;
    const decl = /^--(bk-[a-z0-9-]+):\s*(.+);$/.exec(line);
    if (!decl || depth !== 1) continue;
    const [, name, value] = decl;
    if (block === "root" && !raw.has(name)) {
      const pair = splitLightDark(value);
      raw.set(name, { name, section, light: pair ? pair[0] : value, dark: pair ? pair[1] : value });
    } else if (block === "print") {
      const t = raw.get(name);
      if (t) t.print = value;
    }
  }

  const tokens: ParsedToken[] = [];
  const skipped: string[] = [];
  for (const t of raw.values()) {
    const dark = toArtifactColor(t.dark);
    const light = toArtifactColor(t.light);
    const print = toArtifactColor(t.print ?? t.light);
    if (!dark && !light) {
      skipped.push(`${t.name}: ${t.dark}`);
      continue;
    }
    tokens.push({
      name: t.name,
      section: t.section,
      value: { dark: dark ?? light!, light: light ?? dark!, print: print ?? light ?? dark! },
    });
  }
  return { tokens, skipped };
}

const MEANS: Record<string, string> = {
  amber: "the agent: work in flight, a permission it asks for, the one primary action",
  gold: "caution: staleness, an unverified premise, retries",
  teal: "your turn: your choices, safe outcomes, files and people",
  purple: "provenance: untrusted origin, subagent work, projects",
  blue: "companies and T1 triage",
  red: "failure: dead letters, quarantine, destructive paths, overdue",
  neutral: "the grey accent for machine meta",
};

const FOUNDATION: Record<string, string> = {
  "bk-color-canvas": "Page ground behind everything; the darkest step. Also the ink on amber and teal lift hovers.",
  "bk-color-surface": "Cards, sheets and panels on canvas: one step up.",
  "bk-color-raised": "Hover lift, insets, wells and selected filter tabs: two steps up.",
  "bk-color-line": "Inert hairlines: dividers and card rules that are not tappable.",
  "bk-color-edge": "Rails and control borders; the hairline a tappable thing carries.",
  "bk-color-ink": "Primary text on canvas, surface and raised, and the 2px focus ring. Never `neutral`.",
  "bk-color-ink-dim": "Secondary text on canvas, surface and raised; the fallback for an unlisted tone.",
  "bk-color-ink-mute": "Machine meta (the floor of the ink ramp): mono states, timestamps, counts. 4.8:1 on the worst tint.",
  "bk-color-amber": "Amber text and icons: the agent. Paper darkens it to pass.",
  "bk-color-gold": "Gold text and icons: caution, staleness, retries.",
  "bk-color-teal": "Teal text and icons: your turn, safe outcomes.",
  "bk-color-purple": "Purple text and icons: provenance, untrusted origin, subagents.",
  "bk-color-blue": "Blue text and icons: companies, T1 triage.",
  "bk-color-red": "Red text and icons: failure, danger, overdue.",
  "bk-color-amber-lift": "Primary button hover: amber one step up. Not gold, though equal today.",
  "bk-color-teal-lift": "Affirm button hover: teal one step up.",
  "bk-on-fill": "Text and icons ON any solid `*-fill` (buttons, badges, the send disc), weight 500+. Never white.",
  "bk-on-ink-solid": "Text on a small disc filled with an accent INK (selected choice mark, done step bubble).",
};

/** A usage note for every token: written for the foundations, derived from the name for component tokens. */
export function usageFor(token: ParsedToken): string {
  if (FOUNDATION[token.name]) return FOUNDATION[token.name];
  const n = token.name.replace(/^bk-/, "");
  const accent = /^(amber|gold|teal|purple|blue|red|neutral)-(ink|fill|mark)$/.exec(n);
  if (accent) {
    const role = { ink: "Text, icons and borders", fill: "Solid surfaces that take `bk-on-fill` text", mark: "6–8px marks such as status dots" }[
      accent[2] as "ink" | "fill" | "mark"
    ];
    return `${role} in ${accent[1]}: ${MEANS[accent[1]]}.`;
  }
  const tone = Object.keys(MEANS).find((t) => n.endsWith(`-${t}`));
  const base = tone ? n.slice(0, -(tone.length + 1)) : n;
  const part = base.split("-").join(" ");
  const kind = /tint/.test(base) ? "background tint" : /border|ring/.test(base) ? "border" : /fg|ink|text/.test(base) ? "text" : /bg|fill/.test(base) ? "fill" : "colour";
  const where = token.section.replace(/^Wave \d[a-z]?: /, "");
  return `${part[0].toUpperCase()}${part.slice(1)} (${kind})${tone ? `, ${tone} tone` : ""}. Component token from "${where}"; use the component, not the value.`;
}

/** The whole `tokens.json` object. `ref` is `<branch>@<short sha>` of the source. */
export function buildTokensJson(tokens: ParsedToken[], ref: string, synced: string) {
  return {
    name: "Brain Kit",
    version: 1,
    meta: {
      source: "github",
      repo: "schlessera/brain-kit",
      ref,
      package: "packages/ui-kit",
      paths: {
        tokens: ["packages/ui-kit/src/tokens.css", "packages/ui-kit/src/theme.css"],
        docs: ["packages/ui-kit/README.md", "packages/ui-kit/src (doc comments)", "scripts/design-system/content/README.md"],
      },
      synced,
    },
    color: {
      themes: [
        { id: "dark", name: "Dark" },
        { id: "light", name: "Paper" },
        { id: "print", name: "Print" },
      ],
      tokens: tokens.map((t) => ({ name: t.name, value: t.value, usage: usageFor(t) })),
    },
    type: {
      fonts: [],
      families: {
        display: '"DM Serif Text", Georgia, serif',
        body: '"Plus Jakarta Sans", system-ui, sans-serif',
        mono: '"JetBrains Mono", ui-monospace, monospace',
      },
      groups: [
        {
          name: "Titles",
          family: "display",
          styles: [
            { name: "title-2xl", fontSize: "29px", fontWeight: 400, usage: "Largest screen title.", sample: "Morning, Odysseus" },
            { name: "title-xl", fontSize: "26px", fontWeight: 400, usage: "Screen title.", sample: "Weekly review" },
            { name: "title-lg", fontSize: "24px", fontWeight: 400, usage: "Sheet title.", sample: "Pass Scylla" },
            { name: "title-md", fontSize: "22px", fontWeight: 400, usage: "Stat values and large card titles.", sample: "12 of 14" },
            { name: "title", fontSize: "19px", fontWeight: 400, usage: "Card title.", sample: "Raft manifest" },
            { name: "title-sm", fontSize: "17px", fontWeight: 400, usage: "Smallest serif; never below this, and never serif for anything but a title.", sample: "Ithaca" },
          ],
        },
        {
          name: "Body",
          family: "body",
          styles: [
            { name: "prose", fontSize: "13.5px", lineHeight: 1.7, fontWeight: 400, usage: "Long-form answer prose.", sample: "Tie me to the mast before the Sirens." },
            { name: "body", fontSize: "13px", lineHeight: 1.55, fontWeight: 400, usage: "Default body copy.", sample: "Circe warned of the strait." },
            { name: "row-title", fontSize: "12.5px", lineHeight: 1.35, fontWeight: 600, usage: "Row and card titles; the most-used body style.", sample: "Raft manifest" },
            { name: "label", fontSize: "12px", lineHeight: 1, fontWeight: 500, usage: "Control labels and buttons.", sample: "Approve" },
            { name: "body-sm", fontSize: "11.5px", lineHeight: 1.55, fontWeight: 400, usage: "Secondary copy under a title.", sample: "Six of the crew, and the ship survives" },
            { name: "caption", fontSize: "11px", lineHeight: 1.5, fontWeight: 400, usage: "Captions and footnotes.", sample: "From the log, day 1042" },
          ],
        },
        {
          name: "Mono",
          family: "mono",
          styles: [
            { name: "mono", fontSize: "11px", lineHeight: 1.5, fontWeight: 500, usage: "Paths, hashes, money. Machine fact only.", sample: "notes/voyage/sirens.md" },
            { name: "meta", fontSize: "10px", lineHeight: 1.4, fontWeight: 500, usage: "Meta lines and effect chips in `bk-color-ink-mute`.", sample: "queued 09:41 · stops after 24 h" },
            { name: "section-label", fontSize: "9.5px", lineHeight: 1, fontWeight: 600, letterSpacing: "0.09em", usage: "Uppercase section label in `bk-color-ink-mute`; the Label component's default.", sample: "NEEDS YOUR INPUT" },
            { name: "mono-xs", fontSize: "9px", lineHeight: 1.3, fontWeight: 600, usage: "The floor: nothing renders below 9px.", sample: "T1" },
          ],
        },
      ],
    },
    spacing: {
      note: "Not a 4px grid, on purpose. Gaps: 7–9 inside cards, 10–12 between cards, 14–18 between groups. Pick from the set; never round to the nearest four.",
      tokens: (
        [
          [2, "Hairline offsets."],
          [4, "Icon-to-text in chips."],
          [6, "Tight stacks inside a row."],
          [8, "Gap inside cards (low end)."],
          [10, "Gap between cards (low end)."],
          [12, "Gap between cards; card padding on phones."],
          [14, "Gap between groups (low end); card padding."],
          [16, "Phone gutter; panel padding."],
          [18, "Gap between groups (high end)."],
          [20, "Sheet padding."],
          [26, "Screen section breaks."],
        ] as const
      ).map(([v, usage]) => ({ name: `spacing-${v}`, value: `${v}px`, usage })),
    },
    radius: {
      note: "The smaller the thing, the tighter the corner. Three steps are ranges and both ends ship.",
      tokens: (
        [
          ["radius-chip", 5, "Chips and effect tags."],
          ["radius-inset", 8, "Insets, wells, code blocks."],
          ["radius-option-tight", 11, "Option rows (low end)."],
          ["radius-option", 12, "Option rows and inputs."],
          ["radius-card-tight", 13, "Cards (low end)."],
          ["radius-card", 14, "Cards."],
          ["radius-panel-tight", 16, "Panels (low end)."],
          ["radius-panel", 18, "Panels and the composer."],
          ["radius-sheet", 26, "Bottom sheets."],
          ["radius-device", 42, "Phone frame."],
          ["radius-pill", 999, "Pills, discs and toggles."],
        ] as const
      ).map(([name, v, usage]) => ({ name, value: `${v}px`, usage })),
    },
  };
}
