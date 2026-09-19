import type { CSSProperties, ChangeEvent, KeyboardEvent } from "react";
import { useId } from "react";

import { Icon, type IconName } from "../primitives/Icon.js";
import { accent, color, font, token } from "../tokens.js";
import type { ComposerVariant, Tone } from "../types.js";

/**
 * The one piece of permanent chrome in the app, and therefore kit-owned rather
 * than app-drawn: a field redrawn per screen is a component nobody can audit.
 *
 * `send` is a thread you are in, `voice` is the composer as primary navigation
 * (hold to talk), `plain` is a read-only surface.
 *
 * ## Row order is fixed: attach · field · mic · send/stop
 *
 * Capture (camera, photo, file, paste) is a MENU behind the attach button, not
 * three more icons — a 390px row has one field and at most two flanking glyphs
 * before the field stops being the subject. The provider picker is not in the
 * row either: it is a state you change rarely, so it sits in the hint line,
 * which is already this component's status line. Recall chips sit ABOVE the
 * field because attached context is content, not a control.
 *
 * ## `state` drives placeholder, hint and the trailing control together
 *
 * So a connection state can never be half-applied:
 *
 *   ready         amber send
 *   streaming     red stop; the field stays typeable (you may add to the question)
 *   reconnecting  send stays live and queues locally
 *   offline       send disabled — opacity .45 + `aria-disabled` + the mono
 *                 reason, per the kit's disabled rule; the draft is never discarded.
 *
 * An explicit `placeholder`, `hint` or `blockedWhy` overrides the state's
 * default; pass `""` to suppress one.
 *
 * ## This is the one place the port adds behaviour rather than moving it
 *
 * The design first drew `Composer` as a styled `<span>` — a picture of a text
 * field, with the placeholder as static text — and its own README listed that
 * under known gaps: *"Composer is a display component (a styled span, not a
 * live input) — wire it to a real `<textarea>` with `:focus-visible` when
 * implementing."* So this component renders a real `<textarea>` (the design's
 * fifth drop now does too), and three things follow from it:
 *
 *   - **The keys are the design's**, from its own role-and-keys table: ⏎ sends,
 *     ⇧⏎ inserts a newline. `onSend` is what makes ⏎ mean anything; without it
 *     ⏎ falls through to the textarea and inserts a newline like any other.
 *     While streaming, `esc` in the field is `onStop`, because the hint says so.
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
 *
 * D20 throughout: the attach menu trigger, the microphone, the provider chip,
 * the send and stop discs and each recall chip's × are controls only when a
 * handler is passed. Without one each renders exactly the pixels the design
 * draws — no role, no ring, no tab stop.
 */
export interface ComposerProps {
  /** Shown when empty, and the field's accessible name. Defaults per `state`. */
  placeholder?: string;
  variant?: ComposerVariant;
  /**
   * The connection state. Drives the placeholder, the hint and the trailing
   * control together; `ready` when omitted.
   */
  state?: ComposerState;
  /** The mono line under the field. Defaults per `state`; `""` hides it. */
  hint?: string;
  /**
   * The gold mono reason the send is unavailable, right of the hint. Only
   * rendered while `offline`; defaults to "needs the host · your draft is kept".
   */
  blockedWhy?: string;
  /** The model in use, as a mono chip at the start of the hint row. */
  provider?: string;
  /** Makes the provider chip a picker trigger (`aria-haspopup="listbox"`). */
  onProvider?: () => void;
  /** Context attached to the next question, as chips above the field. */
  recall?: ComposerRecall[];
  /** Makes each recall chip's × a real "Remove {label}" button. */
  onRecallRemove?: (index: number) => void;
  /** The paperclip. On by default; never on a `plain` surface. */
  attach?: boolean;
  /** Controlled text. Omit for an uncontrolled field. */
  value?: string;
  /** Makes the field editable. Without it the textarea is `readOnly`. */
  onChange?: (value: string) => void;
  /** ⏎. Without it, ⏎ inserts a newline like any other key. */
  onSend?: (value: string) => void;
  /** The stop disc while `streaming`, and `esc` inside the field. */
  onStop?: () => void;
  /** Opens the app's own capture menu (photo, camera, file). */
  onAttach?: () => void;
  onMic?: () => void;
  /** Rows the field may grow to on ⇧⏎. */
  maxRows?: number;
}

export type ComposerState = "ready" | "streaming" | "reconnecting" | "offline";

export interface ComposerRecall {
  label: string;
  /** `thread` when omitted. */
  icon?: IconName;
  /** `purple` — untrusted origin, which recalled context is — when omitted. */
  tone?: Tone;
}

/** Each state's placeholder and hint; `why` is the offline reason. */
const STATE: Record<ComposerState, { ph: string; hint: string; why?: string }> = {
  ready: { ph: "Ask your brain anything…", hint: "⌘K for commands · ⏎ to send · ⇧⏎ for a new line" },
  streaming: { ph: "Add to the question while it works…", hint: "esc or the stop button ends the run" },
  reconnecting: { ph: "Reconnecting to the host…", hint: "queued locally · sends when the host answers" },
  offline: { ph: "The host is unreachable", hint: "", why: "needs the host · your draft is kept" },
};

export function Composer(p: ComposerProps) {
  const v = p.variant || "send";
  const st: ComposerState = p.state && STATE[p.state] ? p.state : "ready";
  const s = STATE[st];
  const offline = st === "offline";
  const streaming = st === "streaming";

  const placeholder = p.placeholder ?? s.ph;
  const hint = p.hint ?? s.hint;
  const blockedWhy = offline ? (p.blockedWhy ?? s.why) : undefined;
  const recall = p.recall ?? [];

  const showAttach = p.attach !== false && v !== "plain";
  const showMic = v === "send" || v === "plain";
  const showSend = v === "send" && !streaming;
  const showStop = v === "send" && streaming;
  const editable = Boolean(p.onChange);
  const hintRow = Boolean(p.provider || hint || blockedWhy);
  const hintId = useId();

  const lines = (p.value ?? "").split("\n").length;
  const rows = Math.max(1, Math.min(Number(p.maxRows) || 5, lines));

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape" && streaming && p.onStop) {
      event.preventDefault();
      p.onStop();
      return;
    }
    // ⇧⏎ is a newline and reaches the textarea untouched; ⏎ alone sends, but
    // only when somebody is listening — and never into an unreachable host.
    if (event.key !== "Enter" || event.shiftKey || !p.onSend || offline) return;
    event.preventDefault();
    p.onSend(event.currentTarget.value);
  }

  const field: CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: color.surface,
    // The edge lifts a step while a run is live: the field is busy, not idle.
    border: `1px solid ${streaming ? token("hover-border") : color.edge}`,
    borderRadius: v === "voice" ? 22 : 20,
    padding: v === "voice" ? "10px 12px" : "8px 10px",
  };

  const input: CSSProperties = {
    flex: 1,
    minWidth: 0,
    maxHeight: 96,
    font: `400 13.5px/1.45 ${font.body}`,
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

  const disc = (size: number, fill: string, glow: boolean): CSSProperties => ({
    width: size,
    height: size,
    borderRadius: "50%",
    flex: "none",
    background: fill,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    ...(glow ? { boxShadow: `0 8px 24px ${token("composer-voice-glow")}` } : null),
  });

  // The kit's disabled rule, as `Button` applies it: dimmed, inert to the
  // pointer, `aria-disabled`, out of the tab order but still a named button so
  // the reason for its absence is announced rather than the button vanishing.
  const sendAct = Boolean(p.onSend);
  const sendStyle: CSSProperties = {
    ...disc(28, accent.amber.fill, false),
    ...(offline ? { opacity: 0.45, cursor: "default", pointerEvents: "none" } : { cursor: sendAct ? "pointer" : "default" }),
  };
  const send = () => p.onSend?.(p.value ?? "");

  const stopAct = Boolean(p.onStop);

  const mono = (weight: number, size: number): string => `${weight} ${size}px/1.5 ${font.mono}`;

  return (
    <div
      style={{
        flex: "none",
        boxSizing: "border-box",
        width: "100%",
        padding: "8px 14px 6px",
        display: "flex",
        flexDirection: "column",
        gap: 7,
      }}
    >
      {recall.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {recall.map((r, i) => (
            <RecallChip key={`${i}:${r.label}`} {...r} onRemove={p.onRecallRemove ? () => p.onRecallRemove?.(i) : undefined} />
          ))}
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
        <div style={field} className="bk-field">
          {showAttach ? (
            <IconButton icon="attach" label="Attach — photo, camera, file" haspopup="menu" onClick={p.onAttach} />
          ) : null}
          <textarea
            className="bk-composer"
            style={input}
            rows={rows}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-describedby={hintRow ? hintId : undefined}
            value={p.value}
            readOnly={!editable}
            onChange={editable ? (e: ChangeEvent<HTMLTextAreaElement>) => p.onChange?.(e.target.value) : undefined}
            onKeyDown={onKeyDown}
          />
          {showMic ? <IconButton icon="mic" label="Dictate" onClick={p.onMic} /> : null}
          {showStop ? (
            <span
              style={{ ...disc(28, accent.red.fill, false), cursor: stopAct ? "pointer" : "default" }}
              className={stopAct ? "bk-control" : undefined}
              role={stopAct ? "button" : undefined}
              aria-label={stopAct ? "Stop generating" : undefined}
              tabIndex={stopAct ? 0 : undefined}
              onClick={p.onStop}
              onKeyDown={stopAct ? pressable(() => p.onStop?.()) : undefined}
            >
              <span style={{ width: 9, height: 9, borderRadius: 2, background: color.onFill }} />
            </span>
          ) : null}
          {showSend ? (
            <span
              style={sendStyle}
              className={sendAct && !offline ? "bk-control" : undefined}
              role={sendAct ? "button" : undefined}
              aria-label={sendAct ? (offline ? "Send — unavailable" : "Send") : undefined}
              aria-disabled={sendAct && offline ? true : undefined}
              tabIndex={sendAct ? (offline ? -1 : 0) : undefined}
              onClick={sendAct && !offline ? send : undefined}
              onKeyDown={sendAct && !offline ? pressable(send) : undefined}
            >
              <Icon icon="send" size={15} color={color.onFill} />
            </span>
          ) : null}
        </div>
        {v === "voice" ? (
          <span
            style={disc(54, accent.amber.fill, true)}
            className={p.onMic ? "bk-control" : undefined}
            role={p.onMic ? "button" : undefined}
            aria-label={p.onMic ? "Hold to talk" : undefined}
            tabIndex={p.onMic ? 0 : undefined}
            onClick={p.onMic}
            onKeyDown={p.onMic ? pressable(() => p.onMic?.()) : undefined}
          >
            <Icon icon="mic" size={24} color={color.onFill} />
          </span>
        ) : null}
      </div>
      {hintRow ? (
        <div id={hintId} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minHeight: 14 }}>
          {p.provider ? (
            <span
              style={
                {
                  flex: "none",
                  border: `1px solid ${color.edge}`,
                  borderRadius: 5,
                  padding: "2px 6px",
                  font: mono(500, 9.5),
                  color: color.inkDim,
                  cursor: p.onProvider ? "pointer" : "default",
                  "--hv-bd": token("hover-border"),
                  "--hv-fg": color.ink,
                } as CSSProperties
              }
              className={p.onProvider ? "bk-control" : undefined}
              role={p.onProvider ? "button" : undefined}
              aria-label={p.onProvider ? `Model — ${p.provider}` : undefined}
              aria-haspopup={p.onProvider ? "listbox" : undefined}
              tabIndex={p.onProvider ? 0 : undefined}
              onClick={p.onProvider}
              onKeyDown={p.onProvider ? pressable(() => p.onProvider?.()) : undefined}
            >
              {p.provider}
            </span>
          ) : null}
          {hint ? <span style={{ flex: 1, minWidth: 0, font: mono(400, 10), color: color.inkMute }}>{hint}</span> : null}
          {blockedWhy ? <span style={{ flex: "none", font: mono(500, 10), color: accent.gold.ink }}>{blockedWhy}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Enter and Space activate, like a native button. */
function pressable(act: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    act();
  };
}

/**
 * The paperclip and the microphone inside the field: a 28px round hit target
 * with a hover veil, which is what the design draws around each.
 *
 * Each gains an optional callback and D20's gating rule does the rest: with no
 * handler this renders exactly the icon the source renders, with no role, no
 * ring and no tab stop. The paperclip is a menu trigger, so it also says so.
 */
function IconButton(props: { icon: "attach" | "mic"; label: string; haspopup?: "menu"; onClick?: () => void }) {
  const act = Boolean(props.onClick);
  return (
    <span
      style={
        {
          width: 28,
          height: 28,
          borderRadius: 999,
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: act ? "pointer" : "default",
          "--hv-bg": token("hover-veil-strong"),
        } as CSSProperties
      }
      className={act ? "bk-control" : undefined}
      role={act ? "button" : undefined}
      aria-label={act ? props.label : undefined}
      aria-haspopup={act ? props.haspopup : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={props.onClick}
      onKeyDown={act ? pressable(() => props.onClick?.()) : undefined}
    >
      <Icon icon={props.icon} size={17} color={color.inkMute} />
    </span>
  );
}

/**
 * One piece of recalled context above the field. Purple by default because
 * recalled context is an untrusted origin; the tint is the chip ramp's, so it
 * sits at the same 9-16% every other chip in the kit does. The × is a button
 * only when the app can act on it.
 */
function RecallChip(props: ComposerRecall & { onRemove?: () => void }) {
  const tone: Tone = props.tone && accent[props.tone] ? props.tone : "purple";
  const fg = accent[tone].ink;
  const act = Boolean(props.onRemove);
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        flex: "none",
        maxWidth: "100%",
        background: token(`chip-tint-${tone}`),
        border: `1px solid ${token(`chip-border-${tone}`)}`,
        borderRadius: 999,
        padding: "4px 8px 4px 7px",
        font: `500 10.5px/1 ${font.mono}`,
        color: fg,
        whiteSpace: "nowrap",
      }}
    >
      <Icon icon={props.icon ?? "thread"} size={12} color={fg} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{props.label}</span>
      <span
        style={{ marginLeft: 1, font: `600 12px/1 ${font.body}`, color: fg, cursor: act ? "pointer" : "default" }}
        className={act ? "bk-control" : undefined}
        role={act ? "button" : undefined}
        aria-label={act ? `Remove ${props.label}` : undefined}
        tabIndex={act ? 0 : undefined}
        onClick={props.onRemove}
        onKeyDown={act ? pressable(() => props.onRemove?.()) : undefined}
      >
        ×
      </span>
    </span>
  );
}
