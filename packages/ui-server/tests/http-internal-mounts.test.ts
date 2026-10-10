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

import { generateSignedCookie } from "hono/cookie";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createPrincipal } from "../src/db/principals";

// #1391 retired the daily briefing's script route. The proof has to stand
// behind a live owner cookie: without one the auth guard answers 401 for any
// path, routed or not. Both legacy script paths are planted and would leave a
// marker if anything ran them.
test("retired POST /api/brain/whatsup is absent behind authentication and runs no repo-local script", async () => {
  const secret = "http-retired-fixture-secret-0123456789";
  expect(documentedRoutes.some((r) => r.path === "/api/brain/whatsup")).toBe(false);
  const t = await httpContractApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: secret, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" } });
  try {
    const marker = join(t.root, "whatsup-ran");
    for (const rel of ["private", "scripts"]) {
      mkdirSync(join(t.brainPath, rel), { recursive: true });
      writeFileSync(join(t.brainPath, rel, "whatsup.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    }
    const owner = createPrincipal(t.app.db, { authMethod: "password", label: "Odysseus device", ttlSeconds: 3600 });
    const cookie = (await generateSignedCookie("brain_ui_session", owner.id, secret)).split(";")[0]!;
    const headers = { cookie, origin: "http://localhost", host: "localhost" };

    expect((await t.fetch("/api/brain/whatsup", { method: "POST", headers: { origin: "http://localhost", host: "localhost" } })).status).toBe(401);
    // The same cookie reaches the briefing the panel now reads.
    const briefing = await t.fetch("/api/brain/briefing", { headers });
    expect(briefing.status).toBe(200);
    expect(await briefing.json()).toEqual({ content: "Arrival: Odysseus reaches the harbor.\n" });

    const retired = await t.fetch("/api/brain/whatsup", { method: "POST", headers });
    expect(retired.status).toBe(404);
    expect(retired.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    expect(t.routes.some((r) => r.path === "/api/brain/whatsup")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(marker)).toBe(false);
  } finally { await t.close(); }
});
