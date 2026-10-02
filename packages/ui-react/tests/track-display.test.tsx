import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TrackMap } from "@schlessera/brain-ui-kit";
import { planTrack, trackMapProps, loadTrackDisplay } from "../src/lib/track-display.js";
import { renderBlockHtml } from "../src/components/chat/share-document.js";
import { createBrainUiRoot } from "../src/root.js";
import { trackView } from "./track-fixtures.js";

test("10 km loop fits every bend, preserves a complete waypoint list and true zero metrics on a plain map", () => {
  const view = trackView(); const props = trackMapProps(view);
  expect(view.track.counts.retained).toBe(129);
  expect(view.file.summary!.measurements.distance.value!).toBeGreaterThan(9900);
  expect(view.file.summary!.measurements.distance.value!).toBeLessThan(10100);
  expect(props.paths[0]!.coords).toHaveLength(129); expect(props.fitPoints).toHaveLength(4);
  const html = renderToStaticMarkup(<TrackMap {...props} />);
  expect(html).toContain("Track only · no background geography"); expect(html).toContain("S/E");
  expect(html).toContain("Raft timber stand"); expect(html).toContain("0 m"); expect(html).toContain("Moving time"); expect(html).toContain("Unavailable");
  expect(html).toContain("timestamps do not prove travel"); expect(html).toContain("129 points drawn, unsimplified");
});

test("recovered gaps remain separate paths, exact reasons and partial scope survive display without mutation", () => {
  const view = trackView([[3,2,0],[3.01,2,0],[3.02,100,0],[3.03,2,0],[3.04,2,0]]);
  const before = JSON.stringify(view); const props = trackMapProps(view);
  const html = renderToStaticMarkup(<TrackMap {...props} />);
  expect((html.match(/<polyline/g) ?? []).length).toBe(2);
  expect(props.paths).toHaveLength(2); expect(props.paths.map(p => p.coords.length)).toEqual([2,2]);
  expect(html).toContain("Partial measurements"); expect(html).toContain("4 retained of 5 line points"); expect(html).toContain("latitude out of range: 1");
  expect(JSON.stringify(view)).toBe(before);
});

test("projectable wide tracks skip the background query; polar and dateline evidence retains complete text and original", async () => {
  let queries = 0; const wide = trackView([[0,2],[6,2]]);
  expect(planTrack(wide).reason).toBeUndefined();
  const root = createBrainUiRoot({ storage: null, request: async url => { if (url.includes("geo/coastline")) { queries++; throw Error("No background request permitted"); } return Response.json(wide); } });
  try {
    const resolved = await loadTrackDisplay(root, wide.file.path);
    expect(resolved.props.paths[0]!.coords).toEqual([[0,2],[6,2]]); expect(queries).toBe(0);
    const html = await renderBlockHtml({ kind: "track", source: { path: wide.file.path } }, resolved);
    expect(html).toContain("Track only"); expect(html).toContain("km"); expect(html).toContain("6, 2");
    for (const view of [trackView([[0,89],[0.01,89]]), trackView([[179,2],[-179,2]])]) {
      const props = trackMapProps(view);
      expect(props.projectionReason).toContain("range");
      const fallback = renderToStaticMarkup(<TrackMap {...props} />);
      expect(fallback).toContain("Coordinates are preserved"); expect(fallback).toContain(view.file.path); expect(fallback).toContain("Distance"); expect(fallback).toContain("Raft timber stand"); expect(fallback).not.toContain("<polyline");
    }
  } finally { root.dispose(); }
});

test("export requires pre-resolved original evidence and static markup performs no request", async () => {
  const view = trackView(); const resolved = { view, props: trackMapProps(view) };
  await expect(renderBlockHtml({ kind: "track", source: { path: view.file.path } })).rejects.toThrow("Resolve the original");
  const html = await renderBlockHtml({ kind: "track", source: { path: view.file.path } }, resolved);
  expect(html).toContain("<polyline"); expect(html).toContain("Raft timber stand"); expect(html).toContain("Original"); expect(html).not.toContain("<script");
});
