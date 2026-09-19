import { useId, type CSSProperties, type KeyboardEvent } from "react";

import { Button } from "../primitives/Button.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { Toggle } from "../primitives/Toggle.js";
import { accent, color, font, token } from "../tokens.js";
import type { ListRowVariant, Tone, ToggleTone } from "../types.js";

/**
 * The workhorse row: settings entries, launcher cards, snooze options,
 * resumption lists. `variant` sets the container — grouped rows inside a
 * `Surface`, or standalone cards — and the trailing behaviour comes from
 * whichever of `value` / `toggle` / `actionLabel` / `chevron` you pass.
 *
 * Interaction states are the design's, and they are ROW states rather than
 * control states: hover lifts to `raised`, pressed dims to `brightness(.97)`
 * with no transform, and the focus ring is drawn at **-2** so a `Surface`'s
 * `overflow: hidden` cannot clip it. The rules live in `theme.css` under
 * `.bk-row`; the per-row hover value arrives as `--hv-bg` on this element's
 * own inline style.
 *
 * **None of it appears unless a handler was passed** — no class, no role, no
 * tab stop, no hover. A settings row that only displays a value is not
 * pretending to be pressable.
 *
 * The trailing `Toggle` and `Button` are DECORATIVE, which is the source's
 * design and not an oversight: neither is given a handler, so the whole row is
 * the one hit target and the switch inside it grows no competing one. A caller
 * who wants an independently operable switch composes `Toggle` directly.
 */
export interface ListRowProps {
  title?: string;
  subtitle?: string;
  /** Trailing value text. Mono unless `valueMono` is false. */
  value?: string;
  valueTone?: Tone;
  icon?: IconName;
  iconTone?: Tone;
  variant?: ListRowVariant;
  /** Teal border and tint. The choice belongs to the user, not the agent. */
  selected?: boolean;
  chevron?: boolean;
  /** A trailing ghost button. Decorative — the row carries the handler. */
  actionLabel?: string;
  /** PRESENCE shows the switch, the value sets it. `undefined` shows none. */
  toggle?: boolean;
  toggleTone?: ToggleTone;
  /** `group` only: drops the hairline under the last row. */
  last?: boolean;
  /** Title in mono, for a row whose subject is a path or an identifier. */
  mono?: boolean;
  /** Title in dim ink. */
  dim?: boolean;
  subMono?: boolean;
  /** Set false for a proportional value. */
  valueMono?: boolean;
  iconSize?: number;
  onClick?: () => void;
}

/** Icon and value tones are ink: text, glyphs and borders. */
const TONES: Record<Tone, string> = {
  amber: accent.amber.ink,
  gold: accent.gold.ink,
  teal: accent.teal.ink,
  purple: accent.purple.ink,
  blue: accent.blue.ink,
  red: accent.red.ink,
  neutral: accent.neutral.ink,
};

export function ListRow(p: ListRowProps) {
  const v = p.variant || "group";
  const titleId = useId();
  const tone = TONES[p.iconTone || "neutral"] || TONES.neutral;
  const selected = p.selected === true;
  const act = Boolean(p.onClick);

  const skins: Record<ListRowVariant, CSSProperties> = {
    group: { padding: "12px 13px", borderBottom: p.last ? "none" : `1px solid ${color.line}` },
    card: {
      padding: "12px 13px",
      border: `1px solid ${selected ? token("listrow-border-selected") : color.edge}`,
      background: selected ? token("listrow-tint-selected") : color.surface,
      borderRadius: 13,
    },
    launcher: { padding: "13px 14px", border: `1px solid ${color.edge}`, background: color.surface, borderRadius: 15 },
    plain: { padding: "8px 2px" },
  };
  const skin = skins[v] || skins.group;
  // The rest background, so a row with no handler "hovers" to where it already
  // is. The class is gated anyway; this keeps the custom property honest.
  const restBg = (skin.background as string | undefined) || "transparent";

  const box: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 11,
    boxSizing: "border-box",
    width: "100%",
    cursor: act ? "pointer" : "default",
    // A custom property is not in React's CSSProperties, so the entry is cast.
    ...({ "--hv-bg": act && !selected ? color.raised : restBg } as CSSProperties),
    ...skin,
  };
  const textWrap: CSSProperties = { flex: 1, minWidth: 0 };
  const titleStyle: CSSProperties = {
    display: "block",
    font: p.mono
      ? `500 11.5px/1.35 ${font.mono}`
      : `${v === "plain" ? "400" : "600"} 12.5px/1.35 ${font.body}`,
    color: p.dim ? color.inkDim : color.ink,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
  const subStyle: CSSProperties = {
    display: "block",
    marginTop: 2,
    font: p.subMono ? `400 10px/1.4 ${font.mono}` : `400 10.5px/1.4 ${font.body}`,
    color: color.inkMute,
  };
  const valueStyle: CSSProperties = {
    flex: "none",
    font: p.valueMono !== false ? `500 10.5px/1 ${font.mono}` : `600 11px/1 ${font.body}`,
    color: TONES[p.valueTone || "neutral"] || color.inkMute,
  };

  // A role="button" that cannot be operated from the keyboard is worse than no
  // role. The design's key table gives ListRow Enter; Space is added because
  // every role="button" in this kit takes both, and a button that ignores Space
  // is a defect a user meets before they meet the table.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    p.onClick?.();
  }

  return (
    <div
      style={box}
      className={act ? "bk-row" : undefined}
      role={act ? "button" : undefined}
      tabIndex={act ? 0 : undefined}
      aria-current={act && selected ? true : undefined}
      onClick={p.onClick}
      onKeyDown={act ? onKeyDown : undefined}
    >
      {p.icon ? <Icon icon={p.icon} size={Number(p.iconSize) || (v === "launcher" ? 19 : 17)} color={tone} /> : null}
      <span style={textWrap}>
        <span style={titleStyle} id={titleId} title={p.title ?? "Tomorrow morning"}>{p.title ?? "Tomorrow morning"}</span>
        {p.subtitle ? <span style={subStyle}>{p.subtitle}</span> : null}
      </span>
      {p.value ? <span style={valueStyle}>{p.value}</span> : null}
      {/* Named by the row's own visible title, as the fourth drop draws it —
          the switch is pure geometry, so it points at the text a sighted user
          reads as its label. Still decorative here (no handler, so no role);
          the name is what an operable switch composed the same way would take. */}
      {p.toggle !== undefined ? <Toggle on={p.toggle === true} tone={p.toggleTone || "amber"} labelledBy={titleId} /> : null}
      {p.actionLabel ? <Button label={p.actionLabel} tone="ghost" size="sm" block={false} /> : null}
      {p.chevron === true ? <Icon icon="next" size={16} color={color.inkMute} /> : null}
    </div>
  );
}
