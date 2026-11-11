/** Internal, reliable error categories; provider message text never selects copy. */
export type DictationFailure = "network" | "mic" | "no-speech" | "unknown";
/** `kept`: the words the take ended with, which are now in the draft (D8, #3694). */
export type DictationNotice = { reason: DictationFailure; phase: "ended" | "startup"; retained: boolean; kept?: string };

export function speechError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export function dictationFailure(error: unknown): DictationFailure {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "network") return "network";
  if (code === "no-speech") return "no-speech";
  if (typeof code === "string" && ["not-allowed", "service-not-allowed", "audio-capture"].includes(code)) return "mic";
  if (error instanceof DOMException && ["NotAllowedError", "SecurityError", "NotFoundError", "NotReadableError"].includes(error.name)) return "mic";
  return "unknown";
}

export function dictationExplanation(reason: DictationFailure, phase: "ended" | "startup" | "open"): string {
  if (reason === "no-speech" && phase !== "startup") return phase === "ended" ? "Dictation stopped: no speech heard." : "No speech heard.";
  const detail = reason === "network" ? "a connection problem occurred." : reason === "mic" ? "the microphone isn't available." : null;
  if (phase === "open") return detail ? detail[0].toUpperCase() + detail.slice(1) : "A dictation problem occurred.";
  const prefix = phase === "startup" ? "Dictation couldn't start" : "Dictation stopped";
  return detail ? `${prefix}: ${detail}` : phase === "startup" ? `${prefix}.` : `${prefix} unexpectedly.`;
}

/** A take that ended with a failure: the words it heard are kept, and named (D8, #3694). */
export function endedNotice(reason: DictationFailure, heard: string): DictationNotice {
  const kept = heard.trim();
  return { reason, phase: "ended", retained: kept !== "", ...(kept ? { kept } : {}) };
}

/** The start of the kept words, cut at a word, as D8 quotes them. */
function excerpt(text: string, max = 32): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?]+$/, "")}…`;
}

/**
 * The voice notice a failed take shows (#3694): D7 when the microphone is
 * the reason, otherwise D8, which quotes the words it kept. The words
 * themselves are already in the draft; nothing here is a provider message.
 */
export function dictationNoticeForm(notice: DictationNotice): { kind: "blocked" | "stopped"; title: string; body: string } {
  if (notice.reason === "mic") {
    return { kind: "blocked", title: "Microphone is blocked", body: "Allow it in this site\u2019s browser settings, then tap the mic again." };
  }
  const body = notice.kept ? `Kept so far: \u201c${excerpt(notice.kept)}\u201d` : dictationExplanation(notice.reason, notice.phase);
  return { kind: "stopped", title: "Dictation stopped", body };
}
