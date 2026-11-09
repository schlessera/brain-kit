import { Button, IconButton, Overlay } from "@schlessera/brain-ui-kit";
import { useEffect, useId, useRef, type RefObject } from "react";
import { providerDestination, providerLabel } from "../../voice/dictation-providers.js";
import type { DictationGate } from "../../voice/voice-state.js";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { useFinePointer } from "../../hooks/use-fine-pointer.js";
import { Mic, X } from "lucide-react";
import { useVoiceStore } from "../../voice/voice-store.js";
import { cn } from "../../lib/utils.js";

const MIC = '[aria-label^="Dictate"], [aria-label="Stop dictation"]';

export function DictationSheet({
  open,
  onStop,
  onCancel,
  onConfirm,
  onOpenSettings,
  composerRef,
}: {
  open: boolean;
  onStop: () => void;
  onCancel: () => void;
  /** Start dictation on the acknowledgement card. */
  onConfirm?: () => void;
  /** Settings › Voice, from a take that has nowhere to go. */
  onOpenSettings?: () => void;
  composerRef?: RefObject<HTMLDivElement | null>;
}) {
  const desktop = useMediaQuery("(min-width: 900px)");
  const finePointer = useFinePointer();
  const doneRef = useRef<HTMLButtonElement>(null);
  const partial = useVoiceStore((s) => s.partial);
  const finalText = useVoiceStore((s) => s.finalText);
  const audioLevel = useVoiceStore((s) => s.audioLevel);
  const error = useVoiceStore((s) => s.error);
  const draining = useVoiceStore((s) => s.draining);
  // Mic still opening — the session is being fetched, so capture isn't live
  // yet. Drives the honest "Connecting…" state instead of claiming "Listening".
  const connecting = useVoiceStore((s) => s.connecting);
  const target = useVoiceStore((s) => s.dictationTarget);
  const gate = useVoiceStore((s) => s.dictationGate);
  const gateRef = useRef<HTMLButtonElement>(null);
  // Text already under review — the current capture appends to it on stop,
  // so show it dimmed as the lead-in.
  const reviewText = useVoiceStore((s) => s.reviewText);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const statusLabel = gate?.kind === "consent"
    ? "Before you dictate"
    : gate
      ? "Dictation unavailable"
      : connecting
    ? "Connecting…"
    : draining
      ? "Finalizing…"
      : "Listening";
  // The service this take was sent to, frozen with it (#3709). A provider
  // that names a third-party destination, or browser speech, is called out.
  const providerNote = target ? { text: `To ${providerLabel(target)}`, warn: Boolean(target.destination) || target.id === "webspeech" } : null;

  // Keep the newest words in view — the live transcript grows past the
  // sheet's height quickly when dictating longer prompts.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [finalText, partial, open, desktop]);

  useEffect(() => {
    if (!open || !desktop) return;
    const composer = composerRef?.current;
    doneRef.current?.focus();
    return () => {
      composer?.querySelector<HTMLElement>(MIC)?.focus();
    };
  }, [open, desktop, composerRef]);

  // The acknowledgement focuses Start dictation; a blocked take, Open Settings.
  useEffect(() => {
    if (open && gate) gateRef.current?.focus();
  }, [open, gate]);

  // Start dictation removes the control that held focus. When focus was in
  // the card, it continues on Done, so the keyboard can finish the take; the
  // phone sheet's initial focus has already run and does not run again.
  const cardRef = useRef<HTMLDivElement>(null);
  const continueFocus = useRef(false);
  const confirm = onConfirm && (() => {
    continueFocus.current = Boolean(cardRef.current?.contains(document.activeElement));
    onConfirm();
  });
  useEffect(() => {
    if (gate || !continueFocus.current) return;
    continueFocus.current = false;
    if (open) doneRef.current?.focus();
  }, [open, gate]);

  useEffect(() => {
    if (!open || !desktop || draining) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, desktop, draining, onCancel]);

  const content = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className={desktop ? "flex shrink-0 items-center justify-between gap-3 border-b border-border/50 px-4 py-2.5" : "flex items-center justify-between border-b border-border/50 px-5 py-3"}>
          <div role={desktop ? "status" : undefined} className="flex items-center gap-2">
            <span className="relative inline-flex h-2 w-2">
              {/* Pulse only once capture is actually live — a "connecting" dot
                  must not imply the mic is already open. */}
              {!connecting && !gate && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary-mark opacity-75" />
              )}
              <span
                className={cn(
                  "relative inline-flex h-2 w-2 rounded-full",
                  connecting || gate ? "bg-muted-foreground/50" : "bg-primary-mark"
                )}
              />
            </span>
            <span className="font-[family-name:var(--font-mono)] text-xs uppercase tracking-widest text-muted-foreground">
              {statusLabel}
            </span>
          </div>
          {desktop && !gate && <div className="ml-auto flex items-center"><Waveform level={audioLevel} compact /></div>}
          {desktop ? <IconButton size="md" name="Cancel dictation" glyph={<X className="h-4 w-4" />} onClick={onCancel} disabled={draining} /> : <span aria-hidden="true" style={{ width: 44, height: 44 }} />}
        </div>

        {/* Active-provider note — subtle for Deepgram, amber for the browser
            speech fallback whose audio leaves the device. */}
        {providerNote && !error && (
          <div
            className={cn(
              "px-5 pt-2 text-center text-[11px]",
              providerNote.warn
                ? "text-primary/90"
                : "text-muted-foreground/50"
            )}
          >
            {providerNote.text}
          </div>
        )}

        {gate ? <DictationGateCard gate={gate} cardRef={cardRef} actionRef={gateRef} onCancel={onCancel} onConfirm={confirm} onOpenSettings={onOpenSettings} /> : <>
        {/* Waveform */}
        {!desktop && <div className="flex items-center justify-center px-6 py-4">
          <Waveform level={audioLevel} />
        </div>}

        {/* Transcript */}
        <div ref={transcriptRef} data-dictation-transcript="" className={desktop ? "min-h-[calc(4.875rem+1.5rem)] flex-1 overflow-y-auto px-5 py-3" : "flex-1 overflow-y-auto px-6 pb-6"}>
          {error ? (
            <div className="rounded-lg bg-destructive-fill/10 p-4 text-sm text-destructive">
              {error}
            </div>
          ) : (
            <p className="text-base leading-relaxed">
              {reviewText && (
                <span className="text-muted-foreground/50">{reviewText} </span>
              )}
              <span className="text-foreground">{finalText}</span>
              {finalText && partial && " "}
              <span className="text-muted-foreground/60">{partial}</span>
              {!reviewText && !finalText && !partial && (
                <span className="text-muted-foreground/40">
                  Speak to start...
                </span>
              )}
            </p>
          )}
        </div>

        {/* Big stop button — thumb-friendly */}
        <div className={desktop ? "shrink-0 border-t border-border/50 px-4 py-3" : "border-t border-border/50 p-4"}>
          <button /* raw-button: api — Opening focus needs a ref that kit Button does not accept. */
            type="button"
            ref={doneRef}
            onClick={onStop}
            disabled={draining}
            className={cn("flex w-full items-center justify-center gap-3 rounded-xl bg-primary-fill text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-[0.99] disabled:opacity-60 disabled:cursor-progress", desktop ? "h-11" : "h-14")}
          >
            <Mic className="h-5 w-5" />
            <span className="text-sm font-semibold uppercase tracking-wider">
              {draining ? "Finalizing…" : "Done"}
            </span>
          </button>
          <p className="mt-2 text-center text-[11px] text-muted-foreground/50">
            {draining
              ? "Waiting for the last words…"
              : desktop
                ? finePointer ? "Enter on Done or click the mic to stop · esc to cancel" : "Tap Done or the mic to stop"
                : "Tap anywhere outside to stop"}
          </p>
        </div>
        </>}
      </div>
  );
  if (desktop) return open ? (
    <div role="dialog" aria-modal={false} aria-label="Dictation"
      className="absolute inset-x-0 bottom-full z-popover mb-2 flex max-h-[min(60vh,32rem)] flex-col overflow-hidden rounded-xl border border-[var(--bk-color-edge)] bg-[var(--bk-color-raised)] shadow-2xl transition-none">
      {content}
    </div>
  ) : null;
  return (
    <Overlay open={open} variant="sheet" label="Dictation" data-dictation="" closeLabel="Cancel dictation" initialFocus={gate ? gateRef : doneRef} closedBy={draining ? "none" : "any"}
      // Outside a gate, a tap outside stops and keeps the words; on a gate it opens nothing.
      onClose={reason => !gate && (reason === "scrim" || reason === "swipe") ? onStop() : onCancel()}
      // A breakpoint move unmounts the modal after the desktop has focused
      // its replacement Done. Preserve that focus; a real close returns to mic.
      returnFocus={() => doneRef.current ?? gateRef.current ?? composerRef?.current?.querySelector<HTMLElement>(MIC) ?? null}>
      {content}
    </Overlay>
  );
}

/**
 * Before any session request or microphone access: the one-time
 * acknowledgement of where audio goes (D4), or why there is nowhere to send
 * it. Neither offers a per-take change of service (D2).
 */
function DictationGateCard({ gate, cardRef, actionRef, onCancel, onConfirm, onOpenSettings }: {
  gate: DictationGate;
  cardRef: RefObject<HTMLDivElement | null>;
  actionRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm?: () => void;
  onOpenSettings?: () => void;
}) {
  const id = useId();
  const consent = gate.kind === "consent";
  const title = consent ? `Dictation goes to ${providerLabel(gate.provider)}`
    : gate.reason === "none" ? "Dictation isn\u0027t set up on this host"
    : gate.reason === "unavailable" ? "Your dictation service isn\u0027t available"
    : "Choose a dictation service";
  const text = consent ? `${providerDestination(gate.provider)} Words land in your draft; nothing is sent until you send it.`
    : gate.reason === "none" ? "Nothing was captured."
    : gate.reason === "unavailable" ? `${gate.saved ? `${gate.saved} isn\u0027t available on this host. ` : ""}Choose a dictation service in Settings › Voice. Nothing was captured.`
    : "Choose a dictation service in Settings › Voice. Nothing was captured.";
  const action = consent ? { label: "Start dictation", run: onConfirm } : gate.reason === "none" ? null : { label: "Open Settings", run: onOpenSettings };
  return <div ref={cardRef} role="group" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`} data-dictation-gate={gate.kind} className="flex flex-col gap-3 px-5 py-4">
    <p id={`${id}-title`} className="text-base font-semibold text-foreground">{title}</p>
    <p id={`${id}-text`} className="text-sm leading-relaxed text-muted-foreground">{text}</p>
    <div className="flex flex-wrap justify-end gap-2">
      <Button label={action ? "Cancel" : "Close"} tone="ghost" block={false} reach onClick={onCancel} />
      {action && <button /* raw-button: api — Opening focus needs a ref that kit Button does not accept. */
        type="button" ref={actionRef} onClick={action.run}
        className="flex min-h-11 items-center justify-center rounded-xl bg-primary-fill px-4 text-sm font-semibold text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-[0.99]">
        {action.label}
      </button>}
    </div>
  </div>;
}

function Waveform({ level, compact = false }: { level: number; compact?: boolean }) {
  // Render 16 bars whose height is driven by current level + per-bar phase.
  const bars = 16;
  return (
    <div className={cn("flex items-center gap-1.5", compact ? "h-8" : "h-16")}>
      {Array.from({ length: bars }).map((_, i) => {
        const phase = (i / bars) * Math.PI;
        const offset = (Math.sin(phase + Date.now() / 200) + 1) / 2;
        const h = (8 + level * 56 * (0.4 + 0.6 * offset)) * (compact ? 0.5 : 1);
        return (
          <span
            key={i}
            style={{ height: `${h}px` }}
            className="w-1.5 rounded-full bg-primary-mark transition-[height] duration-75 ease-linear"
          />
        );
      })}
    </div>
  );
}
