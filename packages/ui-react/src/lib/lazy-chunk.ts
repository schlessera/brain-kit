import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * A lazy chunk that could not be downloaded. After a deploy, the chunk names
 * the running page knows about no longer exist on the server, so the import
 * rejects and React rethrows the rejection on every render (#1377). Only a
 * reload helps: React caches the rejected promise.
 */
export class StaleChunkError extends Error {
  override name = "StaleChunkError";
  constructor(cause: unknown) {
    super("A part of the app could not be downloaded.", { cause });
  }
}

/** `lazy()`, with every load failure marked as a stale chunk. */
export function lazyChunk<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>
): LazyExoticComponent<T> {
  return lazy(() => load().catch((error: unknown) => { throw new StaleChunkError(error); }));
}

// What browsers and bundlers say when a dynamic import fails, for failures
// that did not go through `lazyChunk` (Chrome, Firefox, Safari, Vite's CSS
// preload and webpack-style chunk names).
const CHUNK_MESSAGE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (CSS )?chunk [\w-]+ failed/i;

export function isStaleChunk(error: unknown): boolean {
  if (error instanceof StaleChunkError) return true;
  return error instanceof Error && CHUNK_MESSAGE.test(error.message);
}

/** The `sessionStorage` key holding when the last stale-chunk reload started. */
export const RELOAD_MARKER_KEY = "brain-ui:stale-chunk-reload";
/** An automatic reload within this long of the last one would be a loop. */
export const RELOAD_LOOP_MS = 120_000;

/**
 * The marker's timestamp, `null` when there is none, or `"unreadable"` when
 * storage throws. Unreadable storage counts as a fresh marker: fail safe.
 */
export function readReloadMarker(storage: Pick<Storage, "getItem"> | null | undefined): number | null | "unreadable" {
  try {
    if (!storage) return "unreadable";
    const value = storage.getItem(RELOAD_MARKER_KEY);
    if (value === null) return null;
    const at = Number(value);
    return Number.isFinite(at) ? at : null;
  } catch {
    return "unreadable";
  }
}

/** Record that a reload is about to start. Never throws. */
export function markReload(storage: Pick<Storage, "setItem"> | null | undefined, now = Date.now()): void {
  try { storage?.setItem(RELOAD_MARKER_KEY, String(now)); } catch { /* the marker is best effort */ }
}

export type StaleChunkDecision = "auto" | "manual" | "held" | "looped" | "offline";

/**
 * What a stale-chunk fallback does. Offline wins (a reload cannot fetch
 * anything), then a fresh marker (the last reload did not help), then
 * unsaved work (a reload would lose it), then unreadable storage (a loop
 * could not be detected, so a tap decides); otherwise it reloads by itself.
 */
export function staleChunkReloadDecision({ online, held, marker, now }: {
  online: boolean;
  held: boolean;
  marker: number | null | "unreadable";
  now: number;
}): StaleChunkDecision {
  if (!online) return "offline";
  if (marker !== null && marker !== "unreadable" && now - marker < RELOAD_LOOP_MS) return "looped";
  if (held) return "held";
  if (marker === "unreadable") return "manual";
  return "auto";
}
