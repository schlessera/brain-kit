import { unregisterStagedTracksUnloadDom } from "./staged-tracks-unload-dom.js";
import { afterAll, expect, test } from "bun:test";
import { createBrainUiRoot } from "../../src/root.js";
import { moveTracks, subscribeAllTracks, trackKey, tracksFor } from "../../src/lib/draft-tracks.js";

// The leave guard for staged tracks (#1150), against happy-dom's window. It
// belongs to the root, not to a mounted component: nothing is rendered here,
// as when the login gate has replaced the app. Real Chromium's confirmation
// is proved in `tests/parallel-sessions-runtime.test.ts`.
afterAll(unregisterStagedTracksUnloadDom);

/** The beforeunload listeners on the window right now. */
function watchListeners() {
  const live = new Set<EventListenerOrEventListenerObject>();
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  window.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
    if (type === "beforeunload") live.add(fn);
    add(type, fn, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) => {
    if (type === "beforeunload") live.delete(fn);
    remove(type, fn, options);
  }) as typeof window.removeEventListener;
  return { count: () => live.size, restore: () => { window.addEventListener = add; window.removeEventListener = remove; } };
}

/** Whether leaving now would ask: a cancelled beforeunload is the browser's cue. */
function leavingAsks(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

// Uploads never answer: a track stays staged, as it does in a composer.
const never = () => new Promise<Response>(() => {});

test("a staged track in a session not in view guards leaving until the last is removed, with nothing mounted", () => {
  const listeners = watchListeners();
  const root = createBrainUiRoot({ storage: null, request: never });
  try {
    expect(listeners.count(), "nothing staged: no handler").toBe(0);
    expect(leavingAsks()).toBe(false);

    // Staged in the raft's session and in a new chat.
    const raft = tracksFor(root, trackKey("odysseus-raft", root.stores.drafts.getState().idFor("odysseus-raft"))).uploads;
    const fresh = tracksFor(root, trackKey(null, root.stores.drafts.getState().fresh)).uploads;
    expect(listeners.count(), "empty queues: no handler").toBe(0);
    raft.add([new File(["{}"], "raft-timber-run.gpx")]);
    expect(raft.files, "the raft's track is staged").toHaveLength(1);
    expect(listeners.count(), "one handler").toBe(1);
    expect(leavingAsks(), "leaving would lose the raft's track").toBe(true);
    fresh.add([new File(["{}"], "pylos-harbour.gpx")]);
    expect(listeners.count(), "still one handler").toBe(1);

    raft.remove(raft.files[0]!.id);
    expect(leavingAsks(), "the new chat still holds one").toBe(true);
    fresh.remove(fresh.files[0]!.id);
    expect(listeners.count(), "the last track removed: no handler").toBe(0);
    expect(leavingAsks()).toBe(false);
  } finally {
    listeners.restore();
    root.dispose();
  }
});

test("a queue moving to its session keeps the guard; disposing the root removes it", () => {
  const listeners = watchListeners();
  const root = createBrainUiRoot({ storage: null, request: never });
  try {
    const fresh = root.stores.drafts.getState().fresh;
    tracksFor(root, trackKey(null, fresh)).uploads.add([new File(["{}"], "ithaca-loop.gpx")]);
    moveTracks(root, trackKey(null, fresh), trackKey("odysseus-ithaca", fresh));
    expect(leavingAsks(), "the session holds it now").toBe(true);
    root.dispose();
    expect(listeners.count(), "the root is gone: no handler").toBe(0);
    expect(leavingAsks()).toBe(false);
  } finally {
    listeners.restore();
  }
});

test("the guard is gone before any watcher hears the last track go", () => {
  const listeners = watchListeners();
  const root = createBrainUiRoot({ storage: null, request: never });
  try {
    const raft = tracksFor(root, trackKey("odysseus-raft", root.stores.drafts.getState().idFor("odysseus-raft"))).uploads;
    raft.add([new File(["{}"], "raft-timber-run.gpx")]);
    // The update takeover is such a watcher: it reloads the page at once.
    const heard: boolean[] = [];
    subscribeAllTracks(root, () => heard.push(leavingAsks()));
    raft.remove(raft.files[0]!.id);
    expect(heard, "a reload from the watcher asks nothing").toEqual([false]);
  } finally {
    listeners.restore();
    root.dispose();
  }
});
