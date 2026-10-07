// The interactive HTML preview route (#1084). These pin what the server sends;
// whether Chrome honours it is proven in
// packages/ui-react/tests/html-preview-runtime.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateSignedCookie } from "hono/cookie";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { createPrincipal } from "../src/db/principals";
import { HTML_PREVIEW_CSP } from "../src/routes/files";
import { createTestApp, type TestApp } from "./helpers/test-app";

const SECRET = "html-preview-fixture-secret-0123456789";
const PAGE = "<!doctype html><title>Ithaca beacon</title><script>document.title += ' lit'</script>\n";
const EXPECTED_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'";

let app: TestApp;
let outside: string;
let cookie = "";

beforeAll(async () => {
  outside = mkdtempSync(join(tmpdir(), "brain-ui-html-outside-"));
  writeFileSync(join(outside, "suitors.html"), "<p>outside the brain</p>");
  app = await createTestApp({
    env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET },
    prepare: (brain) => {
      mkdirSync(join(brain, "voyage"), { recursive: true });
      writeFileSync(join(brain, "voyage", "beacon.html"), PAGE);
      writeFileSync(join(brain, "voyage", "LOG.HTM"), PAGE);
      writeFileSync(join(brain, "voyage", "log.md"), "# Log\n");
      writeFileSync(join(brain, "voyage", "big.html"), Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));
      symlinkSync(join(brain, "voyage", "log.md"), join(brain, "voyage", "disguised.html"));
      symlinkSync(join(outside, "suitors.html"), join(brain, "voyage", "escape.html"));
    },
  });
  const principal = createPrincipal(app.app.db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
  cookie = (await generateSignedCookie("brain_ui_session", principal.id, SECRET)).split(";")[0]!;
});

afterAll(async () => {
  await app.teardown();
  rmSync(outside, { recursive: true, force: true });
});

const authed = (path: string, init: RequestInit = {}) =>
  app.fetch(path, { ...init, headers: { cookie, host: "localhost", ...(init.headers ?? {}) } });
const preview = (path: string, init?: RequestInit) => authed(`/api/files/html?path=${encodeURIComponent(path)}`, init);

describe("GET /api/files/html", () => {
  test("serves the file under the sandboxing policy, framable by the app alone", async () => {
    const response = await preview("voyage/beacon.html");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE);
    expect(HTML_PREVIEW_CSP).toBe(EXPECTED_CSP);
    expect(response.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(PAGE)));
  });

  test("the policy grants no popups, same origin, forms, downloads or top navigation", async () => {
    const response = await preview("voyage/beacon.html");
    expect(response.status).toBe(200);
    const sandbox = response.headers.get("content-security-policy")!.split(";")[0]!.trim().split(/\s+/);
    expect(sandbox).toEqual(["sandbox", "allow-scripts"]);
  });

  test("accepts .htm in any case", async () => {
    const response = await preview("voyage/LOG.HTM");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
  });

  test("HEAD answers like GET without a body", async () => {
    const response = await preview("voyage/beacon.html", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
    expect(await response.text()).toBe("");
  });

  test("rejects an unauthenticated request exactly like ?raw=1", async () => {
    const html = await app.fetch("/api/files/html?path=voyage/beacon.html");
    const raw = await app.fetch("/api/files/content?path=voyage/beacon.html&raw=1");

    expect(html.status).toBe(401);
    expect(html.status).toBe(raw.status);
    expect(await html.json()).toEqual(await raw.json());
    expect(html.headers.get("x-frame-options")).toBe("DENY");
    expect(html.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });

  test("refuses a non-HTML extension, including a symlink disguised as one", async () => {
    for (const path of ["voyage/log.md", "voyage/disguised.html", "voyage/beacon.html.txt"]) {
      const response = await preview(path);
      expect({ path, status: response.status }).toEqual({ path, status: 400 });
      expect(await response.json()).toEqual({ error: "not_html" });
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
  });

  test("refuses paths outside the brain root", async () => {
    for (const path of ["../outside.html", "/etc/hosts.html", "voyage/escape.html", "voyage\\..\\x.html"]) {
      const response = await preview(path);
      expect({ path, status: response.status }).toEqual({ path, status: 400 });
      expect(await response.json()).toEqual({ error: "invalid_path" });
    }
  });

  test("missing, absent and oversized files answer like ?raw=1", async () => {
    const missing = await preview("voyage/nowhere.html");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });

    const absent = await authed("/api/files/html");
    expect(absent.status).toBe(400);
    expect(await absent.json()).toEqual({ error: "missing_path" });

    const big = await preview("voyage/big.html");
    expect(big.status).toBe(413);
    expect((await big.json()).error).toBe("file_too_large");
    expect(big.headers.get("x-frame-options")).toBe("DENY");
  });

  test("the raw route keeps its own CSP and DENY for the same file", async () => {
    const raw = await authed("/api/files/content?path=voyage/beacon.html&raw=1");
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-security-policy")).toBe(
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'"
    );
    expect(raw.headers.get("x-frame-options")).toBe("DENY");
  });
});
