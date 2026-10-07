import type { BrainUiServices } from "../root.js";
import { apiBaseFor } from "./backend.js";
import { createTrackUploads } from "./track-uploads.js";

/**
 * Track files staged for a message, per draft view and per root (#951): a
 * session's tracks stay with that session across remounts and never show
 * in another session's composer. A session's view is keyed by its session
 * id, so its tracks survive the draft id changing under it; the new-chat
 * view by its draft id. They are uploads staged on the host for the next
 * message, not draft content, and are not saved with the draft.
 */
type Entry = { uploads: ReturnType<typeof createTrackUploads>; listeners: Set<() => void> };

const registries = new WeakMap<object, Map<string, Entry>>();

function registry(root: BrainUiServices): Map<string, Entry> {
  let map = registries.get(root.stores);
  if (!map) { map = new Map(); registries.set(root.stores, map); }
  return map;
}

/** The key a composer view's tracks live under. */
export const trackKey = (sessionId: string | null, draftId: string): string => (sessionId !== null ? `session:${sessionId}` : `draft:${draftId}`);

export function tracksFor(root: BrainUiServices, key: string): Entry {
  const map = registry(root);
  let entry = map.get(key);
  if (!entry) {
    const listeners = new Set<() => void>();
    entry = { uploads: createTrackUploads(root.request, apiBaseFor(root.config), () => { for (const l of listeners) l(); }), listeners };
    map.set(key, entry);
  }
  return entry;
}

/** The host accepted a message: the tracks it carried are its now. */
export function removeTracks(root: BrainUiServices, key: string, ids: readonly string[]): void {
  const entry = registry(root).get(key);
  if (!entry) return;
  for (const id of ids) entry.uploads.remove(id);
}

/** The root is going: every staged upload is aborted, and none starts another. */
export function disposeTracks(root: BrainUiServices): void {
  const map = registries.get(root.stores);
  if (!map) return;
  for (const entry of map.values()) entry.uploads.dispose();
  map.clear();
}

/** A new chat's first message named its session: what is staged there is the session's. */
export function moveTracks(root: BrainUiServices, from: string, to: string): void {
  const map = registry(root);
  const entry = map.get(from);
  if (!entry || map.has(to)) return;
  map.delete(from);
  map.set(to, entry);
}
