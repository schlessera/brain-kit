import { VoiceControlButton, VoiceField, VoiceNotice, VoiceText } from "@schlessera/brain-ui-kit";
import { useEffect, useLayoutEffect, useRef } from "react";
import { dictationNoticeForm } from "../../voice/dictation-failure.js";
import { providerAudioPolicy, providerMeta, providerRecipient, savedServiceName } from "../../voice/dictation-providers.js";
import { useVoiceStore } from "../../voice/voice-store.js";

/*
 * Dictation in the voice field (#3694, epic #3690), drawn from the kit's
 * signed-off components unchanged (`dictation()` in
 * packages/ui-kit/stories/voice/_voice.tsx). The capture states replace the
 * composer; the notices sit above it, and the composer's mic stays drawn.
 *
 *   D0  first take: where the words go, before any session or microphone
 *   Dx  nowhere to send them: no service, or the saved one is gone
 *   Dc  connecting: grey, "Not listening yet", the destination already named
 *   D2  the browser is asking for the microphone
 *   D3  listening · D4 quiet · D5 finishing, each naming the destination
 *   D7  microphone blocked · D8 stopped, quoting the words kept in the draft
 *
 * D1 and D6 are the composer itself, at rest and holding the dictated words.
 */

/** Focus the button with this text inside `root` (the kit notice takes no ref). */
function focusButton(root: HTMLElement | null, label: string): boolean {
  const target = [...root?.querySelectorAll("button") ?? []].find((b) => b.textContent?.trim() === label);
  target?.focus({ preventScroll: true });
  return Boolean(target);
}

/** Whether the voice field is being captured into: Dc, D2 or D3–D5. */
export function useDictationCapturing(): boolean {
  return useVoiceStore((s) => s.mode === "dictate" && s.dictationGate === null);
}

/**
 * Dc, D2 and D3–D5, in place of the composer. Focus follows the take: the
 * trailing control of each form (Cancel dictation, Cancel, Finish dictation)
 * takes it when the form changes and focus was in the field or nowhere.
 */
export function DictationCapture({ onFinish, onCancel }: { onFinish: () => void; onCancel: () => void }) {
  const connecting = useVoiceStore((s) => s.connecting);
  const micPrompt = useVoiceStore((s) => s.micPrompt);
  const quiet = useVoiceStore((s) => s.quiet);
  const draining = useVoiceStore((s) => s.draining);
  const finalText = useVoiceStore((s) => s.finalText);
  const partial = useVoiceStore((s) => s.partial);
  const level = useVoiceStore((s) => s.audioLevel);
  const target = useVoiceStore((s) => s.dictationTarget);
  const ref = useRef<HTMLDivElement>(null);
  const form = draining ? "D5" : connecting ? micPrompt ? "D2" : "Dc" : quiet ? "D4" : "D3";
  const meta = target ? providerMeta(target) : undefined;

  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body && !ref.current?.contains(active)) return;
    ref.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus({ preventScroll: true });
  }, [form]);

  // Esc cancels the take, as it did before the voice field; a take that is
  // finishing (D5) is already handing its words to the draft, so it refuses.
  useEffect(() => {
    if (form === "D5") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [form, onCancel]);

  const finish = (busy: boolean) => (
    <VoiceControlButton name={busy ? "Finishing dictation" : "Finish dictation"} icon="confirm" tone="you" busy={busy} onClick={busy ? undefined : onFinish} />
  );
  return (
    <div ref={ref} className="mb-0" data-dictation-field={form}>
      {form === "D2" ? (
        <VoiceNotice tone="you" icon="mic" title="Allow the microphone" body="Your browser is asking. You only need to do this once." actions={[{ label: "Cancel", onClick: onCancel }]} />
      ) : form === "Dc" ? (
        <VoiceField
          shape="compact"
          tone="idle"
          label={{ icon: "loading", word: "Connecting", meta, spin: true }}
          meter="none"
          trailing={<VoiceControlButton name="Cancel dictation" icon="dismiss" onClick={onCancel} />}
        >
          <VoiceText placeholder="Not listening yet" />
        </VoiceField>
      ) : (
        <VoiceField
          shape="compact"
          tone="you"
          label={{ icon: "mic", word: form === "D5" ? "Finishing" : "Listening", meta }}
          meter={form === "D5" ? "sweep" : form === "D4" ? "flat" : "level"}
          level={form === "D3" ? level : undefined}
          trailing={finish(form === "D5")}
        >
          <VoiceText text={finalText} partial={partial} placeholder="Say something…" />
        </VoiceField>
      )}
    </div>
  );
}

/**
 * D0, Dx, D7 and D8, above the composer. D0 focuses Start dictation (K1) and
 * a blocked take Open Settings; Esc on either is Cancel. `onCancel` returns
 * focus to the mic.
 */
export function DictationNotices({ onConfirm, onCancel, onOpenSettings, onRetry, onDismiss }: {
  onConfirm: () => void;
  onCancel: () => void;
  onOpenSettings: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const gate = useVoiceStore((s) => s.dictationGate);
  const notice = useVoiceStore((s) => s.dictationNotice);
  const capturing = useDictationCapturing();
  const ref = useRef<HTMLDivElement>(null);
  const form = gate?.kind === "consent" ? "D0" : gate ? gate.reason === "unavailable" ? "Dx2" : gate.reason === "choose" ? "Dx1" : "Dx0" : null;

  useLayoutEffect(() => {
    if (form === "D0") focusButton(ref.current, "Start dictation");
    else if (form === "Dx1" || form === "Dx2") focusButton(ref.current, "Open Settings");
    else if (form === "Dx0") focusButton(ref.current, "OK");
  }, [form]);

  useEffect(() => {
    if (!form) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [form, onCancel]);

  if (gate?.kind === "consent") {
    return (
      <div ref={ref} className="mb-2" data-dictation-notice="D0">
        <VoiceNotice
          tone="you"
          icon="mic"
          live="polite"
          title="Start dictation"
          body={`Your words are sent to ${providerRecipient(gate.provider)} to be written down. ${providerAudioPolicy(gate.provider)}`}
          actions={[{ label: "Cancel", onClick: onCancel }, { label: "Start dictation", tone: "you", onClick: onConfirm }]}
        />
      </div>
    );
  }
  if (gate) {
    const saved = savedServiceName(gate.saved);
    const copy = form === "Dx2"
      ? { title: "Your dictation service isn’t available", body: `${saved ?? "Your saved service"} isn’t offered here any more. Choose another in Settings.` }
      : form === "Dx1"
        ? { title: "Choose a dictation service", body: "Dictation needs a service. Pick one in Settings." }
        // Nothing registered: the mic is disabled, unless a hold to talk live keeps it drawn (#3693).
        : { title: "Dictation isn’t set up on this host", body: "Nothing was captured." };
    return (
      <div ref={ref} className="mb-2" data-dictation-notice={form ?? undefined}>
        <VoiceNotice tone="idle" icon="attention" title={copy.title} body={copy.body}
          actions={form === "Dx0" ? [{ label: "OK", onClick: onCancel }] : [{ label: "Cancel", onClick: onCancel }, { label: "Open Settings", onClick: onOpenSettings }]} />
      </div>
    );
  }
  if (notice && !capturing) {
    const shown = dictationNoticeForm(notice);
    return (
      <div ref={ref} className="mb-2" data-dictation-notice={shown.kind === "blocked" ? "D7" : "D8"}>
        {shown.kind === "blocked" ? (
          <VoiceNotice tone="fail" icon="attention" live="polite" title={shown.title} body={shown.body} actions={[{ label: "OK", onClick: onDismiss }]} />
        ) : (
          <VoiceNotice tone="idle" icon="retry" live="polite" title={shown.title} body={shown.body}
            actions={[{ label: "Dismiss", onClick: onDismiss }, { label: "Try again", tone: "you", onClick: onRetry }]} />
        )}
      </div>
    );
  }
  return null;
}
