import { unregisterStagedTracksUnloadDom } from "./staged-tracks-unload-dom.js";
import { afterAll, afterEach, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { trackKey, tracksFor } from "../../src/lib/draft-tracks.js";
import { useStagedTracksUnloadGuard } from "../../src/hooks/use-staged-tracks.js";

// The leave guard for staged tracks (#1150), against happy-dom's window. Real
// Chromium's confirmation is proved in `tests/parallel-sessions-runtime.test.ts`.
afterEach(cleanup);
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

function Guard() {
  useStagedTracksUnloadGuard();
  return null;
}

test("a staged track in a session not in view guards leaving until the last is removed", () => {
  const listeners = watchListeners();
  // Uploads never answer: the track stays staged, as it does in a composer.
  const root = createBrainUiRoot({ storage: null, request: () => new Promise<Response>(() => {}) });
  try {
    render(<BrainUiProvider root={root}><Guard /></BrainUiProvider>);
    expect(listeners.count(), "nothing staged: no handler").toBe(0);
    expect(leavingAsks()).toBe(false);

    // Staged in the raft's session and in a new chat; neither is in view.
    const raft = tracksFor(root, trackKey("odysseus-raft", root.stores.drafts.getState().idFor("odysseus-raft"))).uploads;
    const fresh = tracksFor(root, trackKey(null, root.stores.drafts.getState().fresh)).uploads;
    act(() => { raft.add([new File(["{}"], "raft-timber-run.gpx")]); });
    expect(raft.files, "the raft's track is staged").toHaveLength(1);
    expect(listeners.count(), "one handler").toBe(1);
    expect(leavingAsks(), "leaving would lose the raft's track").toBe(true);
    act(() => { fresh.add([new File(["{}"], "pylos-harbour.gpx")]); });
    expect(listeners.count(), "still one handler").toBe(1);

    act(() => raft.remove(raft.files[0]!.id));
    expect(leavingAsks(), "the new chat still holds one").toBe(true);
    act(() => fresh.remove(fresh.files[0]!.id));
    expect(listeners.count(), "the last track removed: no handler").toBe(0);
    expect(leavingAsks()).toBe(false);
  } finally {
    listeners.restore();
    root.dispose();
  }
});

test("the guard follows a replaced root, and unmounting removes it", () => {
  const listeners = watchListeners();
  const never = () => new Promise<Response>(() => {});
  const ithaca = createBrainUiRoot({ storage: null, request: never });
  const pylos = createBrainUiRoot({ storage: null, request: never });
  try {
    const track = tracksFor(ithaca, trackKey(null, ithaca.stores.drafts.getState().fresh)).uploads;
    track.add([new File(["{}"], "ithaca-loop.gpx")]);
    const view = render(<BrainUiProvider root={ithaca}><Guard /></BrainUiProvider>);
    expect(leavingAsks(), "Ithaca holds a track").toBe(true);
    view.rerender(<BrainUiProvider root={pylos}><Guard /></BrainUiProvider>);
    expect(listeners.count(), "Pylos holds nothing").toBe(0);
    expect(leavingAsks()).toBe(false);
    const other = tracksFor(pylos, trackKey(null, pylos.stores.drafts.getState().fresh)).uploads;
    act(() => { other.add([new File(["{}"], "pylos-harbour.gpx")]); });
    expect(leavingAsks(), "Pylos's own track is heard").toBe(true);
    view.unmount();
    expect(listeners.count(), "unmounted: no handler").toBe(0);
  } finally {
    listeners.restore();
    ithaca.dispose();
    pylos.dispose();
  }
});
