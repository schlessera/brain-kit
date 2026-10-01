import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageShare } from "../src/share/staging.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
export const gpx = '<gpx version="1.1"><trk><trkseg><trkpt lat="2" lon="3"/><trkpt lat="2" lon="3.001"/></trkseg></trk></gpx>';

test("octet-stream GPX shares infer a validated staged extension and retain original bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "track-intake-")); roots.push(root);
  const result = await stageShare(root, { files: [new File([gpx], "shared-1", { type: "application/octet-stream" })] });
  expect(result.files).toHaveLength(1);
  expect(result.files[0]!.name).toBe("shared-1.gpx");
  expect(result.files[0]).toMatchObject({ incomingName: "shared-1", mediaType: "application/octet-stream", detected: "gpx" });
  expect(await readFile(join(root, result.files[0]!.path), "utf8")).toBe(gpx);
});

const kml = '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><LineString><coordinates>3,2 3.001,2</coordinates></LineString></Placemark></kml>';
const geojson = '{"type":"LineString","coordinates":[[3,2],[3.001,2]]}';
import { createShareRoutes } from "../src/routes/share.js";
import { createTrackRoutes } from "../src/routes/tracks.js";
import { readStagedTrack, resolveChatFiles, withTrackFiles } from "../src/tracks/read.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "track-intake-")); roots.push(root);
  return { root, routes: createShareRoutes({ brainRoot: root, allowedOrigins: [], trustProxy: false }) };
}
for (const [format, source] of [["gpx", gpx], ["kml", kml], ["geojson", geojson]] as const) {
  test(`${format} actual composer intake validates content, stages collisions and reconstructs original metadata`, async () => {
    const { root, routes } = await fixture();
    const form = new FormData();
    form.append("files", new File([source], "shared-1.bin", { type: "application/octet-stream" }));
    form.append("files", new File([source], "shared-1.bin", { type: "application/octet-stream" }));
    const response = await routes.request("/track-upload", { method: "POST", body: form });
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.files.map((f: {name:string}) => f.name)).toEqual([`shared-1.${format}`, `shared-1-2.${format}`]);
    const view = await readStagedTrack(root, result.files[0].path);
    expect(view.file).toMatchObject({ incomingName: "shared-1.bin", mediaType: "application/octet-stream", detected: format });
    expect(view.track.segments[0]).toHaveLength(2);
    expect(view.file.summary!.measurements.distance.value!).toBeGreaterThan(100);
    expect(await readFile(join(root, result.files[0].path), "utf8")).toBe(source);
    const get = await createTrackRoutes(root).request(`/tracks?path=${encodeURIComponent(result.files[0].path)}`);
    expect(get.status).toBe(200);
    expect((await get.json()).track.segments[0]).toHaveLength(2);
  });
}
for (const [name, type, source] of [
  ["claims.gpx", "application/gpx+xml", "this is not a track"],
  ["ordinary.json", "application/geo+json", '{"title":"ordinary data"}'],
  ["notes.pdf", "application/pdf", "%PDF-not-a-track"],
  ["notes.csv", "text/csv", "lat,lon\n2,3"],
  ["broken.kml", "application/vnd.google-earth.kml+xml", "<kml><LineString></kml>"],
  ["unsafe.gpx", "application/gpx+xml", '<!DOCTYPE gpx><gpx version="1.1"/>'],
] as const) test(`${name} is refused by composer and preserved by ordinary share without track labeling`, async () => {
  const { routes, root } = await fixture();
  const make = () => { const f = new FormData(); f.append("files", new File([source], name, { type })); return f; };
  const rejected = await routes.request("/track-upload", { method: "POST", body: make() });
  expect(rejected.status).toBe(422);
  expect((await rejected.json()).error).toBe("unsupported_track");
  const shared = await routes.request("/share", { method: "POST", body: make() });
  expect(shared.status).toBe(201);
  const result = await shared.json();
  expect(result.files[0].detected).toBeUndefined();
  expect(result.files[0].summary).toBeUndefined();
  expect(await readFile(join(root, result.files[0].path), "utf8")).toBe(source);
});
test("staged references cannot supply geometry or escape containment and agent evidence is nonempty", async () => {
  const { root } = await fixture();
  const result = await stageShare(root, { files: [new File([gpx], "loop.gpx")] });
  const files = await resolveChatFiles(root, [{ kind: "file", path: result.files[0]!.path }]);
  expect(files[0]!.summary!.measurements.distance.value!).toBeGreaterThan(100);
  expect(withTrackFiles("Show this", files)).toContain(result.files[0]!.path);
  expect(withTrackFiles("Show this", files)).toContain('"scope":"usable_sections"');
  expect(withTrackFiles("Show this", files)).toContain("timestamps do not prove travel");
  for (const path of ["/etc/passwd", ".brain-ui/inbox/../secret.gpx", "content/loop.gpx"]) await expect(readStagedTrack(root, path)).rejects.toThrow();
  await expect(resolveChatFiles(undefined, [{ kind: "file", path: result.files[0]!.path }])).rejects.toThrow("unavailable");
});

import { readdir } from "node:fs/promises";
import { MAX_ROUTE_BYTES } from "@schlessera/brain-geo";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";

test("a cancelled composer stage leaves neither a committed original nor a partial directory", async () => {
  const { root } = await fixture(); const controller = new AbortController();
  class CancelledFile extends File { override async arrayBuffer() { const bytes = await super.arrayBuffer(); controller.abort(); return bytes; } }
  await expect(stageShare(root, { tracksOnly: true, signal: controller.signal, files: [new CancelledFile([gpx], "cancelled.gpx")] })).rejects.toThrow();
  expect(await readdir(join(root, SHARE_STAGING_DIR))).toEqual([]);
});

test("the actual composer route refuses track-parser oversize with its precise cap and refuses a text-only bypass", async () => {
  const { routes } = await fixture();
  const form = new FormData(); form.append("files", new File([new Uint8Array(MAX_ROUTE_BYTES + 1)], "too-large.gpx"));
  const oversized = await routes.request("/track-upload", { method: "POST", body: form });
  expect(oversized.status).toBe(413); expect(await oversized.json()).toEqual({ error: "file_too_large", limit: MAX_ROUTE_BYTES });
  const text = new FormData(); text.set("text", "Ordinary text remains a chat message.");
  expect((await routes.request("/track-upload", { method: "POST", body: text })).status).toBe(422);
});

import { symlink, writeFile, rename } from "node:fs/promises";

test("actual track reads refuse file, manifest and internal directory symlinks, while treating manifest summaries as untrusted", async () => {
  const { root } = await fixture();
  const staged = await stageShare(root, { files: [new File([gpx], "loop.gpx")] });
  const path = staged.files[0]!.path; const original = join(root, path); const directory = original.slice(0, original.lastIndexOf("/")); const manifest = join(directory, "meta.json");
  const metadata = JSON.parse(await readFile(manifest, "utf8"));
  metadata.files[0].summary.measurements.distance.value = 999999; metadata.files[0].sha256 = "a".repeat(64);
  await writeFile(manifest, JSON.stringify(metadata));
  const honest = await readStagedTrack(root, path);
  expect(honest.file.summary!.counts.retained).toBe(2); expect(honest.file.summary!.measurements.distance.value!).toBeGreaterThan(100); expect(honest.file.summary!.measurements.distance.value!).toBeLessThan(112); expect(honest.file.sha256).not.toBe("a".repeat(64));
  const backup = join(root, "synthetic-original.gpx"); await rename(original, backup); await symlink(backup, original);
  await expect(readStagedTrack(root, path)).rejects.toThrow("symlink"); await rm(original); await rename(backup, original);
  const manifestBackup = join(root, "synthetic-meta.json"); await rename(manifest, manifestBackup); await symlink(manifestBackup, manifest);
  await expect(readStagedTrack(root, path)).rejects.toThrow("symlink"); await rm(manifest); await rename(manifestBackup, manifest);
  const parentBackup = join(root, "synthetic-internal-directory"); await rename(directory, parentBackup); await symlink(parentBackup, directory);
  await expect(readStagedTrack(root, path)).rejects.toThrow("symlink");
});
