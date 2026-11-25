/**
 * The storage events timeline (#4541) as the pane reads it (#4548): every
 * event after `since` 0, continued page by page from the last `next`.
 */
import type {
  StorageEvent,
  StorageEventKind,
  StorageEventsResponse,
} from "@schlessera/brain-ui-sdk/protocol";

/** What has been read: events in `seq` order, which kinds stopped recording, and where to continue. */
export interface StorageTimeline {
  events: readonly StorageEvent[];
  paused: Readonly<Record<StorageEventKind, boolean>>;
  next: number;
}

/** Pages one read takes with `since` before it stops; the next read continues. */
export const TIMELINE_PAGES = 4;
/** Events kept, newest last: above the server's 960 across every kind (#4541). */
export const TIMELINE_EVENTS = 1024;
const KINDS = ["pressure", "refusal", "scope", "maintenance"] as const;

/** A version-1 page that continues from `since`; anything else is no timeline. */
function isPage(value: StorageEventsResponse | null | undefined, since: number): value is StorageEventsResponse {
  return (
    value?.version === 1 &&
    Array.isArray(value.events) &&
    Number.isSafeInteger(value.next) &&
    value.next >= since &&
    typeof value.paused === "object" &&
    value.paused !== null &&
    KINDS.every((kind) => typeof value.paused[kind] === "boolean")
  );
}

/**
 * Continues `from` with `read(since)` until a page is empty or
 * `TIMELINE_PAGES` pages are read. A page that is not version 1, or does not
 * continue from its `since`, ends the read with what was read before it; a
 * failed request rejects, and the caller keeps `from`.
 */
export async function readStorageTimeline(
  read: (since: number) => Promise<StorageEventsResponse>,
  from: StorageTimeline | null
): Promise<StorageTimeline | null> {
  let since = from?.next ?? 0,
    paused = from?.paused ?? null;
  const events = [...(from?.events ?? [])];
  for (let page = 0; page < TIMELINE_PAGES; page++) {
    const value = await read(since);
    if (!isPage(value, since)) break;
    paused = value.paused;
    events.push(...value.events.filter((event) => event.seq > since));
    if (!value.events.length || value.next === since) break;
    since = value.next;
  }
  return paused ? { events: events.slice(-TIMELINE_EVENTS), paused, next: since } : from;
}
