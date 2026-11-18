import { useId, useState, type KeyboardEvent } from "react";

import { Icon } from "../primitives/Icon.js";
import { VoiceField } from "./VoiceField.js";
import type { VoiceMotion } from "./tone.js";

export interface StartCardPersona {
  id: string;
  name: string;
  /** The voice this persona speaks with on this service, in plain words:
   * `voice Kore · calm, brief`, or `no Gemini voice set`. */
  voice?: string;
}

/**
 * A state that changes what Start does, shown above the Start button:
 *
 *   warn   S3: the persona has no voice on this service; the default is used
 *          and named. Start stays enabled.
 *   block  S3c/S3d: Start is unavailable until the user acts (instructions
 *          over the service's cap; the saved service is unavailable).
 *   error  S3b: the saved voice is invalid or stale; recovery is required.
 */
export interface StartCardNotice {
  kind: "warn" | "block" | "error";
  text: string;
  action?: { label: string; onClick?: () => void };
}

export interface StartCardProps {
  /** The service that will hear you, named in the disclosure line. `null`
   * when the user must pick one first (S3d). */
  service: string | null;
  /** The disclosure line after the service: `hears you and reads this chat.` */
  disclosure?: string;
  /** The full list behind "What's shared". */
  shared?: string[];
  /** Change the service for this conversation. Pass it only when more than
   * one service is usable; without it the Service row has no Change. */
  onChangeService?: () => void;
  /** Show the Service row. On whenever `onChangeService` is passed or no
   * service is chosen. */
  showService?: boolean;
  personas?: StartCardPersona[];
  selectedPersona?: string;
  onSelectPersona?: (id: string) => void;
  notice?: StartCardNotice;
  onStart?: () => void;
  /** × and a swipe down. */
  onCancel?: () => void;
  startLabel?: string;
  motion?: VoiceMotion;
}

/**
 * Start, as the field opening up (S2): one line on what is shared, the
 * Service row with Change, the inline persona list and one Start button.
 * Nothing here starts a microphone, reads history or contacts a provider;
 * `onStart` is the only way out that does.
 */
export function StartCard(p: StartCardProps) {
  const [sharedOpen, setSharedOpen] = useState(false);
  const sharedId = useId();
  const noticeId = useId();
  const personas = p.personas ?? [];
  const blocked = p.notice?.kind === "block" || p.notice?.kind === "error" || p.service === null;
  const showService = p.showService ?? (p.onChangeService !== undefined || p.service === null);
  const tone = p.notice?.kind === "error" ? "fail" : p.notice ? "you" : "brain";

  const pick = (id: string) => p.onSelectPersona?.(id);
  // A radio group moves with the arrow keys, and selection follows focus.
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step || personas.length === 0) return;
    e.preventDefault();
    const next = (i + step + personas.length) % personas.length;
    const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]");
    buttons?.[next]?.focus();
    pick(personas[next]!.id);
  };

  return (
    <VoiceField shape="card" tone="brain" name="Start a live conversation" motion={p.motion}>
      <div className="bk-voice-card-head">
        <span className="bk-voice-card-icon" aria-hidden="true">
          <Icon icon="speaker" size={14} strokeWidth={2.5} />
        </span>
        <p className="bk-voice-card-line">
          {p.service ? <strong>{p.service}</strong> : "A live service"} {p.disclosure ?? "hears you and reads this chat."}
        </p>
        {p.onCancel ? (
          <button type="button" className="bk-voice-close" aria-label="Cancel" onClick={p.onCancel}>
            <span><Icon icon="dismiss" size={14} strokeWidth={2.5} /></span>
          </button>
        ) : null}
      </div>
      {showService ? (
        <div className="bk-voice-service" data-required={p.service === null ? "true" : undefined}>
          <span className="bk-voice-service-key">Service</span>
          <span className="bk-voice-service-name">{p.service ?? "Choose a service"}</span>
          {p.onChangeService ? (
            <button type="button" className="bk-voice-link" aria-label={p.service ? `Change service, now ${p.service}` : "Choose a service"} onClick={p.onChangeService}>
              {p.service ? "Change" : "Choose"}
            </button>
          ) : null}
        </div>
      ) : null}
      {personas.length ? (
        <div className="bk-voice-personas" role="radiogroup" aria-label="Persona">
          {personas.map((persona, i) => {
            const checked = persona.id === p.selectedPersona;
            const focusable = checked || (p.selectedPersona === undefined && i === 0);
            return (
              <button
                key={persona.id}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={focusable ? 0 : -1}
                className="bk-voice-persona"
                onClick={() => pick(persona.id)}
                onKeyDown={(e) => onKey(e, i)}
              >
                <span style={{ minWidth: 0 }}>
                  <span className="bk-voice-persona-name">{persona.name}</span>
                  {persona.voice ? <span className="bk-voice-persona-voice">{persona.voice}</span> : null}
                </span>
                {checked ? (
                  <span className="bk-voice-persona-check" aria-hidden="true"><Icon icon="confirm" size={16} strokeWidth={2.5} /></span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {p.notice ? (
        <div className="bk-voice-tone" data-tone={tone} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <p className="bk-voice-card-notice" id={noticeId}>
            <span className="bk-voice-label-icon" aria-hidden="true">
              <Icon icon={p.notice.kind === "error" ? "failed" : p.notice.kind === "block" ? "attention" : "fyi"} size={14} strokeWidth={2.25} />
            </span>
            <span>{p.notice.text}</span>
          </p>
          {p.notice.action ? (
            <div className="bk-voice-actions" style={{ justifyContent: "flex-start" }}>
              <button type="button" className="bk-voice-action" onClick={p.notice.action.onClick}>{p.notice.action.label}</button>
            </div>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className="bk-voice-start"
        aria-disabled={blocked || undefined}
        aria-describedby={p.notice ? noticeId : undefined}
        onClick={blocked ? undefined : p.onStart}
      >
        <Icon icon="mic" size={16} strokeWidth={2.25} />
        {p.startLabel ?? "Start"}
      </button>
      {p.shared?.length ? (
        <>
          <button type="button" className="bk-voice-link bk-voice-shared" aria-expanded={sharedOpen} aria-controls={sharedId} onClick={() => setSharedOpen((o) => !o)}>
            What’s shared {sharedOpen ? "‹" : "›"}
          </button>
          {sharedOpen ? (
            <ul className="bk-voice-shared-list" id={sharedId}>
              {p.shared.map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : null}
        </>
      ) : null}
    </VoiceField>
  );
}
