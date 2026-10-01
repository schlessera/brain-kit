import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { httpContractApp } from "./helpers/http-contract-app";
import { documentedRoutes, httpSpecification } from "./helpers/http-spec";

test("real app method/path inventory equals the complete classified HTTP specification", async () => {
  expect(documentedRoutes.length).toBeGreaterThan(0);
  expect(new Set(documentedRoutes.map((r) => `${r.method} ${r.path}`)).size).toBe(documentedRoutes.length);
  for (const staticRoot of [false, true]) {
    const t = await httpContractApp({ staticRoot });
    try {
      const declared = [...new Set(t.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`))].sort();
      const specified = documentedRoutes.filter((r) => !r.conditional || staticRoot).map((r) => `${r.method} ${r.path}`).sort();
      expect(declared).toEqual(specified);
      if (!staticRoot) {
        const proseCounts = [...httpSpecification.matchAll(/(?: (\d+) unique declared|All (\d+) declared endpoints)/g)]
          .map((m) => Number(m[1] ?? m[2]));
        expect(proseCounts.length).toBe(2);
        expect(proseCounts).toEqual([declared.length, declared.length]);
      }
      const middleware = [...new Set(t.routes.filter((r) => r.method === "ALL").map((r) => r.path))].sort();
      expect(middleware).toEqual(["/*", "/api/*", "/api/auth/passkey/*", "/api/auth/principals/*", "/api/internal/inbox/poke"]);
      expect(t.routes.filter((r) => r.method === "ALL" && r.path === "/*")).toHaveLength(staticRoot ? 3 : 2);
      expect(t.routes.some((r) => r.method === "HEAD" || r.method === "OPTIONS")).toBe(false);
    } finally { await t.close(); }
  }
});

test("implicit HEAD preserves every ordinary GET handler's status and headers while suppressing its body", async () => {
  const t = await httpContractApp({ staticRoot: true });
  try {
    // Parameterized rows use a missing ID/path, still reaching their actual
    // handler. WebSocket admission deliberately requires an actual GET.
    for (const route of documentedRoutes.filter((r) => r.method === "GET" && r.path !== "/ws")) {
      const path = route.path.replace(/:[^/]+/g, "missing").replace("/*", "/deep/link");
      const get = await t.fetch(path);
      const head = await t.fetch(path, { method: "HEAD" });
      expect({ path, status: head.status }).toEqual({ path, status: get.status });
      expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
      expect(await head.text()).toBe("");
      await get.arrayBuffer();
    }
  } finally { await t.close(); }
});

test("configured CORS preflight runs before authentication and refuses unapproved origins", async () => {
  const t = await httpContractApp({ env: { AUTH_MODE: "proxy", TRUST_PROXY: "1", PROXY_AUTH_HEADER: "x-fixture-user", ALLOWED_ORIGINS: "https://client.example" } });
  try {
    const response = await t.fetch("/api/status", { method: "OPTIONS", headers: {
      origin: "https://client.example", "access-control-request-method": "GET", "access-control-request-headers": "Content-Type",
    } });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://client.example");
    expect(response.headers.get("access-control-allow-methods")?.split(",").sort()).toEqual(["DELETE", "GET", "POST", "PUT"]);
    expect(response.headers.get("access-control-allow-headers")).toBe("Content-Type");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(await response.text()).toBe("");
    expect((await t.fetch("/api/status", { method: "OPTIONS", headers: { origin: "https://attacker.example" } })).status).toBe(403);
    expect((await t.fetch("/api/status")).status).toBe(401);
  } finally { await t.close(); }
  const unconfigured = await httpContractApp({ env: { AUTH_MODE: "proxy", TRUST_PROXY: "1", PROXY_AUTH_HEADER: "x-fixture-user" } });
  try {
    expect((await unconfigured.fetch("/api/status", { method: "OPTIONS" })).status).toBe(401);
    expect((await unconfigured.fetch("/api/status", { method: "OPTIONS", headers: { "x-fixture-user": "Odysseus" } })).status).toBe(404);
  } finally { await unconfigured.close(); }
});

test("conditional SPA fallback serves deep links, preserves API precedence and reports a missing index", async () => {
  const t = await httpContractApp({ staticRoot: true });
  try {
    const deep = await t.fetch("/deep/link");
    expect(deep.status).toBe(200);
    expect(deep.headers.get("content-type")).toContain("text/html");
    expect(await deep.text()).toContain("<main>Harbor</main>");
    expect((await (await t.fetch("/api/health")).json()).status).toBe("healthy");
    const unknownApi = await t.fetch("/api/no-such-route");
    expect(unknownApi.headers.get("content-type")).toContain("text/html");
    expect(await unknownApi.text()).toContain("<main>Harbor</main>");
    rmSync(join(t.staticRoot, "index.html"));
    expect((await t.fetch("/deep/link")).status).toBe(404);
  } finally { await t.close(); }
});

test("conditional static middleware serves existing assets before the SPA fallback", async () => {
  const t = await httpContractApp({ staticRoot: true });
  try {
    const asset = await t.fetch("/fixture.css");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/css");
    expect(await asset.text()).toBe("main { color: #123456; }");
  } finally { await t.close(); }
});
