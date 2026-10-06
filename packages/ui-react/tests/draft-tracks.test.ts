import { expect, test } from "bun:test";
import { createBrainUiRoot } from "../src/root.ts";
import { tracksFor, trackKey } from "../src/lib/draft-tracks.ts";

// Staged track uploads live per draft view and per root (#951): disposing
// the root aborts them, as unmounting the composer used to.
test("disposing the root disposes every staged track queue", () => {
  const root = createBrainUiRoot({ storage: null, request: async () => new Response("{}") });
  const entries = [tracksFor(root, trackKey("odysseus-raft", "d-1")), tracksFor(root, trackKey(null, "d-2"))];
  let disposed = 0;
  for (const entry of entries) {
    const dispose = entry.uploads.dispose.bind(entry.uploads);
    entry.uploads.dispose = () => { disposed++; dispose(); };
  }
  root.dispose();
  expect(disposed).toBe(2);
  // A later view starts a fresh queue rather than reusing a disposed one.
  expect(tracksFor(root, trackKey("odysseus-raft", "d-1"))).not.toBe(entries[0]);
});
