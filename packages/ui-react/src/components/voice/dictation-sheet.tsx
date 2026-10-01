import { useEffect, useRef, type RefObject } from "react";
import { useMediaQuery } from "../../hooks/use-media-query.js";
import { useFinePointer } from "../../hooks/use-fine-pointer.js";
import { Mic, X } from "lucide-react";
import { useVoiceStore } from "../../voice/voice-store.js";
import { cn } from "../../lib/utils.js";

export function DictationSheet({
  open,
  onStop,
  onCancel,
  composerRef,
}: {
  open: boolean;
  onStop: () => void;
  onCancel: () => void;
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
  const providerId = useVoiceStore((s) => s.providerId);
  // Text already under review — the current capture appends to it on stop,
  // so show it dimmed as the lead-in.
  const reviewText = useVoiceStore((s) => s.reviewText);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const statusLabel = connecting
    ? "Connecting…"
    : draining
      ? "Finalizing…"
      : "Listening";
  // Surface the active provider so a silent fallback to browser speech (which
  // streams mic audio to Google on Chrome) isn't invisible.
  const providerNote = providerNoteFor(providerId);

  // Keep the newest words in view — the live transcript grows past the
  // sheet's height quickly when dictating longer prompts.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [finalText, partial, open, desktop]);

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Escape cancels
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, onCancel]);

  useEffect(() => {
    if (!open || !desktop) return;
    const composer = composerRef?.current;
    doneRef.current?.focus();
    return () => {
      composer?.querySelector<HTMLElement>('[aria-label="Dictate"], [aria-label="Stop dictation"]')?.focus();
    };
  }, [open, desktop, composerRef]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop — tap-to-stop is intentional: huge target. Disabled while
          draining so a stray tap doesn't double-trigger. */}
      {!desktop && <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        onClick={() => { if (!draining) onStop(); }}
      />}

      {/* The desktop panel shares the content and effects with the phone sheet. */}
      <div
        className={cn(
          desktop
            ? "absolute inset-x-0 bottom-full z-50 mb-2 flex max-h-[min(60vh,32rem)] flex-col overflow-hidden rounded-xl border border-[var(--bk-color-edge)] bg-[var(--bk-color-raised)] shadow-2xl transition-none"
            : "fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-3xl border-t border-border bg-surface shadow-[0_-16px_48px_rgba(0,0,0,0.5)] max-h-[60vh] min-h-[40vh] dictation-sheet-phone"
        )}
        role={desktop ? "dialog" : undefined}
        aria-modal={desktop ? false : undefined}
        aria-label={desktop ? "Dictation" : undefined}
        // Don't propagate to backdrop
        onClick={(e) => e.stopPropagation()}
      >
        <div className={desktop ? "flex shrink-0 items-center justify-between gap-3 border-b border-border/50 px-4 py-2.5" : "flex items-center justify-between border-b border-border/50 px-5 py-3"}>
          <div role={desktop ? "status" : undefined} className="flex items-center gap-2">
            <span className="relative inline-flex h-2 w-2">
              {/* Pulse only once capture is actually live — a "connecting" dot
                  must not imply the mic is already open. */}
              {!connecting && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary-mark opacity-75" />
              )}
              <span
                className={cn(
                  "relative inline-flex h-2 w-2 rounded-full",
                  connecting ? "bg-muted-foreground/50" : "bg-primary-mark"
                )}
              />
            </span>
            <span className="font-[family-name:var(--font-mono)] text-xs uppercase tracking-widest text-muted-foreground">
              {statusLabel}
            </span>
          </div>
          {desktop && <div className="ml-auto flex items-center"><Waveform level={audioLevel} compact /></div>}
          <button
            type="button"
            aria-label="Cancel dictation"
            onClick={onCancel}
            disabled={draining}
            title="Cancel"
            className={cn("rounded-lg p-2 text-muted-foreground hover:bg-surface-raised hover:text-foreground disabled:opacity-30", desktop && "flex h-11 w-11 shrink-0 items-center justify-center")}
          >
            <X className="h-4 w-4" />
          </button>
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
          <button
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
      </div>
    </>
  );
}

/** Human-readable note for the active speech provider, or null if unknown. */
function providerNoteFor(
  providerId: string | null
): { text: string; warn: boolean } | null {
  switch (providerId) {
    case "deepgram":
      return { text: "via Deepgram", warn: false };
    case "webspeech":
      // Browser speech (Chrome) streams mic audio to Google — call it out.
      return { text: "via browser speech · audio goes to Google", warn: true };
    case null:
      return null;
    default:
      return { text: `via ${providerId}`, warn: false };
  }
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
