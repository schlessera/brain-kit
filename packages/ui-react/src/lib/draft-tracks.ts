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
type Entry = { uploads: ReturnType<typeof createTrackUploads>; listeners: Set<() => void>; changedAt: number };

/**
 * One root's queues, and who watches all of them (#1112): Sessions lists a
 * new chat that holds only tracks, and a reload waits while any queue holds
 * one, whichever view it belongs to. `version` moves on every change, so a
 * snapshot of the queues is stable between changes.
 */
type Registry = { entries: Map<string, Entry>; watchers: Set<() => void>; version: number; snapshot: { version: number; views: StagedTracks[] } | null };

const registries = new WeakMap<object, Registry>();

function registry(root: BrainUiServices): Registry {
  let reg = registries.get(root.stores);
  if (!reg) { reg = { entries: new Map(), watchers: new Set(), version: 0, snapshot: null }; registries.set(root.stores, reg); }
  return reg;
}

function changed(reg: Registry) {
  reg.version++;
  for (const watch of [...reg.watchers]) watch();
}

/** The key a composer view's tracks live under. */
export const trackKey = (sessionId: string | null, draftId: string): string => (sessionId !== null ? `session:${sessionId}` : `draft:${draftId}`);

export function tracksFor(root: BrainUiServices, key: string): Entry {
  const reg = registry(root);
  let entry = reg.entries.get(key);
  if (!entry) {
    const listeners = new Set<() => void>();
    // The queue's tracks and their states: a notice that changes neither
    // (a composer reopening it reports its connection) is no change.
    let seen = "";
    const created: Entry = {
      uploads: createTrackUploads(root.request, apiBaseFor(root.config), () => {
        const now = created.uploads.files.map((t) => `${t.id}:${t.state}`).join("\n");
        if (now !== seen) { seen = now; created.changedAt = Date.now(); }
        for (const l of listeners) l();
        changed(reg);
      }),
      listeners,
      changedAt: Date.now(),
    };
    entry = created;
    reg.entries.set(key, entry);
  }
  return entry;
}

/** A queue that holds at least one track, as Sessions and the reload guard read it. */
export interface StagedTracks {
  /** `draft:<id>` for a new chat, `session:<id>` for a session. */
  key: string;
  count: number;
  failed: number;
  /** Uploading, being read, or waiting for a connection. */
  pending: number;
  /** The last add, removal or state change. */
  changedAt: number;
}

/** Every nonempty queue of this root, as one snapshot that stays the same object until a queue changes. */
export function stagedTrackViews(root: BrainUiServices): StagedTracks[] {
  const reg = registry(root);
  if (reg.snapshot?.version === reg.version) return reg.snapshot.views;
  const views: StagedTracks[] = [];
  for (const [key, entry] of reg.entries) {
    const files = entry.uploads.files;
    if (files.length === 0) continue;
    views.push({
      key,
      count: files.length,
      failed: files.filter((t) => t.state === "failed").length,
      pending: files.filter((t) => t.state === "uploading" || t.state === "parsing" || t.state === "paused").length,
      changedAt: entry.changedAt,
    });
  }
  reg.snapshot = { version: reg.version, views };
  return views;
}

/** Any queue of this root holds a track: a reload would lose it. */
export const anyStagedTracks = (root: BrainUiServices): boolean => stagedTrackViews(root).length > 0;

/** Called on every change to any of this root's queues, including a queue moving to its session. */
export function subscribeAllTracks(root: BrainUiServices, fn: () => void): () => void {
  const reg = registry(root);
  reg.watchers.add(fn);
  return () => { reg.watchers.delete(fn); };
}

/** The host accepted a message: the tracks it carried are its now. */
export function removeTracks(root: BrainUiServices, key: string, ids: readonly string[]): void {
  const entry = registry(root).entries.get(key);
  if (!entry) return;
  for (const id of ids) entry.uploads.remove(id);
}

/** The root is going: every staged upload is aborted, and none starts another. */
export function disposeTracks(root: BrainUiServices): void {
  const reg = registries.get(root.stores);
  if (!reg) return;
  for (const entry of reg.entries.values()) entry.uploads.dispose();
  reg.entries.clear();
  changed(reg);
}

/** A new chat's first message named its session: what is staged there is the session's. */
export function moveTracks(root: BrainUiServices, from: string, to: string): void {
  const reg = registry(root);
  const entry = reg.entries.get(from);
  if (!entry || reg.entries.has(to)) return;
  reg.entries.delete(from);
  reg.entries.set(to, entry);
  changed(reg);
}
