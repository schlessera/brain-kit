import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createTestApp, type TestApp } from "./helpers/test-app";

const FRAME_ANCESTORS = "frame-ancestors 'none'";

let app: TestApp;
let staticRoot: string;

beforeAll(() => {
  staticRoot = mkdtempSync(join(tmpdir(), "brain-ui-frame-headers-"));
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>shell</title>");
  writeFileSync(join(staticRoot, "asset.js"), "export {};\n");
  app = createTestApp({ appOptions: { staticRoot } });
  writeFileSync(join(app.brainPath, "note.md"), "# Frame header fixture\n");
});

afterAll(async () => {
  await app.teardown();
  rmSync(staticRoot, { recursive: true, force: true });
});

function expectFrameHeaders(response: Response): void {
  const csp = response.headers.get("content-security-policy");
  expect(csp).not.toBeNull();
  expect(csp!).toContain(FRAME_ANCESTORS);
  expect(response.headers.get("x-frame-options")).toBe("DENY");
}

describe("frame protection headers", () => {
  test("protects the SPA entry and fallback", async () => {
    const entry = await app.fetch("/");
    const fallback = await app.fetch("/some/deep/link");

    expect(entry.status).toBe(200);
    expect(fallback.status).toBe(200);
    expectFrameHeaders(entry);
    expectFrameHeaders(fallback);
  });

  test("protects static assets", async () => {
    const response = await app.fetch("/asset.js");

    expect(response.status).toBe(200);
    expectFrameHeaders(response);
  });

  test("protects API responses", async () => {
    const health = await app.fetch("/api/health");
    const file = await app.fetch("/api/files/content?path=note.md");

    expect(health.status).toBe(200);
    expect(file.status).toBe(200);
    expectFrameHeaders(health);
    expectFrameHeaders(file);
  });

  test("appends frame protection to the raw file CSP", async () => {
    const response = await app.fetch("/api/files/content?path=note.md&raw=1");

    expect(response.status).toBe(200);
    expectFrameHeaders(response);
    const csp = response.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("style-src 'unsafe-inline'");
  });

  test("protects a plain GET to the WebSocket path", async () => {
    const response = await app.fetch("/ws");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "WebSocket upgrade required" });
    expectFrameHeaders(response);
  });

  test("does not add frame headers to a rejected WebSocket upgrade", async () => {
    const response = await app.fetch("/ws", {
      headers: {
        connection: "keep-alive, UpGrAdE",
        upgrade: "WebSocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        "sec-fetch-site": "cross-site",
      },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Cross-origin WebSocket rejected" });
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("x-frame-options")).toBeNull();
  });
});
