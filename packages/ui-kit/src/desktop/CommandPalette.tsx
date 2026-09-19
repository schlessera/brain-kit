import { useId, type ChangeEvent, type CSSProperties, type KeyboardEvent } from "react";

import { warnOnce } from "../internal/dev.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { Tone } from "../types.js";

/**
 * The desktop's real navigation, behind ⌘K.
 *
 * Four rules carry over from the design, and none of them is styling:
 *
 *   **Groups are the three things ⏎ can do** — JUMP TO a place, ASK a
 *   question, RUN work — rather than the app's feature areas, because "jump to
 *   a file" and "spend money on my behalf" are not comparable results.
 *
 *   **Anything that writes shows its effect chip right in the row**, so a
 *   palette can never run something the user did not agree to. The chip is also
 *   part of the row's accessible name — `"Fix the crew count, enqueue"` — which
 *   is the design's own non-negotiable ("a control that writes exposes its
 *   effect chip as part of its accessible name"). A row with an `effect` and no
 *   chip would be the single worst bug this component could ship, so the chip
 *   is not conditional on anything but the effect existing.
 *
 *   **Anything that spends shows a cost chip** (gold, `~$`). Spending money is
 *   an effect even when nothing is written, so a briefing carries `~$0.12` and
 *   no write verb. Opening a form is not an effect: "Add a note" is bare, and
 *   its submit button is where `write_note` lives.
 *
 *   **A command the host cannot currently serve is shown disabled, with the
 *   reason, never omitted.** Dropping rows while the socket is down teaches
 *   that the palette's contents are a guess. `why` is what makes a row
 *   disabled: opacity .45, `aria-disabled`, no tab stop, no click, and the mono
 *   reason printed where the shortcut would be. A disabled row is never the
 *   selection, and ↑↓ step over it.
 *
 * ## Keys, and which of them a presentational component can own
 *
 * The design's table says ⌘K · ↑↓ · esc. **⌘K is not here**, and cannot be: it
 * opens the palette, and a component that is not mounted cannot listen for it.
 * That belongs to whatever decides the palette is open. ↑↓, Home/End and esc
 * are here, gated on the callback that makes them mean something — `onSelect`
 * and `onClose`. Without those, the palette is the picture the design draws.
 *
 * ## The query is a real `<input>`
 *
 * A drawn caret over overlay keystroke capture loses IME, autocorrect,
 * selection and paste, so the query is an `<input role="combobox">` that owns
 * the listbox, and the focus ring sits on the row around it — the same
 * `.bk-field` mechanism {@link Composer} uses, drawn inside because the row is
 * the top strip of an `overflow: hidden` dialog. Without `onQueryChange` the
 * input is `readOnly`, which is Composer's rule too: it still focuses and still
 * announces itself, and cannot be typed into, which is honest in a way a
 * styled span is not.
 */
export interface PaletteItem {
  label: string;
  icon?: IconName;
  tone?: Tone;
  /** What running this WRITES. Its presence is what makes the row a write. */
  effect?: string;
  /** What running this SPENDS, e.g. `~$0.12`. Its presence makes the row a spend. */
  cost?: string;
  /**
   * Why the host cannot serve this right now, e.g. `needs the host`. Its
   * presence is what makes the row DISABLED: the reason is printed, the row
   * cannot be selected, clicked or focused, and ↑↓ step over it.
   */
  why?: string;
  /** A printed key, e.g. `⌘N`. Always shown; the selected row shows ⏎ when it has none. */
  shortcut?: string;
  onClick?: () => void;
}

export interface PaletteGroup {
  label: string;
  items: PaletteItem[];
}

export interface CommandPaletteProps {
  /** The controlled query. */
  query?: string;
  /** Shown when the query is empty. */
  placeholder?: string;
  groups?: PaletteGroup[];
  /**
   * Index of the selected row, counted across all groups, disabled rows
   * included. A disabled row cannot be the selection: an index that lands on
   * one falls through to the next enabled row.
   */
  selected?: number;
  /** Corpus size and query time, bottom right. */
  footMeta?: string;
  /**
   * The key legend, bottom left. Defaults to the design's line; an app that
   * binds different keys passes its own, because a printed key that does
   * nothing is what the design's "every shortcut is printed where it applies"
   * forbids.
   */
  footHint?: string;
  /** Caps the list, which scrolls past it rather than clipping. */
  maxHeight?: number;
  /** Typing. Without it the query input is `readOnly`. */
  onQueryChange?: (query: string) => void;
  /** ↑↓ and Home/End. Receives the new flat index. Without it the arrows do nothing. */
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

const DEFAULT_PLACEHOLDER = "Where to, what to ask, what to run…";
const DEFAULT_FOOT_HINT = "↑↓ move · ⏎ run · home/end ends · esc closes";

/** The source's fallback names a real city, a plausible real person and a real
 * company as a client. All three are replaced per D19; the shape is the
 * design's exactly — four jumps, three questions, three runs, with one write,
 * one spend and three rows the host cannot serve. */
const FALLBACK: PaletteGroup[] = [
  {
    label: "Jump to",
    items: [
      { icon: "thread", label: "New chat", tone: "amber", shortcut: "⌘N" },
      { icon: "file", label: "knowledge/scylla.md", tone: "teal" },
      { icon: "history", label: "Sessions", tone: "neutral" },
      { icon: "graph", label: "The graph around Ithaca", tone: "purple", shortcut: "⌘4" },
    ],
  },
  {
    label: "Ask",
    items: [
      { icon: "ask", label: "What did I promise Penelope?", tone: "neutral" },
      { icon: "search", label: "Search the brain for “crew count”", tone: "neutral" },
      { icon: "activity", label: "Brain statistics", tone: "neutral", why: "needs the host" },
    ],
  },
  {
    label: "Run",
    items: [
      { icon: "retry", label: "Sync the brain", tone: "amber", effect: "sync", why: "needs the host" },
      { icon: "digest", label: "Daily briefing", tone: "gold", cost: "~$0.12", why: "needs the host" },
      { icon: "edit", label: "Add a note", tone: "neutral" },
    ],
  },
];

const ENABLED_OPTION = '[role="option"]:not([aria-disabled="true"])';

export function CommandPalette(p: CommandPaletteProps) {
  if (p.groups && !Array.isArray(p.groups)) warnOnce("CommandPalette: `groups` is not an array; no rows will render.");
  const src = p.groups || FALLBACK;
  const baseId = useId();
  const listId = `${baseId}-list`;
  const editable = Boolean(p.onQueryChange);
  const flat = src.flatMap((g) => g.items || []);
  const anyInteractive = flat.some((it) => Boolean(it.onClick) && !it.why);

  // The selection falls through a disabled row to the next enabled one, so
  // that a `selected` the app computed before the host went away still lands
  // somewhere — and so the roving tab stop always has a row to sit on.
  const asked = Number(p.selected ?? 0);
  let sel = -1;
  for (let i = 0; i < flat.length; i += 1) {
    const at = (asked + i + flat.length) % flat.length;
    if (!flat[at]?.why) {
      sel = at;
      break;
    }
  }

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
   *
   * Only ENABLED rows are in the walk; a disabled row is stepped over as if it
   * were not there, while its flat index still counts, which is what
   * `data-index` carries back to `onSelect`.
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
    const rows = [...(box?.querySelectorAll<HTMLElement>(ENABLED_OPTION) ?? [])];
    const here = rows.indexOf(event.currentTarget);
    if (here === -1 || rows.length < 2) return;
    // Home / End land on the edges (design-feedback §11, answered).
    const next = edge === "first" ? 0 : edge === "last" ? rows.length - 1 : (here + delta + rows.length) % rows.length;
    // The tab stop is the SELECTED row, so it has to move before focus does.
    p.onSelect?.(Number(rows[next].dataset.index));
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
  const chip: CSSProperties = {
    flex: "none",
    border: `1px solid ${color.edge}`,
    borderRadius: 5,
    padding: "3px 6px",
    font: `600 9px/1.3 ${font.mono}`,
  };
  const mono10: CSSProperties = { flex: "none", font: `500 10px/1 ${font.mono}`, color: color.inkMute };
  const footText: CSSProperties = { font: `400 9.5px/1.4 ${font.mono}`, color: color.inkMute };

  let idx = -1;

  return (
    <div style={box} role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onDialogKeyDown}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "13px 14px",
          borderBottom: `1px solid ${color.line}`,
        }}
        // The ring is on the ROW, not the input, and inside it: the row is the
        // dialog's top strip, and the dialog clips.
        className="bk-field bk-field-inset"
      >
        <Icon icon="search" size={16} color={color.inkMute} />
        <input
          className="bk-palette-query"
          style={{
            flex: 1,
            minWidth: 0,
            display: "block",
            margin: 0,
            padding: 0,
            border: 0,
            background: "none",
            font: `400 14px/1.2 ${font.body}`,
            color: color.ink,
          }}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-label="Search places, questions and commands"
          placeholder={p.placeholder ?? DEFAULT_PLACEHOLDER}
          value={p.query ?? ""}
          readOnly={!editable}
          onChange={editable ? (e: ChangeEvent<HTMLInputElement>) => p.onQueryChange?.(e.target.value) : undefined}
        />
        <span style={keyCap}>esc</span>
      </div>

      <div
        id={listId}
        style={{
          display: "flex",
          flexDirection: "column",
          paddingBottom: 6,
          // maxHeight caps the overlay; the list SCROLLS past it rather than
          // hiding, so a row is never both cut and unreachable.
          maxHeight: Number(p.maxHeight) || 320,
          overflowY: "auto",
          overflowX: "hidden",
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
                const off = Boolean(it.why);
                const on = idx === sel;
                // A disabled row is an option in the listbox — it is announced,
                // with its reason — but never an interactive one.
                const act = Boolean(it.onClick) && !off;
                const listed = anyInteractive && (act || off);
                const ink = INKS[it.tone || "neutral"] || INKS.neutral;
                const row: CSSProperties = {
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  minHeight: 34,
                  padding: "8px 12px",
                  cursor: act ? "pointer" : "default",
                  opacity: off ? 0.45 : 1,
                  background: on ? token("palette-tint-selected") : "transparent",
                  borderLeft: `2px solid ${on ? accent.amber.ink : "transparent"}`,
                  ...({
                    "--hv-bg": on ? token("palette-tint-selected-hover") : token("hover-veil"),
                  } as CSSProperties),
                };
                // The effect rides in the accessible name, not only in the chip
                // — "Re-index knowledge/, reindex" — so a screen reader cannot
                // be told less than the screen shows. The cost and the reason
                // ride the same way, for the same reason.
                const name = [it.label, it.effect, it.cost, it.why].filter(Boolean).join(", ");
                return (
                  <div
                    key={`${it.label}-${ii}`}
                    style={row}
                    data-index={listed ? idx : undefined}
                    // A palette row fills its container, so `.bk-row`: ring
                    // inside at -2, background-only hover, no transform.
                    className={act ? "bk-row" : undefined}
                    role={listed ? "option" : undefined}
                    aria-selected={listed ? on : undefined}
                    // Disabled in the picture too: the reason is on screen
                    // either way, so the attribute is what the row IS, not an
                    // interactive treatment.
                    aria-disabled={off ? true : undefined}
                    aria-label={listed && name !== it.label ? name : undefined}
                    tabIndex={act ? (on ? 0 : -1) : undefined}
                    onClick={act ? it.onClick : undefined}
                    onKeyDown={act ? (event) => onRowKeyDown(event, it) : undefined}
                  >
                    {it.icon ? <Icon icon={it.icon} size={15} color={ink} /> : null}
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        // A row that WRITES or SPENDS is set in mono, because
                        // what it will do is a command rather than a phrase.
                        font: it.effect || it.cost ? `500 12px/1.3 ${font.mono}` : `500 12.5px/1.3 ${font.body}`,
                        color: on ? color.ink : color.inkDim,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {it.label}
                    </span>
                    {it.cost ? <span style={{ ...chip, color: accent.gold.ink }}>{it.cost}</span> : null}
                    {it.effect ? <span style={{ ...chip, color: accent.amber.ink }}>{it.effect}</span> : null}
                    {it.why ? (
                      <span style={{ flex: "none", font: `500 9.5px/1 ${font.mono}`, color: color.inkMute }}>
                        {it.why}
                      </span>
                    ) : on || it.shortcut ? (
                      <span style={mono10}>{on ? it.shortcut || "⏎" : it.shortcut}</span>
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
        <span style={{ ...footText, flex: 1, minWidth: 0 }}>{p.footHint ?? DEFAULT_FOOT_HINT}</span>
        <span style={{ ...footText, flex: "none" }}>{p.footMeta ?? "4,812 docs · 0.2s"}</span>
      </div>
    </div>
  );
}
