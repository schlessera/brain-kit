import type { CSSProperties } from "react";
import { color, font, token } from "../tokens.js";

/** The single card keeps its uncontrolled Enter-to-submit field; a group
 * supplies a controlled value so leaving a section cannot lose its answer. */
export function AskOtherField(p: {
  label?: string;
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  touchTarget?: boolean;
}) {
  const field: CSSProperties = {
    display: "flex", alignItems: "center", gap: 8, marginTop: 8,
    background: token("inset-well-bg"), border: `1px solid ${color.edge}`,
    borderRadius: 11, padding: "10px 12px",
  };
  const input: CSSProperties = {
    flex: 1, minWidth: 0, display: "block", width: "100%", margin: 0,
    padding: 0, border: 0, background: "none",
    font: `400 12.5px/1.4 ${font.body}`, color: color.ink,
    // The group's field stays inside the well, but the editable target reaches
    // 44px. Equal negative margins keep the existing well's compact paint.
    ...(p.touchTarget ? { minHeight: 44, margin: "-10px 0" } : undefined),
  };
  const hint: CSSProperties = {
    flex: "none", border: `1px solid ${color.edge}`, borderRadius: 5,
    padding: "2px 6px", font: `500 9.5px/1.4 ${font.mono}`, color: color.inkMute,
  };
  return (
    <div style={field} className="bk-field">
      <input
        className="bk-ask-other"
        style={input}
        type="text"
        aria-label={p.label ?? "Your own answer"}
        placeholder={p.placeholder ?? "Type where it should go…"}
        value={p.value}
        onChange={p.onChange ? (event) => p.onChange?.(event.currentTarget.value) : undefined}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || (p.value !== undefined && event.nativeEvent.isComposing)) return;
          event.preventDefault();
          p.onSubmit?.(event.currentTarget.value);
        }}
      />
      <span style={hint} aria-hidden="true">⏎</span>
    </div>
  );
}
