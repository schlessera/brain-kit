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
 *   dictating     draft read-only, send/attach unavailable, mic stops capture
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
 * ## Height follows the text a CONTROLLED value displays, capped at five rows
 *
 * Wrapped lines included: `field-sizing: content` hands the sizing to the
 * browser's own line layout, which it runs on every keystroke anyway. That
 * keeps the component a pure function of its props — still no ref, no
 * measuring, no layout effect, and so still exactly one render per keystroke
 * in the subtree that re-renders on every keystroke by design — and the
 * per-keystroke cost is the browser re-laying out the field it was already
 * re-laying out. The newline count is still written to `rows`, because that is
 * the floor: a browser without `field-sizing` (Chrome 123, Safari 26.2 and
 * Firefox 152 have it) sizes from `rows` alone and gets exactly the height it
 * used to, which grew on ⇧⏎ and not on soft wrap. The old trade is now that
 * fallback, not a second sizing mechanism.
 *
 * The cap is `maxRows` lines or the design's 96px, whichever is smaller — which
 * is what a constant `maxHeight: 96` already produced when `rows` was the thing
 * that bounded the growth, so no `maxRows` renders differently than it used to.
 * The default still stops at exactly 96px, a hair under five lines of
 * `13.5px/1.45`, which it always was. An empty field, controlled
 * or not, stays one row: there is no text to follow, and a placeholder longer
 * than the field is clipped rather than given a second row that the first
 * character typed would take away. An uncontrolled composer stays one row and
 * scrolls, which is the browser's own behaviour.
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
   * The connection or capture state. Drives the placeholder, the hint and the trailing
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
  /** One-message override detail, amber inside the same provider chip. */
  providerDetail?: string;
  /** Accessible explanation when the requested detail is unsupported. */
  providerDetailExplanation?: string;
  providerExpanded?: boolean;
  providerControls?: string;
  /** Makes the provider chip a picker trigger (`aria-haspopup="dialog"`). */
  onProvider?: () => void;
  /** Context attached to the next question, as chips above the field. */
  recall?: ComposerRecall[];
  /** Makes each recall chip's × a real "Remove {label}" button. */
  onRecallRemove?: (index: number) => void;
  /** The paperclip. On by default; never on a `plain` surface. */
  attach?: boolean;
  /** Controlled text. Omit for an uncontrolled field. */
  value?: string;
  /** Makes the field editable outside `dictating`. Without it the textarea is `readOnly`. */
  onChange?: (value: string) => void;
  /** ⏎. Without it, ⏎ inserts a newline like any other key. */
  onSend?: (value: string) => void;
  /** The stop disc while `streaming`, and `esc` inside the field. */
  onStop?: () => void;
  /** Opens the app's own capture menu (photo, camera, files). */
  onAttach?: () => void;
  /**
   * The attach trigger's accessible name, and the pointer tooltip that shows
   * it: the actions the app's menu currently offers, in menu order. Starts
   * with "Attach" so an instruction naming the control still matches it.
   * Defaults to "Attach — photo, camera, files".
   */
  attachLabel?: string;
  /** Opens capture, or stops it while `dictating`. */
  onMic?: () => void;
  /**
   * The microphone. On by default. Off where the app has no capture to offer,
   * so no mic is drawn as if it worked.
   */
  mic?: boolean;
  /** The mic's accessible name, when the app's capture is not dictation ("Record on this device"), or names its service ("Dictate · Deepgram"). */
  micLabel?: string;
  /** Shows `micLabel` as the pointer tooltip too, as the attach trigger does. Off while dictating. */
  micTip?: boolean;
  /**
   * Why the mic cannot be used now ("Dictation isn't set up on this host.").
   * The mic stays focusable and named but is `aria-disabled`, takes this as
   * its accessible description and tooltip, and a tap or key does nothing.
   */
  micUnavailable?: string;
  /** Rows the field may grow to, on ⇧⏎ or on soft wrap, before it scrolls. Five when omitted. */
  maxRows?: number;
}

/** The attach trigger's default name: the capture menu with no live conversation in it. */
const ATTACH_LABEL = "Attach — photo, camera, files";

export type ComposerState = "ready" | "streaming" | "reconnecting" | "offline" | "dictating";

export interface ComposerRecall {
  label: string;
  /** `thread` when omitted. */
  icon?: IconName;
  /** `purple` — untrusted origin, which recalled context is — when omitted. */
  tone?: Tone;
}

/**
 * The field's type, in one place, because the cap is a count of its lines.
 *
 * `CEILING` is the design's own 96px — a hair under five lines, which it has
 * been since this component shipped. It stays the ceiling rather than becoming
 * five times a line so the default's rendered maximum height does not move.
 * `maxRows` lowers it and never raises it, which is exactly what a constant
 * `maxHeight: 96` did back when `rows` was what bounded the growth.
 */
const FONT_SIZE = 13.5;
const LINE_RATIO = 1.45;
const LINE = FONT_SIZE * LINE_RATIO;
const CEILING = 96;

/** Each state's placeholder and hint; `why` is the offline reason. */
const STATE: Record<ComposerState, { ph: string; hint: string; why?: string }> = {
  ready: { ph: "Ask your brain anything…", hint: "⌘K for commands · ⏎ to send · ⇧⏎ for a new line" },
  streaming: { ph: "Add to the question while it works…", hint: "esc or the stop button ends the run" },
  reconnecting: { ph: "Reconnecting to the host…", hint: "queued locally · sends when the host answers" },
  dictating: { ph: "Dictating…", hint: "Stop to review your words" },
  offline: { ph: "The host is unreachable", hint: "", why: "needs the host · your draft is kept" },
};

export function Composer(p: ComposerProps) {
  const v = p.variant || "send";
  const st: ComposerState = p.state && STATE[p.state] ? p.state : "ready";
  const s = STATE[st];
  const offline = st === "offline";
  const streaming = st === "streaming";
  const dictating = st === "dictating";
  const sendDisabled = offline || dictating;

  const placeholder = p.placeholder ?? s.ph;
  const hint = p.hint ?? s.hint;
  const blockedWhy = offline ? (p.blockedWhy ?? s.why) : undefined;
  const recall = p.recall ?? [];

  const showAttach = p.attach !== false && v !== "plain";
  const showMic = p.mic !== false && (v === "send" || v === "plain");
  const voiceReasonId = useId();
  const voiceUnavailable = p.micUnavailable !== undefined;
  const voiceAct = Boolean(p.onMic) || voiceUnavailable;
  const showSend = v === "send" && !streaming;
  const showStop = v === "send" && streaming;
  const editable = Boolean(p.onChange) && !dictating;
  const hintRow = Boolean(p.provider || hint || blockedWhy);
  const hintId = useId();

  // `Math.max(1, …)` for the same reason `rows` has it below: `maxRows` is a
  // number off a prop. A negative one used to be harmless — the cap was a
  // constant — but it now reaches `maxHeight`, where a negative length is a
  // declaration the browser drops, leaving the field uncapped.
  const maxRows = Math.max(1, Number(p.maxRows) || 5);
  const lines = (p.value ?? "").split("\n").length;
  const rows = Math.max(1, Math.min(maxRows, lines));

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape" && streaming && p.onStop) {
      event.preventDefault();
      p.onStop();
      return;
    }
    // ⇧⏎ is a newline and reaches the textarea untouched; ⏎ alone sends, but
    // only when somebody is listening — and never into an unreachable host.
    if (event.key !== "Enter" || event.shiftKey || !p.onSend || sendDisabled) return;
    event.preventDefault();
    p.onSend(event.currentTarget.value);
  }

  const field: CSSProperties = {
    // The attach tooltip anchors to the field, so it clears a grown field.
    position: "relative",
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
    // `maxRows` lines, but never past the design's 96px ceiling — which is what
    // a constant `maxHeight: 96` already did while `rows` bounded the growth.
    // Rounded because `3 * 19.575` is `58.724999999999994` in binary floating
    // point, and that is what would land in the style attribute.
    maxHeight: Math.round(Math.min(CEILING, maxRows * LINE) * 1000) / 1000,
    // Only with text to follow: an empty field is one row whatever its
    // placeholder, and an uncontrolled one is the browser's.
    fieldSizing: p.value ? "content" : undefined,
    font: `400 ${FONT_SIZE}px/${LINE_RATIO} ${font.body}`,
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
    ...(sendDisabled ? { opacity: 0.45, cursor: "default", pointerEvents: "none" } : { cursor: sendAct ? "pointer" : "default" }),
  };
  const send = () => p.onSend?.(p.value ?? "");

  const stopAct = Boolean(p.onStop);

  const mono = (weight: number, size: number): string => `${weight} ${size}px/1.5 ${font.mono}`;
  const oneLine: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

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
            <IconButton icon="attach" label={p.attachLabel || ATTACH_LABEL} haspopup="menu" tip onClick={dictating ? undefined : p.onAttach} />
          ) : null}
          <textarea
            data-composer=""
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
          {showMic ? <IconButton icon="mic" label={p.micLabel ?? (dictating ? "Stop dictation" : "Dictate")} tip={p.micTip === true && !dictating} unavailable={dictating ? undefined : p.micUnavailable} targetSize={dictating ? 44 : 28} onClick={p.onMic} /> : null}
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
              className={sendAct && !sendDisabled ? "bk-control" : undefined}
              role={sendAct ? "button" : undefined}
              aria-label={sendAct ? (sendDisabled ? "Send — unavailable" : "Send") : undefined}
              aria-disabled={sendAct && sendDisabled ? true : undefined}
              tabIndex={sendAct ? (sendDisabled ? -1 : 0) : undefined}
              onClick={sendAct && !sendDisabled ? send : undefined}
              onKeyDown={sendAct && !sendDisabled ? pressable(send) : undefined}
            >
              <Icon icon="send" size={15} color={color.onFill} />
            </span>
          ) : null}
        </div>
        {v === "voice" && p.mic !== false ? (
          <span
            style={{ ...disc(54, accent.amber.fill, true), ...(voiceUnavailable ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
            className={voiceAct ? "bk-control" : undefined}
            role={voiceAct ? "button" : undefined}
            aria-label={voiceAct ? (p.micLabel ?? "Hold to talk") : undefined}
            aria-disabled={voiceUnavailable ? true : undefined}
            aria-describedby={voiceUnavailable ? voiceReasonId : undefined}
            title={p.micUnavailable}
            tabIndex={voiceAct ? 0 : undefined}
            onClick={voiceUnavailable ? undefined : p.onMic}
            onKeyDown={p.onMic && !voiceUnavailable ? pressable(() => p.onMic?.()) : undefined}
          >
            <Icon icon="mic" size={24} color={color.onFill} />
            {voiceUnavailable ? <span id={voiceReasonId} hidden>{p.micUnavailable}</span> : null}
          </span>
        ) : null}
      </div>
      {hintRow ? (
        // One line, whatever it holds (#1013): a reason that arrives or leaves
        // with the connection must not change the composer's height, which
        // would move the field under the writer. Text that does not fit ends
        // in an ellipsis, and the hint gives way first.
        <div id={hintId} className={p.hint === undefined && st === "ready" && !p.provider && !blockedWhy ? "bk-keyboard-hint" : undefined} data-composer-hint="" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap", minHeight: 14, minWidth: 0 }}>
          {p.provider ? (
            <span
              style={
                {
                  flex: "0 1 auto",
                  minWidth: 0,
                  ...oneLine,
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
              aria-label={p.onProvider ? `Model — ${p.provider}${p.providerDetail ? ` · effort ${p.providerDetail} for the next message${p.providerDetailExplanation ? ` (${p.providerDetailExplanation})` : ""}` : ""}` : undefined}
              aria-haspopup={p.onProvider ? (p.providerControls ? "dialog" : "listbox") : undefined}
              aria-expanded={p.onProvider ? p.providerExpanded : undefined}
              aria-controls={p.onProvider ? p.providerControls : undefined}
              data-model-trigger={p.onProvider ? "" : undefined}
              tabIndex={p.onProvider ? 0 : undefined}
              onClick={p.onProvider}
              onKeyDown={p.onProvider ? pressable(() => p.onProvider?.()) : undefined}
            >
              {p.provider}
              {p.providerDetail ? <span style={{ color: accent.amber.ink }}> · {p.providerDetail}</span> : null}
            </span>
          ) : null}
          {hint ? <span className={p.hint === undefined && st === "ready" ? "bk-keyboard-hint" : undefined} style={{ flex: "1 1 0", minWidth: 0, ...oneLine, font: mono(400, 10), color: color.inkMute }}>{p.hint === undefined && st === "streaming" ? <><span className="bk-keyboard-hint">esc or </span>the stop button ends the run</> : hint}</span> : null}
          {blockedWhy ? <span style={{ flex: "0 1 auto", minWidth: 0, ...oneLine, font: mono(500, 10), color: accent.gold.ink }}>{blockedWhy}</span> : null}
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
 * The attach tooltip's dismissal (#3045), on the trigger's own attribute. While
 * the pointer is over it, Escape anywhere hides it — WCAG 1.4.13 asks for that
 * without moving the pointer, even while focus is in the field — and Escape
 * keeps every other meaning it has there (stopping a run); nothing is
 * prevented. Leaving or blurring clears the dismissal for the next visit.
 */
const tipListeners = new WeakMap<HTMLElement, AbortController>();

function dismissTip(trigger: HTMLElement) {
  trigger.setAttribute("data-tip-dismissed", "");
}

function armTip(trigger: HTMLElement) {
  tipListeners.get(trigger)?.abort();
  const controller = new AbortController();
  tipListeners.set(trigger, controller);
  trigger.ownerDocument.addEventListener("keydown", (event) => {
    if (!trigger.isConnected) { controller.abort(); return; }
    if (event.key === "Escape") dismissTip(trigger);
  }, { signal: controller.signal });
}

function resetTip(trigger: HTMLElement, left: boolean) {
  if (left) {
    tipListeners.get(trigger)?.abort();
    tipListeners.delete(trigger);
  } else if (trigger.matches(":hover")) {
    // Focus moving into the menu this trigger just opened is not a new visit:
    // under a still-hovering pointer the tooltip would paint over the menu.
    return;
  }
  trigger.removeAttribute("data-tip-dismissed");
}

/**
 * The paperclip and the microphone inside the field: a 28px round target
 * with a hover veil. During dictation the mic expands to a 44px stop target.
 *
 * Each gains an optional callback and D20's gating rule does the rest: with no
 * handler this renders exactly the icon the source renders, with no role, no
 * ring and no tab stop. The paperclip is a menu trigger, so it also says so.
 *
 * ## The paperclip's tooltip is its name, shown (#3045)
 *
 * A glyph with no text is only discoverable if its name can be seen, so an
 * actionable `tip` trigger also paints its `label` above the field — the same
 * string, so the visible label is the accessible name (WCAG 2.5.3) and a
 * screen reader hears it once; the painted copy is `aria-hidden`. `theme.css`'s
 * `.bk-tip` owns the timing: shown after 400ms of hover, at once on keyboard
 * focus, and never under `(hover: none)`, where the app's sheet names the
 * actions instead. It is a descendant of the trigger, so the pointer can move
 * onto it without losing it (WCAG 1.4.13). Dismissal is the only state, and it
 * is kept on the trigger itself (`data-tip-dismissed`, which React never
 * renders) rather than in a hook, so the composer still costs one render per
 * keystroke: Escape, or opening the menu, hides it until the pointer leaves or
 * focus moves away. An inert trigger — a dictating composer — has no tooltip.
 */
function IconButton(props: { icon: "attach" | "mic"; label: string; haspopup?: "menu"; tip?: boolean; unavailable?: string; targetSize?: number; onClick?: () => void }) {
  const reasonId = useId();
  const unavailable = props.unavailable;
  // Unavailable still names itself and explains why, so it stays reachable.
  const act = Boolean(props.onClick) || unavailable !== undefined;
  const tip = act && (props.tip === true || unavailable !== undefined);
  const activate = (target: HTMLElement) => {
    if (tip) dismissTip(target);
    if (unavailable === undefined) props.onClick?.();
  };
  return (
    <span
      style={
        {
          width: props.targetSize ?? 28,
          height: props.targetSize ?? 28,
          borderRadius: 999,
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: unavailable !== undefined ? "not-allowed" : act ? "pointer" : "default",
          opacity: unavailable !== undefined ? 0.45 : undefined,
          "--hv-bg": token("hover-veil-strong"),
        } as CSSProperties
      }
      className={act ? (tip ? "bk-control bk-tip-host" : "bk-control") : undefined}
      role={act ? "button" : undefined}
      aria-label={act ? props.label : undefined}
      aria-disabled={unavailable !== undefined ? true : undefined}
      aria-describedby={unavailable !== undefined ? reasonId : undefined}
      aria-haspopup={act ? props.haspopup : undefined}
      tabIndex={act ? 0 : undefined}
      onClick={act ? (event) => activate(event.currentTarget) : undefined}
      onKeyDown={act ? (event) => {
        if (tip && event.key === "Escape") { dismissTip(event.currentTarget); return; }
        const target = event.currentTarget;
        pressable(() => activate(target))(event);
      } : undefined}
      onPointerEnter={tip ? (event) => armTip(event.currentTarget) : undefined}
      onPointerLeave={tip ? (event) => resetTip(event.currentTarget, true) : undefined}
      onBlur={tip ? (event) => resetTip(event.currentTarget, false) : undefined}
    >
      <Icon icon={props.icon} size={17} color={color.inkMute} />
      {tip ? <span id={unavailable !== undefined ? reasonId : undefined} className="bk-tip" data-composer-tip="" aria-hidden="true">{unavailable ?? props.label}</span> : null}
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
