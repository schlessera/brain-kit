/** Internal, reliable error categories; provider message text never selects copy. */
export type DictationFailure = "network" | "mic" | "no-speech" | "unknown";
export type DictationNotice = { reason: DictationFailure; phase: "ended" | "startup"; retained: boolean };

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

export function dictationNoticeText(notice: DictationNotice): string {
  const lead = dictationExplanation(notice.reason, notice.phase);
  if (!notice.retained && notice.reason === "no-speech" && notice.phase === "ended") return lead;
  return `${lead} ${notice.retained ? "Your words are kept for review." : "Nothing was captured."}`;
}
