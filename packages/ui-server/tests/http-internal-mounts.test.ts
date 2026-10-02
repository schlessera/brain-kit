import { expect, test } from "bun:test";
import { httpContractApp } from "./helpers/http-contract-app";
import { documentedRoutes } from "./helpers/http-spec";

// Internal families still need a real mounting receipt, without promoting
// their presentation/configuration payloads to independent HTTP contracts.
for (const path of ["/api/pi-auth/providers", "/api/web-search", "/api/tool-permissions", "/api/skills", "/api/graph/meta", "/api/vpn-check"]) {
  test(`mounted internal router: GET ${path}`, async () => {
    expect(documentedRoutes.some((r) => r.method === "GET" && r.path === path && r.classification === "I")).toBe(true);
    const t = await httpContractApp();
    try {
      const response = await t.fetch(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(Object.keys(await response.json()).length).toBeGreaterThan(0);
    } finally { await t.close(); }
  });
}

import { stageShare } from "../src/share/staging.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

for (const operation of ["POST /api/track-upload", "GET /api/tracks"]) test(`mounted internal track handler: ${operation}`, async () => {
  const [method, path] = operation.split(" ");
  expect(documentedRoutes.some(route => route.method === method && route.path === path && route.classification === "I")).toBe(true);
  const t = await httpContractApp();
  const source = '<gpx version="1.1"><trk><trkseg><trkpt lat="2" lon="3"/><trkpt lat="2" lon="3.001"/></trkseg></trk></gpx>';
  try {
    const file = new File([source], "shared-1", { type: "application/octet-stream" });
    let response: Response;
    if (method === "POST") { const form = new FormData(); form.append("files", file); response = await t.fetch(path!, { method, body: form, headers: { origin: "http://localhost", host: "localhost" } }); }
    else { const staged = await stageShare(t.brainPath, { files: [file] }); response = await t.fetch(`${path}?path=${encodeURIComponent(staged.files[0]!.path)}`); }
    expect(response.status).toBe(method === "POST" ? 201 : 200);
    const body = await response.json(); const metadata = method === "POST" ? body.files[0] : body.file;
    expect(metadata.detected).toBe("gpx"); expect(metadata.summary.counts.retained).toBe(2); expect(metadata.summary.measurements.distance.value).toBeGreaterThan(100);
    expect(await readFile(join(t.brainPath, metadata.path), "utf8")).toBe(source);
    expect(t.app.db.query("SELECT count(*) AS n FROM inbox_threads").get()).toEqual({ n: 0 });
  } finally { await t.close(); }
});
