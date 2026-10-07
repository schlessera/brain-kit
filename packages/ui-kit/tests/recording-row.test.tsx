import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordingRow, type RecordingRowState } from "../src/rows/RecordingRow.js";
describe("local recording row", () => {
  for (const state of ["recording", "saved", "interrupted", "transcribing", "transcript-ready", "failed", "accepted"] as RecordingRowState[]) {
    test(`names ${state} and the playback target`, () => {
      const html = renderToStaticMarkup(<RecordingRow time="09:12" length="2:14" durationLabel="2 minutes 14 seconds" state={state} savedThrough="2:13" onPlay={() => {}} />);
      expect(html.match(/<b[^>]*>([^<]+)<\/b>/)?.[1], "visible recording state word").toBe(state === "transcript-ready" ? "transcript ready" : state);
      expect(html).toContain("Play recording from 09:12, 2 minutes 14 seconds");
      if (state === "interrupted") expect(html).toContain("saved up to 2:13 — the end may be missing");
    });
  }
  test("capability absence and offline never manufacture an upload control", () => {
    for (const offline of [true, false]) {
      const html = renderToStaticMarkup(<RecordingRow time="09:12" length="2:14" durationLabel="2 minutes 14 seconds" state="saved" offline={offline} />);
      expect(html).not.toContain("role=\"button\"");
      expect(html).toContain(offline ? "needs the host" : "Your recording is kept.");
    }
  });
});
