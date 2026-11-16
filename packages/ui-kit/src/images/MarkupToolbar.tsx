/**
 * The markup editor's controls (#3983): five tools, three colours, three
 * widths, undo/redo/clear and "Send markup".
 *
 * `compact` (a phone) stacks them in three rows that each fit 296px — tools;
 * colours and widths; history beside Send — so nothing hides behind a popover.
 * `wide` lays them in one row with the tool names beside their glyphs.
 *
 * Tools are `aria-pressed` toggles. Colours and widths are radiogroups with
 * roving focus (arrow keys move and select), named by colour name, never by
 * colour alone. Every target is 44px.
 */

import { useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "../primitives/Button.js";
import { Icon, type IconName } from "../primitives/Icon.js";
import { IconButton } from "../primitives/IconButton.js";
import { MARKUP_INK, color, font } from "../tokens.js";
import { MARKUP_COLORS, MARKUP_WIDTHS, type MarkupColor, type MarkupTool, type MarkupWidth } from "./markup.js";

export const MARKUP_TOOLS: { tool: MarkupTool; icon: IconName; label: string; name: string; key: string }[] = [
  { tool: "pen", icon: "pen", label: "Pen", name: "Pen", key: "P" },
  { tool: "arrow", icon: "arrow", label: "Arrow", name: "Arrow", key: "A" },
  { tool: "ellipse", icon: "ellipse", label: "Ellipse", name: "Ellipse", key: "E" },
  { tool: "text", icon: "text", label: "Text", name: "Text note", key: "T" },
  { tool: "hand", icon: "hand", label: "Pan", name: "Pan", key: "H" },
];

export const MARKUP_EMPTY_HINT = "Draw at least one mark.";

export interface MarkupToolbarProps {
  layout: "compact" | "wide";
  tool: MarkupTool;
  onTool: (tool: MarkupTool) => void;
  color: MarkupColor;
  onColor: (color: MarkupColor) => void;
  width: MarkupWidth;
  onWidth: (width: MarkupWidth) => void;
  canUndo: boolean;
  canRedo: boolean;
  canClear: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  /** At least one committed mark. */
  canSubmit: boolean;
  /** Exporting: Send is held until the PNG is measured. */
  submitting?: boolean;
  onSubmit: () => void;
}

const COLOR_ORDER: MarkupColor[] = ["red", "yellow", "cyan"];
const WIDTH_ORDER: MarkupWidth[] = ["thin", "medium", "thick"];

function ToolToggle({ active, icon, label, name, shortcut, wide, onClick }: {
  active: boolean; icon: IconName; label: string; name: string; shortcut: string; wide: boolean; onClick: () => void;
}) {
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minWidth: 44,
    height: 44,
    padding: wide ? "0 12px" : 0,
    border: "1px solid transparent",
    borderRadius: 10,
    ["--mk-bg" as string]: active ? color.ink : "transparent",
    ["--mk-fg" as string]: active ? color.canvas : color.ink,
    font: `600 13px/1 ${font.body}`,
    cursor: "pointer",
    ["--hv-bg" as string]: active ? color.ink : color.raised,
    ["--hv-fg" as string]: active ? color.canvas : color.ink,
  };
  return (
    // raw-button: kit — A pressed tool is filled; IconButton has no pressed state.
    <button
      type="button"
      className="bk-control bk-markup-control"
      aria-pressed={active}
      aria-label={name}
      aria-keyshortcuts={shortcut}
      title={`${name} (${shortcut})`}
      onClick={onClick}
      style={style}
      data-markup-tool={label.toLowerCase()}
    >
      <Icon icon={icon} size={18} />
      {wide ? <span aria-hidden="true">{label}</span> : null}
    </button>
  );
}

/** A radiogroup with roving focus: one tab stop, arrows move and select. */
function RadioRow<T extends string>({ name, items, value, onChange, render }: {
  name: string;
  items: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  render: (value: T, checked: boolean) => ReactNode;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, items.findIndex(item => item.value === value));
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + items.length) % items.length;
    onChange(items[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={name} onKeyDown={move} style={{ display: "flex", gap: 0 }}>
      {items.map((item, i) => {
        const checked = i === index;
        return (
          // raw-button: kit — A radio in a roving radiogroup, drawn as its swatch.
          <button
            key={item.value}
            ref={el => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={item.label}
            title={item.label}
            tabIndex={checked ? 0 : -1}
            className="bk-control bk-markup-control"
            onClick={() => onChange(item.value)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 44,
              height: 44,
              padding: 0,
              border: "none",
              borderRadius: 10,
              cursor: "pointer",
              ["--hv-bg" as string]: color.raised,
            }}
            data-markup-option={item.value}
          >
            {render(item.value, checked)}
          </button>
        );
      })}
    </div>
  );
}

function Swatch({ value, checked }: { value: MarkupColor; checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 22,
        height: 22,
        borderRadius: "50%",
        background: MARKUP_COLORS[value].hex,
        boxShadow: checked ? `0 0 0 2px ${color.canvas}, 0 0 0 4px ${color.ink}` : `0 0 0 1px ${MARKUP_INK.halo}`,
      }}
    />
  );
}

function WidthSample({ value, checked }: { value: MarkupWidth; checked: boolean }) {
  const thickness = { thin: 2, medium: 4, thick: 7 }[value];
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 30,
        height: 30,
        borderRadius: 8,
        boxShadow: checked ? `inset 0 0 0 2px ${color.ink}` : undefined,
      }}
    >
      <span style={{ width: 18, height: thickness, borderRadius: thickness, background: color.ink }} />
    </span>
  );
}

const divider: CSSProperties = { width: 1, alignSelf: "stretch", margin: "8px 4px", background: color.edge };

export function MarkupToolbar(p: MarkupToolbarProps) {
  const hintId = useId();
  const wide = p.layout === "wide";
  const tools = (
    <div role="group" aria-label="Tools" style={{ display: "flex", gap: 4 }}>
      {MARKUP_TOOLS.map(t => (
        <ToolToggle
          key={t.tool}
          active={p.tool === t.tool}
          icon={t.icon}
          label={t.label}
          name={t.name}
          shortcut={t.key}
          wide={wide}
          onClick={() => p.onTool(t.tool)}
        />
      ))}
    </div>
  );
  const colours = (
    <RadioRow
      name="Mark colour"
      items={COLOR_ORDER.map(value => ({ value, label: MARKUP_COLORS[value].name }))}
      value={p.color}
      onChange={p.onColor}
      render={(value, checked) => <Swatch value={value} checked={checked} />}
    />
  );
  const widths = (
    <RadioRow
      name="Stroke width"
      items={WIDTH_ORDER.map(value => ({ value, label: MARKUP_WIDTHS[value].name }))}
      value={p.width}
      onChange={p.onWidth}
      render={(value, checked) => <WidthSample value={value} checked={checked} />}
    />
  );
  const history = (
    <div role="group" aria-label="History" style={{ display: "flex", gap: 0 }}>
      <IconButton name="Undo" icon="undo" disabled={!p.canUndo} onClick={p.onUndo} style={{ color: color.ink }} />
      <IconButton name="Redo" icon="redo" disabled={!p.canRedo} onClick={p.onRedo} style={{ color: color.ink }} />
      <IconButton name="Clear marks" icon="erase" disabled={!p.canClear} onClick={p.onClear} style={{ color: color.ink }} />
    </div>
  );
  const send = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: wide ? "flex-end" : "stretch", gap: 4, flex: wide ? "none" : "1 1 auto", minWidth: 0 }}>
      <Button
        label="Send markup"
        tone="primary"
        size="md"
        block={!wide}
        center
        disabled={!p.canSubmit || p.submitting}
        ariaDescribedBy={!p.canSubmit ? hintId : undefined}
        onClick={p.onSubmit}
        style={{ minHeight: 44 }}
      />
    </div>
  );
  const hint = !p.canSubmit ? (
    <div id={hintId} style={{ font: `400 12px/16px ${font.body}`, color: color.inkMute, textAlign: wide ? "right" : "center" }} data-markup-hint="">
      {MARKUP_EMPTY_HINT}
    </div>
  ) : null;

  if (wide) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-markup-toolbar="wide">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {tools}
          <span aria-hidden="true" style={divider} />
          {colours}
          <span aria-hidden="true" style={divider} />
          {widths}
          <span aria-hidden="true" style={divider} />
          {history}
          <span style={{ flex: "1 1 auto" }} />
          {send}
        </div>
        {hint}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-markup-toolbar="compact">
      <div style={{ display: "flex", justifyContent: "center" }}>{tools}</div>
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 4 }}>
        {colours}
        <span aria-hidden="true" style={divider} />
        {widths}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {history}
        {send}
      </div>
      {hint}
    </div>
  );
}
