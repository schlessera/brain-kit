import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestApp, type TestApp } from "./helpers/test-app";

const FORM_SHAPED_JSON = '{"formPadding":"="}\r\n';
const WS_UPGRADE_HEADERS = {
  connection: "Upgrade",
  upgrade: "websocket",
  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  "sec-websocket-version": "13",
} as const;

let app: TestApp;
let splitApp: TestApp;
let trustedProxyApp: TestApp;
let webauthnOverrideApp: TestApp;

beforeAll(() => {
  app = createTestApp();
  splitApp = createTestApp({
    env: { ALLOWED_ORIGINS: "https://client.example" },
  });
  trustedProxyApp = createTestApp({ env: { TRUST_PROXY: "1" } });
  webauthnOverrideApp = createTestApp({
    env: {
      AUTH_MODE: "password",
      BRAIN_UI_PASSWORD_HASH: "unused-test-hash",
      COOKIE_SECRET: "test-cookie-secret-0123456789abcdef",
      WEBAUTHN_ORIGINS: "https://alias.test",
    },
  });
});

afterAll(() => {
  webauthnOverrideApp.teardown();
  trustedProxyApp.teardown();
  splitApp.teardown();
  app.teardown();
});

function textPlainPost(path: string): Promise<Response> {
  return app.fetch(path, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
    // This is valid JSON and also the output shape of a text/plain HTML form
    // whose input name is `{"formPadding":"` and whose value is `"}`.
    body: FORM_SHAPED_JSON,
  });
}

describe("API origin policy", () => {
  for (const path of [
    "/api/skills/install/github",
    "/api/brain/add",
    "/api/render",
    "/api/auth/login",
    "/api/auth/passkey/login-verify",
  ]) {
    test(`rejects a cross-site text/plain form-shaped POST to ${path}`, async () => {
      expect((await textPlainPost(path)).status).toBe(403);
    });
  }

  test("rejects a mismatched Origin", async () => {
    const response = await app.fetch("/api/skills/install/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "api.example",
        origin: "https://attacker.example",
      },
      body: "{}",
    });

    expect(response.status).toBe(403);
  });

  test("rejects the opaque Origin value null", async () => {
    const response = await app.fetch("/api/skills/install/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "null",
      },
      body: "{}",
    });

    expect(response.status).toBe(403);
  });

  test("allows absent browser origin headers through to the JSON gate", async () => {
    const response = await app.fetch("/api/skills/install/github", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: FORM_SHAPED_JSON,
    });

    expect(response.status).not.toBe(403);
    expect(response.status).toBe(415);
  });

  test("trusts same-origin fetch metadata despite dev-proxy Host and Origin mismatches", async () => {
    const response = await app.fetch("/api/skills/install/github", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        host: "localhost:3000",
        origin: "http://localhost:5173",
        "sec-fetch-site": "same-origin",
      },
      body: FORM_SHAPED_JSON,
    });

    expect(response.status).not.toBe(403);
    expect(response.status).toBe(415);
  });

  test("accepts an ALLOWED_ORIGINS split-topology share", async () => {
    const form = new FormData();
    form.set("title", "Shared from the configured client");

    const response = await splitApp.fetch("/api/share", {
      method: "POST",
      headers: {
        origin: "https://client.example",
        "sec-fetch-site": "cross-site",
      },
      body: form,
    });

    expect(response.status).toBe(201);
  });

  test("uses trusted X-Forwarded-Proto for a same-origin share", async () => {
    const form = new FormData();
    form.set("title", "Shared through a trusted HTTPS proxy");

    const response = await trustedProxyApp.fetch("/api/share", {
      method: "POST",
      headers: {
        host: "api.example",
        origin: "https://api.example",
        "x-forwarded-proto": "https",
      },
      body: form,
    });

    expect(response.status).toBe(201);
  });

  test("allows an HTTPS Origin through an untrusted TLS-terminating proxy", async () => {
    const form = new FormData();
    form.set("title", "Shared through an untrusted HTTPS proxy");

    const response = await app.fetch("/api/share", {
      method: "POST",
      headers: {
        host: "api.example",
        origin: "https://api.example",
      },
      body: form,
    });

    expect(response.status).toBe(201);
  });

  test("accepts WEBAUTHN_ORIGINS on a passkey ceremony through a Host-rewriting proxy", async () => {
    const response = await webauthnOverrideApp.fetch(
      "/api/auth/passkey/login-options",
      {
        method: "POST",
        headers: {
          host: "example.test",
          origin: "https://alias.test",
        },
      }
    );

    expect(response.status).toBe(200);
  });

  test("rejects an unconfigured origin on a passkey ceremony", async () => {
    const response = await webauthnOverrideApp.fetch(
      "/api/auth/passkey/login-options",
      {
        method: "POST",
        headers: {
          host: "example.test",
          origin: "https://attacker.test",
        },
      }
    );

    expect(response.status).toBe(403);
  });

  test("does not accept WEBAUTHN_ORIGINS outside passkey ceremonies", async () => {
    const response = await webauthnOverrideApp.fetch("/api/brain/add", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "example.test",
        origin: "https://alias.test",
      },
      body: "{}",
    });

    expect(response.status).toBe(403);
  });
});

describe("JSON media type gate", () => {
  test("rejects text/plain but accepts application/json parameters", async () => {
    const plain = await app.fetch("/api/skills/install/github", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: FORM_SHAPED_JSON,
    });
    const jsonWithCharset = await app.fetch("/api/skills/install/github", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: "{}",
    });

    expect(plain.status).toBe(415);
    expect(jsonWithCharset.status).not.toBe(403);
    expect(jsonWithCharset.status).not.toBe(415);
  });
});

describe("WebSocket origin policy", () => {
  test("rejects cross-site fetch metadata before upgrade", async () => {
    const response = await app.fetch("/ws", {
      headers: {
        ...WS_UPGRADE_HEADERS,
        "sec-fetch-site": "cross-site",
      },
    });

    expect(response.status).toBe(403);
  });

  test("allows a scheme-mismatched Origin when proxy headers are untrusted", async () => {
    const response = await app.fetch("/ws", {
      headers: {
        ...WS_UPGRADE_HEADERS,
        host: "api.example",
        origin: "https://api.example",
      },
    });

    expect(response.status).not.toBe(403);
  });

  test("uses trusted X-Forwarded-Proto for the expected origin scheme", async () => {
    const matching = await trustedProxyApp.fetch("/ws", {
      headers: {
        ...WS_UPGRADE_HEADERS,
        host: "api.example",
        origin: "https://api.example",
        "x-forwarded-proto": "https",
      },
    });
    const mismatched = await trustedProxyApp.fetch("/ws", {
      headers: {
        ...WS_UPGRADE_HEADERS,
        host: "api.example",
        origin: "http://api.example",
        "x-forwarded-proto": "https",
      },
    });

    expect(matching.status).not.toBe(403);
    expect(mismatched.status).toBe(403);
  });

  // Regression: a proxy that reports the CONNECTION scheme on an upgrade sends
  // `X-Forwarded-Proto: wss`, and a browser's Origin is always https. Taking
  // the forwarded value verbatim expected `wss://api.example` and refused
  // every browser that omits Sec-Fetch-Site on the handshake (Safari, and so
  // the installed PWA), while ordinary HTTP requests — forwarded as `https`
  // and sent with fetch metadata — kept working. Seen in production on
  // brain-kit 0.32.0.
  test("accepts an https Origin when the proxy forwards the wss upgrade scheme", async () => {
    const secure = await trustedProxyApp.fetch("/ws", {
      headers: {
        ...WS_UPGRADE_HEADERS,
        host: "api.example",
        origin: "https://api.example",
        "x-forwarded-proto": "wss",
      },
    });
    const plain = await trustedProxyApp.fetch("/ws", {
      headers: {
        ...WS_UPGRADE_HEADERS,
        host: "api.example",
        origin: "http://api.example",
        "x-forwarded-proto": "ws",
      },
    });
    // The mapping is scheme-preserving, not scheme-widening: a plaintext
    // upgrade still must not match an https Origin.
    const crossed = await trustedProxyApp.fetch("/ws", {
      headers: {
        ...WS_UPGRADE_HEADERS,
        host: "api.example",
        origin: "https://api.example",
        "x-forwarded-proto": "ws",
      },
    });

    expect(secure.status).not.toBe(403);
    expect(plain.status).not.toBe(403);
    expect(crossed.status).toBe(403);
  });
});
