import type { DraftAttachment } from "@schlessera/brain-ui-sdk/protocol";
import type { PendingAttachment } from "./image-attachments.js";
import type { ComposerDraft, DraftStoreState } from "../stores/draft-state.js";

/**
 * The words and small rules of per-session drafts (D52 §5, #951): what a
 * draft is called in Sessions, and what the line under the composer says
 * about its save. Pure, so the composer, the list and the tests agree.
 */

/** A client draft id: a UUID, which the host's id pattern accepts. */
export function mintDraftId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** base64 length → decoded byte count (accounts for `=` padding). */
function decodedBytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/** A stored image as the composer holds one. Its preview is a data URL: nothing to revoke. */
export function attachmentFromDraft(a: DraftAttachment): PendingAttachment {
  return {
    attachment: { data: a.bytes, mediaType: a.mime },
    previewUrl: `data:${a.mime};base64,${a.bytes}`,
    bytes: decodedBytes(a.bytes),
    name: a.name ?? "image",
  };
}

/** `Draft with 2 images`, or the first line of the text. */
export function draftTitle(d: Pick<ComposerDraft, "text" | "attachments">): string {
  const line = d.text.split("\n").map((l) => l.trim()).find(Boolean);
  if (line) return line;
  const n = d.attachments.length;
  return `Draft with ${n} image${n === 1 ? "" : "s"}`;
}

/** The save state D52 §5 names, in its order of precedence. */
export type DraftSaveView =
  | { state: "none" }
  | { state: "saving" | "saved" | "unsaved" | "conflict" | "unavailable" | "too_large" | "full"; copy: string; word: string };

/** A saving state is printed only once a save has been out this long (D52 §5). */
export const SAVING_SHOWN_AFTER_MS = 600;

function bytesLabel(n: number): string {
  if (n >= 1024 * 1024 && n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/**
 * What the line under the composer says. `saved` is printed only when the
 * host acknowledged this exact edit, images included; nothing claims the
 * host has what it has not acknowledged. Content is kept here in every state.
 */
export function draftSaveView(
  d: ComposerDraft | undefined,
  store: Pick<DraftStoreState, "supported" | "limits">,
  now: number,
): DraftSaveView {
  if (!d || (d.text.length === 0 && d.attachments.length === 0)) return { state: "none" };
  if (d.conflict) return { state: "conflict", copy: "draft changed on another device", word: "changed on another device" };
  if (store.supported === false) return { state: "unavailable", copy: "draft · this host doesn't keep drafts · kept on this device", word: "kept on this device" };
  if (d.host && d.host.edit === d.edit) return { state: "saved", copy: "draft · saved", word: "saved" };
  if (d.failure?.kind === "too_large") {
    const limit = d.failure.bound === "imageCount" ? `${d.failure.limit} images` : bytesLabel(d.failure.limit);
    return { state: "too_large", copy: `draft · too large to save (${limit} max) · kept on this device`, word: "too large to save" };
  }
  if (d.failure?.kind === "full") {
    const copy = d.failure.bound === "drafts"
      ? `draft · ${d.failure.limit} drafts saved · delete one to save this`
      : `draft · ${bytesLabel(d.failure.limit)} of drafts saved · delete one to save this`;
    return { state: "full", copy, word: "host full" };
  }
  if (d.savingSince !== null && now - d.savingSince >= SAVING_SHOWN_AFTER_MS) return { state: "saving", copy: "draft · saving…", word: "saving" };
  if (d.failure?.kind === "unsaved" || store.supported === null) return { state: "unsaved", copy: "draft · not saved yet", word: "not saved yet" };
  // Dirty and on its way: nothing is claimed until the host answers.
  return { state: "none" };
}

/** The word a Draft entry prints for its save state, never `saved` before the host acknowledged. */
export function draftEntryWord(d: ComposerDraft, store: Pick<DraftStoreState, "supported" | "limits">, now: number): string {
  const view = draftSaveView(d, store, now);
  return view.state === "none" ? "not saved yet" : view.word;
}

/** Nonempty drafts with no session yet: the Sessions Draft entries, newest change first. */
export function unboundDrafts(drafts: Record<string, ComposerDraft>): ComposerDraft[] {
  return Object.values(drafts)
    .filter((d) => d.sessionId === null && (d.text.length > 0 || d.attachments.length > 0))
    .sort((a, b) => b.editedAt - a.editedAt);
}

/** Each session's newest nonempty draft, by session id: the `draft · 2h` marking. */
export function boundDrafts(drafts: Record<string, ComposerDraft>): Map<string, ComposerDraft> {
  const out = new Map<string, ComposerDraft>();
  for (const d of Object.values(drafts)) {
    if (d.sessionId === null || (d.text.length === 0 && d.attachments.length === 0)) continue;
    const seen = out.get(d.sessionId);
    if (!seen || d.editedAt > seen.editedAt) out.set(d.sessionId, d);
  }
  return out;
}
