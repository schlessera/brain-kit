/**
 * The storage events timeline (#4541) as the pane reads it (#4548): every
 * event after `since` 0, continued page by page from the last `next`.
 */
import type {
  StorageEvent,
  StorageEventKind,
  StorageEventsResponse,
  StorageMaintenanceEvent,
  StoragePressureEvent,
  StorageRefusalEvent,
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

// Every value of each union the markers read, so a value the SDK adds fails
// the build here instead of quietly dropping its events.
const known =
  <T extends string>(values: Record<T, true>) =>
  (value: unknown): value is T =>
    typeof value === "string" && Object.hasOwn(values, value);
const severity = known<StoragePressureEvent["severity"]>({ observed: true, low: true, critical: true });
const pressurePhase = known<StoragePressureEvent["phase"]>({ start: true, step: true, "recovery-started": true, end: true });
const refusalPhase = known<StorageRefusalEvent["phase"]>({ refused: true, succeeded: true });
const resource = known<StorageRefusalEvent["resource"]>({ bytes: true, quota: true, inodes: true, unknown: true });
const operation = known<StorageMaintenanceEvent["operation"]>({ "pack-git": true, "prune-scratch": true, "cleanup-staging": true });
const finishedState = known<Extract<StorageMaintenanceEvent, { phase: "finished" }>["state"]>({
  complete: true,
  partial: true,
  refused: true,
  cancelled: true,
  unknown: true,
});
const text = (value: unknown): value is string => typeof value === "string";
const time = (value: unknown): value is number => Number.isSafeInteger(value);

/**
 * An event the pane can draw: every field its marker reads, with a value it
 * knows. Anything else is dropped on its own, so one unreadable event
 * neither breaks the chart nor stops the read from continuing past it.
 */
function isEvent(value: unknown): value is StorageEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  if (!time(event.seq) || !time(event.at)) return false;
  switch (event.kind) {
    case "pressure":
      return text(event.identity) && pressurePhase(event.phase) && severity(event.severity) && time(event.episode);
    case "refusal":
      return text(event.identity) && refusalPhase(event.phase) && text(event.target) && resource(event.resource);
    case "scope":
      return text(event.identity) && event.phase === "changed";
    case "maintenance":
      if (!text(event.receipt) || !operation(event.operation)) return false;
      return event.phase === "requested" || (event.phase === "finished" && finishedState(event.state));
    default:
      return false;
  }
}

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
 * continue from its `since`, ends the read with what was read before it; an
 * event it cannot read is dropped and the read continues; a failed request
 * rejects, and the caller keeps `from`.
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
    events.push(...value.events.filter((event) => isEvent(event) && event.seq > since));
    if (!value.events.length || value.next === since) break;
    since = value.next;
  }
  return paused ? { events: events.slice(-TIMELINE_EVENTS), paused, next: since } : from;
}
