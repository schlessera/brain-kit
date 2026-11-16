/**
 * The inline field a text note is typed into (#3983): one line, 80
 * characters, opened at the tapped point. Enter or Place commits it; Escape
 * cancels it without closing the editor. Reopened on a placed note, it also
 * offers Delete.
 */

import { useEffect, useRef, type CSSProperties } from "react";

import { Button } from "../primitives/Button.js";
import { color, font } from "../tokens.js";
import { MARKUP_NOTE_MAX } from "./markup.js";

export interface MarkupNoteFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter or Place. An empty value cancels instead. */
  onPlace: () => void;
  /** Escape. */
  onCancel: () => void;
  /** Present when editing a placed note. */
  onDelete?: () => void;
  /** Focus the field when it opens. On by default. */
  autoFocus?: boolean;
}

const field: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  height: 44,
  boxSizing: "border-box",
  padding: "0 12px",
  borderRadius: 10,
  border: `1px solid ${color.edge}`,
  background: color.surface,
  color: color.ink,
  font: `500 15px/1.2 ${font.body}`,
};

export function MarkupNoteField(p: MarkupNoteFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (p.autoFocus !== false) input.current?.focus({ preventScroll: true });
  }, [p.autoFocus]);

  const place = () => (p.value.trim() ? p.onPlace() : p.onCancel());

  return (
    <div
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: 8, borderRadius: 14, background: color.raised, border: `1px solid ${color.edge}` }}
      onPointerDown={event => event.stopPropagation()}
      data-bk-markup-note-field=""
    >
      <input
        ref={input}
        type="text"
        aria-label="Note text"
        maxLength={MARKUP_NOTE_MAX}
        value={p.value}
        enterKeyHint="done"
        autoComplete="off"
        onChange={event => p.onChange(event.target.value.replace(/[\r\n]+/g, " ").slice(0, MARKUP_NOTE_MAX))}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            place();
          } else if (event.key === "Escape") {
            // The note closes; the editor stays open (Overlay skips a prevented Escape).
            event.preventDefault();
            event.stopPropagation();
            p.onCancel();
          }
        }}
        style={field}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <Button label="Place" size="md" tone="affirm" block={false} onClick={place} style={{ minHeight: 44 }} />
        {p.onDelete ? <Button label="Delete" size="md" tone="danger" block={false} onClick={p.onDelete} style={{ minHeight: 44 }} /> : null}
      </div>
    </div>
  );
}
