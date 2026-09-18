import type { CSSProperties, ChangeEvent, KeyboardEvent } from "react";

import { Icon } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { ComposerVariant } from "../types.js";

/**
 * The one piece of permanent chrome in the app.
 *
 * `send` is a thread you are in, `voice` is the composer as primary navigation
 * (hold to talk), `plain` is a read-only surface.
 *
 * ## This is the one place the port adds behaviour rather than moving it
 *
 * The design draws `Composer` as a styled `<span>` — a picture of a text field,
 * with the placeholder as static text — and its own README lists that under
 * known gaps: *"Composer is a display component (a styled span, not a live
 * input) — wire it to a real `<textarea>` with `:focus-visible` when
 * implementing."* So this component renders a real `<textarea>`, which is net-new
 * work rather than a port, and three things follow from it:
 *
 *   - **The keys are the design's**, from its own role-and-keys table: ⏎ sends,
 *     ⇧⏎ inserts a newline. `onSend` is what makes ⏎ mean anything; without it
 *     ⏎ falls through to the textarea and inserts a newline like any other.
 *   - **The focus ring moved to the field.** The thing that takes focus is the
 *     textarea; the thing that should show a ring is the rounded field around
 *     it. `theme.css`'s `.bk-field:has(:focus-visible)` does that, and the
 *     textarea suppresses its own outline so the two do not stack.
 *   - **No handlers means a read-only field, not a fake one.** With no
 *     `onChange` the textarea is `readOnly`: it still focuses, still announces
 *     itself, and still cannot be typed into — which is honest in a way a
 *     `<span role="textbox">` is not.
 *
 * Height follows the newline count of a CONTROLLED value, capped at five rows.
 * That keeps the component a pure function of its props — no ref, no measuring,
 * no layout effect — at the cost of not growing on soft wrap. An uncontrolled
 * composer stays one row and scrolls, which is the browser's own behaviour.
 */
export interface ComposerProps {
  /** Shown when empty, and the field's accessible name. */
  placeholder?: string;
  variant?: ComposerVariant;
  /** The mono line under the field. `/ for commands`. */
  hint?: string;
  /** The paperclip. On by default. */
  attach?: boolean;
  /** Controlled text. Omit for an uncontrolled field. */
  value?: string;
  /** Makes the field editable. Without it the textarea is `readOnly`. */
  onChange?: (value: string) => void;
  /** ⏎. Without it, ⏎ inserts a newline like any other key. */
  onSend?: (value: string) => void;
  onAttach?: () => void;
  onMic?: () => void;
  /** Rows the field may grow to on ⇧⏎. */
  maxRows?: number;
}

const DEFAULT_PLACEHOLDER = "Ask your brain anything…";

export function Composer(p: ComposerProps) {
  const v = p.variant || "send";
  const placeholder = p.placeholder ?? DEFAULT_PLACEHOLDER;
  const showAttach = p.attach !== false;
  const showMic = v === "send" || v === "plain";
  const editable = Boolean(p.onChange);

  const lines = (p.value ?? "").split("\n").length;
  const rows = Math.max(1, Math.min(Number(p.maxRows) || 5, lines));

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // ⇧⏎ is a newline and reaches the textarea untouched; ⏎ alone sends, but
    // only when somebody is listening.
    if (event.key !== "Enter" || event.shiftKey || !p.onSend) return;
    event.preventDefault();
    p.onSend(event.currentTarget.value);
  }

  const field: CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: color.surface,
    border: `1px solid ${color.edge}`,
    borderRadius: v === "voice" ? 22 : 20,
    padding: v === "voice" ? "12px 14px" : "10px 12px",
  };

  const input: CSSProperties = {
    flex: 1,
    minWidth: 0,
    font: `400 13.5px/1 ${font.body}`,
    color: color.ink,
    background: "transparent",
    border: "none",
    padding: 0,
    margin: 0,
    resize: "none",
    // `auto`, not the source's `hidden`: a clipped single-line SPAN is fine,
    // a clipped input takes the caret off-screen as you type.
    overflow: "auto",
  };

  const round = (size: number, glow: boolean): CSSProperties => ({
    width: size,
    height: size,
    borderRadius: "50%",
    flex: "none",
    background: accent.amber.fill,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    ...(glow ? { boxShadow: `0 8px 24px ${token("composer-voice-glow")}` } : null),
  });

  return (
    <div style={{ flex: "none", boxSizing: "border-box", width: "100%", padding: "8px 14px 6px" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
        <div style={field} className="bk-field">
          {showAttach ? (
            <IconButton icon="attach" size={17} label="Attach a file" onClick={p.onAttach} />
          ) : null}
          <textarea
            className="bk-composer"
            style={input}
            rows={rows}
            placeholder={placeholder}
            aria-label={placeholder}
            value={p.value}
            readOnly={!editable}
            onChange={editable ? (e: ChangeEvent<HTMLTextAreaElement>) => p.onChange?.(e.target.value) : undefined}
            onKeyDown={onKeyDown}
          />
          {showMic ? <IconButton icon="mic" size={17} label="Dictate" onClick={p.onMic} /> : null}
          {v === "send" ? (
            <span
              style={round(28, false)}
              className={p.onSend ? "bk-control" : undefined}
              role={p.onSend ? "button" : undefined}
              aria-label={p.onSend ? "Send" : undefined}
              tabIndex={p.onSend ? 0 : undefined}
              onClick={p.onSend ? () => p.onSend?.(p.value ?? "") : undefined}
              onKeyDown={
                p.onSend
                  ? (e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      p.onSend?.(p.value ?? "");
                    }
                  : undefined
              }
            >
              <Icon icon="send" size={15} color={color.onFill} />
            </span>
          ) : null}
        </div>
        {v === "voice" ? (
          <span
            style={round(54, true)}
            className={p.onMic ? "bk-control" : undefined}
            role={p.onMic ? "button" : undefined}
            aria-label={p.onMic ? "Hold to talk" : undefined}
            tabIndex={p.onMic ? 0 : undefined}
            onClick={p.onMic}
          >
            <Icon icon="mic" size={24} color={color.onFill} />
          </span>
        ) : null}
      </div>
      {p.hint ? (
        <div style={{ textAlign: "center", marginTop: 4, font: `400 10px/1.6 ${font.mono}`, color: color.inkMute }}>
          {p.hint}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The paperclip and the microphone inside the field.
 *
 * Both are drawn by the source as bare `<dc-import name="Icon">` with no way to
 * operate them, which in React is a dead pixel. Each gains an optional callback
 * and D20's gating rule does the rest: with no handler this renders exactly the
 * icon the source renders, with no role, no ring and no tab stop.
 */
function IconButton(props: { icon: "attach" | "mic"; size: number; label: string; onClick?: () => void }) {
  const act = Boolean(props.onClick);
  return (
    <span
      style={{ display: "flex", flex: "none", cursor: act ? "pointer" : "default" }}
      className={act ? "bk-control" : undefined}
      role={act ? "button" : undefined}
      aria-label={act ? props.label : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={props.onClick}
      onKeyDown={
        act
          ? (e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              props.onClick?.();
            }
          : undefined
      }
    >
      <Icon icon={props.icon} size={props.size} color={color.inkMute} />
    </span>
  );
}
