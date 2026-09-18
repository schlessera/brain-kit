import { useId, type CSSProperties, type KeyboardEvent } from "react";

import { warnOnce } from "../internal/dev.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * The desktop's real navigation, behind ⌘K.
 *
 * Two rules carry over from the rest of the kit, and neither is styling:
 *
 *   **Anything that writes shows its effect chip right in the row**, so a
 *   palette can never run something the user did not agree to. The chip is also
 *   part of the row's accessible name — `"Fix the seat count, enqueue"` — which
 *   is the design's own non-negotiable ("a control that writes exposes its
 *   effect chip as part of its accessible name"). A row with an `effect` and no
 *   chip would be the single worst bug this component could ship, so the chip
 *   is not conditional on anything but the effect existing.
 *
 *   **Results are grouped by WHAT THEY ARE** — go somewhere, ask something, run
 *   something — rather than ranked into one undifferentiated list, because
 *   "jump to a file" and "spend money on my behalf" are not comparable results.
 *
 * ## Keys, and which of them a presentational component can own
 *
 * The design's table says ⌘K · ↑↓ · esc. **⌘K is not here**, and cannot be: it
 * opens the palette, and a component that is not mounted cannot listen for it.
 * That belongs to whatever decides the palette is open. ↑↓ and esc are here,
 * both gated on the callback that makes them mean something — `onSelect` and
 * `onClose`. Without those, the palette is the picture the design draws.
 *
 * The query is display text, not an input: unlike {@link Composer}, whose own
 * README asks for a real `<textarea>`, the design says nothing of the sort here
 * and the caret is drawn rather than real. Wiring it is the app's job.
 */
export interface PaletteItem {
  label: string;
  icon?: IconName;
  tone?: Tone;
  /** What running this WRITES. Its presence is what makes the row a write. */
  effect?: string;
  /** The key shown when this row is selected. Defaults to ⏎. */
  shortcut?: string;
  onClick?: () => void;
}

export interface PaletteGroup {
  label: string;
  items: PaletteItem[];
}

export interface CommandPaletteProps {
  /** What has been typed. Display text — the caret is drawn, not real. */
  query?: string;
  groups?: PaletteGroup[];
  /** Index of the selected row, counted across all groups. */
  selected?: number;
  /** Corpus size and query time, bottom right. */
  footMeta?: string;
  /**
   * The key legend, bottom left. Defaults to the design's line, which
   * includes ⌘⏎; an app that does not bind ⌘⏎ passes its own, because a
   * printed key that does nothing is what the design's "every shortcut is
   * printed where it applies" forbids.
   */
  footHint?: string;
  maxHeight?: number;
  /** ↑↓. Receives the new flat index. Without it the arrows do nothing. */
  onSelect?: (index: number) => void;
  /** esc. */
  onClose?: () => void;
}

const INKS: Record<Tone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
};

/** The source's fallback names a real airline, a plausible real person and a
 * real city used as a client. All three are replaced per D19; the shape is the
 * design's exactly — two jumps, one question, two writes, both with effects. */
const FALLBACK: PaletteGroup[] = [
  {
    label: "Jump to",
    items: [
      { icon: "file", label: "knowledge/scylla.md", tone: "teal", shortcut: "⏎" },
      { icon: "thread", label: "Route home · thread", tone: "blue" },
    ],
  },
  { label: "Ask", items: [{ icon: "ask", label: "What did I promise Penelope?", tone: "neutral" }] },
  {
    label: "Run",
    items: [
      { icon: "edit", label: "Fix the crew count in day-1043-strait", tone: "amber", effect: "enqueue" },
      { icon: "retry", label: "Re-index knowledge/", tone: "neutral", effect: "reindex" },
    ],
  },
];

export function CommandPalette(p: CommandPaletteProps) {
  if (p.groups && !Array.isArray(p.groups)) warnOnce("CommandPalette: `groups` is not an array; no rows will render.");
  const src = p.groups || FALLBACK;
  const sel = Number(p.selected ?? 0);
  const baseId = useId();
  const anyInteractive = src.some((g) => (g.items || []).some((it) => Boolean(it.onClick)));

  /** esc, wherever focus is inside the dialog. */
  function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !p.onClose) return;
    event.preventDefault();
    p.onClose();
  }

  /**
   * ↑↓ on a row, which is where FilterRow and ChoiceOption put theirs.
   *
   * SELECTION follows focus and ACTIVATION does not — the opposite half of the
   * choice `FilterRow` made, and for the opposite reason: arrowing through
   * filters *is* filtering, while arrowing through a palette must never run
   * anything. So each arrow moves the DOM focus AND reports the new index, and
   * only ⏎ or a click calls the row's own callback.
   */
  function onRowKeyDown(event: KeyboardEvent<HTMLDivElement>, item: PaletteItem) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      item.onClick?.();
      return;
    }
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    const edge = event.key === "Home" ? "first" : event.key === "End" ? "last" : null;
    if (delta === 0 && !edge) return;
    event.preventDefault();
    const box = event.currentTarget.closest('[role="dialog"]');
    const rows = [...(box?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const here = rows.indexOf(event.currentTarget);
    if (here === -1 || rows.length < 2) return;
    // Home / End land on the edges (design-feedback §11, answered).
    const next = edge === "first" ? 0 : edge === "last" ? rows.length - 1 : (here + delta + rows.length) % rows.length;
    // The tab stop is the SELECTED row, so it has to move before focus does.
    p.onSelect?.(next);
    rows[next].tabIndex = 0;
    rows[next].focus();
  }

  const box: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    background: color.surface,
    border: `1px solid ${color.edge}`,
    borderRadius: 16,
    overflow: "hidden",
    boxShadow: `0 24px 60px ${token("palette-shadow")}`,
  };
  const keyCap: CSSProperties = {
    flex: "none",
    border: `1px solid ${color.edge}`,
    borderRadius: 5,
    padding: "3px 6px",
    font: `500 9.5px/1 ${font.mono}`,
    color: color.inkMute,
  };
  const footText: CSSProperties = { font: `400 9.5px/1.4 ${font.mono}`, color: color.inkMute };

  let idx = -1;

  return (
    <div style={box} role="dialog" aria-label="Command palette" onKeyDown={onDialogKeyDown}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "13px 14px",
          borderBottom: `1px solid ${color.line}`,
        }}
      >
        <Icon icon="search" size={16} color={color.inkMute} />
        <span style={{ flex: 1, minWidth: 0, font: `400 14px/1.2 ${font.body}`, color: color.ink }}>
          {p.query ?? "scylla"}
          <span
            style={{
              display: "inline-block",
              width: 1.5,
              height: 15,
              marginLeft: 2,
              verticalAlign: "text-bottom",
              // A 1.5px bar is a MARK, not text: at that width a darkened
              // accent reads black on paper, which is what `mark` exists for.
              background: accent.amber.mark,
            }}
          />
        </span>
        <span style={keyCap}>esc</span>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          paddingBottom: 6,
          maxHeight: Number(p.maxHeight) || 320,
          overflow: "hidden",
        }}
        // A `role="option"` outside a listbox announces neither the set nor the
        // position in it. The list element is this component's own, so it
        // renders the container — the same call wave 2 made for `FilterRow`'s
        // tablist and `AskUserCard`'s radiogroup.
        role={anyInteractive ? "listbox" : undefined}
        aria-label={anyInteractive ? "Results" : undefined}
      >
        {src.map((g, gi) => {
          const labelId = `${baseId}-g${gi}`;
          return (
            <div
              key={`${g.label}-${gi}`}
              style={{ display: "flex", flexDirection: "column", gap: 2, paddingTop: 4 }}
              role={anyInteractive ? "group" : undefined}
              aria-labelledby={anyInteractive ? labelId : undefined}
            >
              <div
                id={labelId}
                style={{
                  padding: "6px 12px 2px",
                  font: `600 9px/1 ${font.mono}`,
                  letterSpacing: ".09em",
                  textTransform: "uppercase",
                  color: color.inkMute,
                }}
              >
                {g.label}
              </div>
              {(g.items || []).map((it, ii) => {
                idx += 1;
                const on = idx === sel;
                const act = Boolean(it.onClick);
                const ink = INKS[it.tone || "neutral"] || INKS.neutral;
                const row: CSSProperties = {
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  minHeight: 34,
                  padding: "8px 12px",
                  cursor: act ? "pointer" : "default",
                  background: on ? token("palette-tint-selected") : "transparent",
                  borderLeft: `2px solid ${on ? accent.amber.ink : "transparent"}`,
                  ...({
                    "--hv-bg": on ? token("palette-tint-selected-hover") : token("hover-veil"),
                  } as CSSProperties),
                };
                return (
                  <div
                    key={`${it.label}-${ii}`}
                    style={row}
                    // A palette row fills its container, so `.bk-row`: ring
                    // inside at -2, background-only hover, no transform.
                    className={act ? "bk-row" : undefined}
                    role={act ? "option" : undefined}
                    aria-selected={act ? on : undefined}
                    // The effect rides in the accessible name, not only in the
                    // chip — "Re-index knowledge/, reindex" — so a screen
                    // reader cannot be told less than the screen shows.
                    aria-label={act && it.effect ? `${it.label}, ${it.effect}` : undefined}
                    tabIndex={act ? (on ? 0 : -1) : undefined}
                    onClick={it.onClick}
                    onKeyDown={act ? (event) => onRowKeyDown(event, it) : undefined}
                  >
                    {it.icon ? <Icon icon={it.icon} size={15} color={ink} /> : null}
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        // A row that WRITES is set in mono, because what it
                        // will do is a command rather than a phrase.
                        font: it.effect ? `500 12px/1.3 ${font.mono}` : `500 12.5px/1.3 ${font.body}`,
                        color: on ? color.ink : color.inkDim,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {it.label}
                    </span>
                    {it.effect ? (
                      <span
                        style={{
                          flex: "none",
                          border: `1px solid ${color.edge}`,
                          borderRadius: 5,
                          padding: "3px 6px",
                          font: `600 9px/1.3 ${font.mono}`,
                          color: accent.amber.ink,
                        }}
                      >
                        {it.effect}
                      </span>
                    ) : null}
                    {on ? (
                      <span style={{ flex: "none", font: `500 10px/1 ${font.mono}`, color: color.inkMute }}>
                        {it.shortcut || "⏎"}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "9px 13px",
          borderTop: `1px solid ${color.line}`,
          background: token("palette-foot-bg"),
        }}
      >
        <span style={{ ...footText, flex: 1, minWidth: 0 }}>{p.footHint ?? "↑↓ move · ⏎ run · ⌘⏎ run without asking"}</span>
        <span style={{ ...footText, flex: "none" }}>{p.footMeta ?? "4,812 docs · 0.2s"}</span>
      </div>
    </div>
  );
}
