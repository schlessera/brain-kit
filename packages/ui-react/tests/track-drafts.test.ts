import { describe, expect, test } from "bun:test";
import { createBrainUiRoot } from "../src/root.ts";
import { anyStagedTracks, moveTracks, stagedTrackViews, subscribeAllTracks, trackKey, tracksFor } from "../src/lib/draft-tracks.ts";
import { draftEntries, draftTitle, trackStateWord } from "../src/lib/drafts.ts";
import { createDraftStore } from "../src/stores/draft-state.ts";
import { trackView } from "./track-fixtures.ts";

// Track-only new chats are Draft entries (#1112): the root's track queues,
// watched as one, and the words Sessions prints for them. Odysseus fixtures.

const RAFT = "odysseus-raft";

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A root whose track uploads wait until the test answers them. */
function rootWithUploads() {
  const uploads: Array<ReturnType<typeof deferred>> = [];
  const root = createBrainUiRoot({ storage: null, request: async (url) => {
    if (url.endsWith("/track-upload")) { const d = deferred(); uploads.push(d); return d.promise; }
    return Response.json({});
  } });
  return { root, uploads };
}

const gpx = (name: string) => new File(['{"type":"LineString","coordinates":[[20.71,38.31],[20.72,38.31]]}'], name, { type: "application/octet-stream" });
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await Bun.sleep(1); };

describe("the root's track queues, as one", () => {
  test("every add, state change, removal and move is published, and the snapshot holds until one", async () => {
    const { root, uploads } = rootWithUploads();
    try {
      let calls = 0;
      const off = subscribeAllTracks(root, () => calls++);
      const empty = stagedTrackViews(root);
      expect(empty).toEqual([]);
      expect(anyStagedTracks(root)).toBe(false);

      const queue = tracksFor(root, trackKey(null, "d-ithaca")).uploads;
      queue.add([gpx("ithaca-to-pylos.gpx")]);
      expect(calls, "the add").toBeGreaterThan(0);
      const added = stagedTrackViews(root);
      expect(added).not.toBe(empty);
      expect(added).toMatchObject([{ key: "draft:d-ithaca", count: 1, failed: 0, pending: 1 }]);
      expect(stagedTrackViews(root), "unchanged queues, the same snapshot").toBe(added);
      expect(anyStagedTracks(root)).toBe(true);

      const before = calls;
      uploads[0]!.resolve(Response.json({ files: [trackView().file] }));
      await flush();
      expect(calls, "the upload's state changes").toBeGreaterThan(before);
      expect(stagedTrackViews(root)).toMatchObject([{ key: "draft:d-ithaca", count: 1, failed: 0, pending: 0 }]);

      const moved = calls;
      moveTracks(root, "draft:d-ithaca", trackKey(RAFT, "d-ithaca"));
      expect(calls, "the move").toBe(moved + 1);
      expect(stagedTrackViews(root).map((t) => t.key)).toEqual([`session:${RAFT}`]);

      const removed = calls;
      queue.remove(queue.files[0]!.id);
      expect(calls, "the removal").toBeGreaterThan(removed);
      expect(stagedTrackViews(root)).toEqual([]);
      expect(anyStagedTracks(root)).toBe(false);

      off();
      const after = calls;
      queue.add([gpx("raft.gpx")]);
      expect(calls, "unsubscribed").toBe(after);
    } finally { root.dispose(); }
  });

  test("a failed upload and one under way are counted apart", async () => {
    const { root, uploads } = rootWithUploads();
    try {
      const queue = tracksFor(root, trackKey(null, "d-pylos")).uploads;
      queue.add([gpx("day-3.gpx"), gpx("day-4.gpx")]);
      uploads[0]!.resolve(Response.json({ error: "unsupported_track" }, { status: 422 }));
      await flush();
      expect(stagedTrackViews(root)).toMatchObject([{ count: 2, failed: 1, pending: 1 }]);
      queue.setOnline(false);
      expect(stagedTrackViews(root), "waiting for a connection counts as under way").toMatchObject([{ count: 2, failed: 1, pending: 1 }]);
    } finally { root.dispose(); }
  });

  test("a composer reopening a queue is no change: its entry keeps its place", async () => {
    const { root, uploads } = rootWithUploads();
    try {
      const queue = tracksFor(root, trackKey(null, "d-pylos")).uploads;
      queue.add([gpx("day-3.gpx")]);
      uploads[0]!.resolve(Response.json({ files: [trackView().file] }));
      await flush();
      expect(queue.files[0]!.state).toBe("ready");
      const at = stagedTrackViews(root)[0]!.changedAt;
      await Bun.sleep(5);
      // What a composer does as it mounts on that view: reports the connection.
      queue.setOnline(true);
      expect(stagedTrackViews(root)[0]!.changedAt, "nothing changed").toBe(at);
      queue.add([gpx("day-4.gpx")]);
      expect(stagedTrackViews(root)[0]!.changedAt, "an add is a change").toBeGreaterThan(at);
    } finally { root.dispose(); }
  });

  test("rows come only from this root's queues", () => {
    const a = rootWithUploads().root;
    const b = rootWithUploads().root;
    try {
      let heardB = 0;
      subscribeAllTracks(b, () => heardB++);
      tracksFor(a, trackKey(null, "d-ithaca")).uploads.add([gpx("ithaca.gpx")]);
      expect(stagedTrackViews(a)).toHaveLength(1);
      expect(stagedTrackViews(b), "another brain lists nothing").toEqual([]);
      expect(heardB, "another brain is not told").toBe(0);
      const drafts = b.stores.drafts.getState();
      expect(draftEntries(drafts.drafts, stagedTrackViews(b), drafts.originOf)).toEqual([]);
    } finally { a.dispose(); b.dispose(); }
  });
});

describe("track words", () => {
  test("titles count track files beside images, and text still names the draft", () => {
    expect(draftTitle({ text: "", attachments: [], tracks: 1 })).toBe("Draft with 1 track file");
    expect(draftTitle({ text: "", attachments: [], tracks: 3 })).toBe("Draft with 3 track files");
    expect(draftTitle({ text: "", attachments: [{}, {}], tracks: 1 })).toBe("Draft with 2 images, 1 track file");
    expect(draftTitle({ text: "", attachments: [{}, {}] })).toBe("Draft with 2 images");
    expect(draftTitle({ text: "Compare day 3 and day 4 routes", attachments: [], tracks: 2 })).toBe("Compare day 3 and day 4 routes");
  });

  test("failed wins over uploading, which wins over where they live; never saved", () => {
    const words = [
      trackStateWord({ failed: 1, pending: 2 }),
      trackStateWord({ failed: 2, pending: 0 }),
      trackStateWord({ failed: 0, pending: 1 }),
      trackStateWord({ failed: 0, pending: 3 }),
      trackStateWord({ failed: 0, pending: 0 }),
    ];
    expect(words).toEqual(["1 track failed", "2 tracks failed", "uploading 1 track", "uploading 3 tracks", "tracks in this tab only"]);
    for (const w of words) expect(w).not.toMatch(/saved/);
  });
});

describe("Draft entries with tracks", () => {
  const tracks = (key: string, changedAt: number, over: Partial<{ count: number; failed: number; pending: number }> = {}) =>
    ({ key, count: 1, failed: 0, pending: 0, changedAt, ...over });

  test("a new chat holding only tracks is an entry; its text-holding sibling joins its tracks; sessions' queues are not entries", () => {
    let clock = 1_000;
    const s = createDraftStore({ now: () => ++clock });
    const letter = s.getState().fresh;
    s.getState().edit(letter, null, { text: "Ask about the tide" });
    s.getState().newChat();
    const trackOnly = s.getState().fresh;
    s.getState().newChat();
    const entries = draftEntries(s.getState().drafts, [
      tracks(`draft:${trackOnly}`, 5_000),
      tracks(`draft:${letter}`, 500, { count: 2, failed: 1 }),
      tracks(`session:${RAFT}`, 9_000),
    ], s.getState().originOf);
    expect(entries.map((e) => [e.id, e.draft?.text ?? null, e.tracks?.count ?? 0])).toEqual([
      [trackOnly, null, 1],
      [letter, "Ask about the tide", 2],
    ]);
    // Newest change first, by the draft's edit or the queue's change, whichever is later.
    expect(entries[1]!.changedAt).toBe(s.getState().drafts[letter]!.editedAt);
  });

  test("opening a track-only entry shows that new chat; nothing is stored for it", () => {
    const s = createDraftStore();
    const trackOnly = s.getState().fresh;
    s.getState().newChat();
    expect(s.getState().fresh).not.toBe(trackOnly);
    s.getState().openUnbound(trackOnly);
    expect(s.getState().fresh, "the track-only new chat is in view again").toBe(trackOnly);
    expect(s.getState().drafts, "no host state was created").toEqual({});
  });

  test("a session's draft id never opens in the new-chat view", () => {
    const s = createDraftStore();
    const before = s.getState().fresh;
    const raft = s.getState().idFor(RAFT);
    s.getState().edit(raft, RAFT, { text: "Lash the beams" });
    s.getState().openUnbound(raft);
    expect(s.getState().fresh).toBe(before);
  });
});
