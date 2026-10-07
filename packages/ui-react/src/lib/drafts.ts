import type { DraftAttachment } from "@schlessera/brain-ui-sdk/protocol";
import type { PendingAttachment } from "./image-attachments.js";
import type { ComposerDraft, DraftStoreState } from "../stores/draft-state.js";
import type { StagedTracks } from "./draft-tracks.js";

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

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** `Draft with 2 images`, `Draft with 1 track file`, or the first line of the text. */
export function draftTitle(d: { text: string; attachments: readonly unknown[]; tracks?: number; conflict?: ComposerDraft["conflict"] }): string {
  const tracks = d.tracks ?? 0;
  // Emptied here, with another device's version waiting: named by that version.
  if (d.text.length === 0 && d.attachments.length === 0 && tracks === 0 && d.conflict) {
    return draftTitle({ text: d.conflict.other.text, attachments: d.conflict.other.attachments });
  }
  const line = d.text.split("\n").map((l) => l.trim()).find(Boolean);
  if (line) return line;
  const n = d.attachments.length;
  // Track files are named only when there are some (#1112): `Draft with 2 images, 1 track file`.
  if (tracks === 0) return `Draft with ${count(n, "image", "images")}`;
  const parts = [...(n > 0 ? [count(n, "image", "images")] : []), count(tracks, "track file", "track files")];
  return `Draft with ${parts.join(", ")}`;
}

/**
 * What a Draft entry says about its staged tracks (#1112), in this order:
 * a failed upload, then one under way, then where they live. They are kept
 * by this page only, so they are never called saved.
 */
export function trackStateWord(t: Pick<StagedTracks, "failed" | "pending">): string {
  if (t.failed > 0) return `${count(t.failed, "track", "tracks")} failed`;
  if (t.pending > 0) return `uploading ${count(t.pending, "track", "tracks")}`;
  return "tracks in this tab only";
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
  // A conflict is shown even over an emptied composer: the other version still waits.
  if (d?.conflict) return { state: "conflict", copy: "draft changed on another device", word: "changed on another device" };
  if (!d || (d.text.length === 0 && d.attachments.length === 0)) return { state: "none" };
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
    // An emptied draft with another device's version waiting stays reachable: its Compare is still owed.
    .filter((d) => d.sessionId === null && (d.text.length > 0 || d.attachments.length > 0 || d.conflict !== null))
    .sort((a, b) => b.editedAt - a.editedAt);
}

/** One Sessions Draft entry: an unbound draft, its new chat's staged tracks, or both (#1112). */
export interface DraftEntry {
  /** The draft id that opens it. */
  id: string;
  draft: ComposerDraft | null;
  tracks: StagedTracks | null;
  /** Its newest change, of the draft or of the tracks. */
  changedAt: number;
}

/**
 * The Sessions Draft entries, newest change first: every unbound draft, and
 * every new chat that holds only staged tracks. A new chat's tracks live
 * under its draft's first id (`originOf`), so a rotated draft keeps them.
 */
export function draftEntries(drafts: Record<string, ComposerDraft>, staged: readonly StagedTracks[], originOf: (draftId: string) => string): DraftEntry[] {
  const queues = new Map(staged.filter((t) => t.key.startsWith("draft:")).map((t) => [t.key.slice("draft:".length), t]));
  const entries: DraftEntry[] = unboundDrafts(drafts).map((d) => {
    const origin = originOf(d.draftId);
    const tracks = queues.get(origin) ?? null;
    queues.delete(origin);
    return { id: d.draftId, draft: d, tracks, changedAt: Math.max(d.editedAt, tracks?.changedAt ?? 0) };
  });
  for (const [origin, tracks] of queues) {
    // A draft of that new chat with nothing listable in it still names the id its view opens under.
    const holder = Object.values(drafts).find((d) => originOf(d.draftId) === origin);
    if (holder && holder.sessionId !== null) continue;
    entries.push({ id: holder?.draftId ?? origin, draft: null, tracks, changedAt: tracks.changedAt });
  }
  return entries.sort((a, b) => b.changedAt - a.changedAt);
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
