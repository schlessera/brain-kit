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
