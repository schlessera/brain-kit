import { expect, test } from "bun:test";
import { generateSignedCookie } from "hono/cookie";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createActivityStore } from "../src/activity/store";
import { createPrincipal } from "../src/db/principals";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";
import { documentedRoutes, httpCoverageMatrix } from "./helpers/http-spec";

const SECRET = "http-contract-fixture-secret-0123456789";
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Check = { path?: string; init?: RequestInit; status?: number; body?: object; verify?: (response: Response, t: HttpContractApp) => Promise<void> };

// Each supported operation reaches its real handler with a live owner cookie.
// More detailed existing behavior checks are linked by the coverage matrix;
// this map is cross-checked with the spec and the actual Hono mounts.
const checks: Record<string, Check> = {
  "GET /api/health": { body: { status: "healthy" } },
  "GET /api/status": { body: { healthy: true, version: "dev", software: { sourceCommit: "dev" } } },
  "POST /api/auth/login": { init: json("POST", { password: "wrong-fixture-password" }), status: 401, body: { error: "Invalid credentials" } },
  "POST /api/auth/logout": { init: { method: "POST" }, body: { ok: true } },
  "GET /api/auth/methods": { body: { password: false, passkey: true } },
  "POST /api/auth/passkey/login-options": { init: { method: "POST" }, verify: async (r) => { expect((await r.json()).challenge.length).toBeGreaterThan(0); } },
  "POST /api/auth/passkey/login-verify": { init: json("POST", {}), status: 401, verify: async (r) => { expect((await r.json()).error).toBeString(); } },
  "POST /api/auth/passkey/register-options": { init: { method: "POST" }, verify: async (r) => { const b = await r.json(); expect(b.challenge.length).toBeGreaterThan(0); expect(b.excludeCredentials.map((c: { id: string }) => c.id)).toEqual(["fixture-key"]); } },
  "POST /api/auth/passkey/register-verify": { init: json("POST", {}), status: 400, body: { error: "Invalid request body" } },
  "GET /api/auth/passkey/list": { body: { credentials: [{ id: "fixture-key", label: "Fixture key", rpId: "localhost" }] } },
  "PUT /api/auth/passkey/:id": { path: "/api/auth/passkey/fixture-key", init: json("PUT", { label: "Renamed fixture" }), body: { ok: true }, verify: async (_, t) => { expect(t.app.db.query("SELECT label FROM passkey_credentials WHERE id = 'fixture-key'").get()).toEqual({ label: "Renamed fixture" }); } },
  "DELETE /api/auth/passkey/:id": { path: "/api/auth/passkey/fixture-key", init: { method: "DELETE" }, body: { ok: true }, verify: async (_, t) => { expect(t.app.db.query("SELECT id FROM passkey_credentials").all()).toHaveLength(0); } },
  "GET /api/auth/principals": { verify: async (r) => { const b = await r.json(); expect(b.principals).toHaveLength(1); expect(b.principals[0]).toMatchObject({ kind: "owner", is_own: true }); expect(b.principals[0].cookie).toBeUndefined(); } },
  "POST /api/auth/principals": { init: json("POST", { label: "Fixture delegate", ttlDays: 1 }), verify: async (r, t) => { const b = await r.json(); expect(b.label).toBe("Fixture delegate"); expect(b.cookie.length).toBeGreaterThan(0); expect(t.app.db.query("SELECT kind FROM principals WHERE id = ?").get(b.id)).toEqual({ kind: "agent" }); } },
  "DELETE /api/auth/principals/:id": { path: "/api/auth/principals/owner-to-revoke", init: { method: "DELETE" }, body: { ok: true } },
  "GET /api/brain/search": { path: "/api/brain/search?q=harbor&type=note&tag=voyage&mode=fts&limit=2", body: { results: [{ path: "notes/arrival.md" }], warnings: ["Fixture uses keyless retrieval"] } },
  "GET /api/brain/list": { body: { results: [{ path: "notes/arrival.md", tags: null }] } },
  "GET /api/brain/briefing": { body: { content: "Arrival: Odysseus reaches the harbor.\n" } },
  "GET /api/brain/stats": { body: { documents: 1, embeddings: null } },
  "GET /api/brain/stats/history": { body: { history: [{ documents: 1, embeddings: null }] } },
  "POST /api/brain/add": { init: json("POST", { content: "Odysseus reaches the harbor." }), body: { success: true, indexed: false, indexError: "Fixture indexing is unavailable", path: "notes/arrival.md" } },
  "POST /api/brain/index": { init: { method: "POST", headers: { "content-type": "application/json" }, body: "not parsed" }, body: { success: true } },
  "POST /api/brain/sync": { init: { method: "POST" }, verify: async (r) => { expect(r.headers.get("content-type")).toContain("text/event-stream"); const frames = (await r.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))); expect(frames.length).toBeGreaterThan(1); expect(frames.at(-1)).toMatchObject({ type: "done", success: true }); } },
  "GET /api/files/content": { path: "/api/files/content?path=notes/arrival.md", body: { path: "notes/arrival.md", kind: "markdown", content: "# Arrival\n\nOdysseus reaches the harbor.\n" } },
  "GET /api/activity/runs": { verify: async (r) => { const b = await r.json(); expect(b.history.map((v: { runId: string }) => v.runId)).toContain("fixture-run"); } },
  "GET /api/activity/runs/:runId": { path: "/api/activity/runs/fixture-run", body: { runId: "fixture-run", detailPruned: false, spans: [{ name: "Fixture turn", outcome: "success" }] } },
  "GET /api/activity/rollups": { verify: async (r) => { const b = await r.json(); expect(b.days.length).toBeGreaterThan(0); expect(b.days[0].costUsd).toBe(0.5); } },
  "GET /api/activity/stats": { verify: async (r) => { const b = await r.json(); expect(b).toHaveProperty("window"); expect(JSON.stringify(b)).toContain("0.5"); } },
  "POST /api/internal/inbox/poke": { init: { method: "POST" }, status: 503, body: { error: "inbox_poke_unconfigured" } },
  "GET /api/models": { body: { models: [{ id: "fixture", hidden: false }], discovery: { enabled: false } } },
  "PUT /api/models/hidden": { init: json("PUT", { hidden: ["fixture"] }), body: { models: [{ id: "fixture", hidden: true }] } },
  "POST /api/models/refresh": { init: { method: "POST" }, status: 409, verify: async (r) => { expect((await r.json()).error).toBeString(); } },
  "GET /api/providers": { body: { providers: [{ id: "fixture" }], backends: { fixture: { id: "fixture" } } } },
  "GET /api/sessions": { body: { sessions: [{ id: "fixture-session", backendId: "fixture", title: "Arrival" }] } },
  "GET /api/sessions/:id": { path: "/api/sessions/fixture-session", body: { id: "fixture-session", messages: [{ role: "assistant", content: "Odysseus reaches the harbor." }] } },
  "GET /api/push/public-key": { verify: async (r) => { const b = await r.json(); expect(b.publicKey.length).toBeGreaterThan(0); expect(Object.keys(b)).toEqual(["publicKey"]); } },
  "GET /api/push/subscriptions": { body: { subscriptions: [] } },
  "POST /api/push/subscribe": { init: json("POST", { subscription: { endpoint: "https://push.example/fixture", keys: { p256dh: "fixture-key", auth: "fixture-auth" } } }), body: { ok: true } },
  "POST /api/push/unsubscribe": { init: json("POST", { endpoint: "https://push.example/missing" }), body: { removed: false } },
  "POST /api/queue": { init: json("POST", { key: "fixture-intake", text: "Odysseus reaches the harbor." }), status: 201, body: { queued: true, created: true }, verify: async (_, t) => { expect(t.app.db.query("SELECT source, trust_class FROM inbox_threads").get()).toEqual({ source: "cli", trust_class: "trusted" }); } },
  "POST /api/share": { init: { method: "POST" }, status: 201, body: { text: "Odysseus reaches the harbor.", files: [] } },
  "POST /api/schedules/proposals": { init: json("POST", { key: "fixture-schedule", definition: { prompt: "Read notes/arrival.md.", when: { kind: "cron", cron: "0 7 * * 1-5", timeZone: "Europe/Athens" },
    scope: { operation: "Read the arrival", tools: [{ name: "brain_read", inputs: { path: "notes/arrival.md" } }], targets: ["notes/arrival.md"], egress: [], variableInputs: [] } } }),
    status: 201, body: { ok: true, proposal: { approvalState: "pending", zoneSource: "explicit", executionPolicy: { backendId: "fixture", inferenceOrigins: ["https://inference.example"] } } } },
  "POST /api/schedules/proposals/:id/approve": { path: "/api/schedules/proposals/proposal_missing/approve", init: json("POST", { fingerprint: "0".repeat(64), decision: "approve" }), status: 404, body: { ok: false, error: { code: "not_found" } } },
  "POST /api/schedules": { init: json("POST", { proposalId: "proposal_missing" }), status: 404, body: { ok: false, error: { code: "not_found" } } },
  "GET /api/schedules": { body: { ok: true, tasks: [], nextCursor: null }, verify: async (r) => { expect(r.headers.get("cache-control")).toBe("no-store"); } },
  "POST /api/schedules/:id/cancel": { path: "/api/schedules/task_missing/cancel", init: json("POST", { key: "fixture-cancel" }), status: 404, body: { ok: false, error: { code: "not_found" } } },
  "GET /api/schedules/due": { body: { ok: true, due: [], nextCursor: null }, verify: async (r) => { expect((await r.json()).evaluatedAt).toMatch(/Z$/); } },
  "POST /share-target": { init: { method: "POST" }, status: 303, verify: async (r) => { expect(r.headers.get("location")).toBe("/?share_error=no_worker"); } },
  "POST /api/render": { init: json("POST", { content: "# Arrival", contentType: "markdown", format: "png" }), status: 501, body: { error: "render_unavailable" } },
  "GET /api/geo/coastline": { path: "/api/geo/coastline?bbox=15.6,38.2,15.8,38.32", body: { coastline: [], attribution: "© OpenStreetMap contributors" } },
  "POST /api/voice/session": { init: { method: "POST" }, body: { providerId: "webspeech", url: "", expiresAt: 0, capabilities: { streaming: true } } },
  "POST /api/voice/token": { init: { method: "POST" }, status: 500, verify: async (r) => { expect((await r.json()).error).toContain("DEEPGRAM_API_KEY"); } },
  "GET /api/voice/keyterms": { body: { keyterms: ["Odysseus"], count: 1 } },
  "GET /api/voice/overrides": { body: { overrides: [{ match: "Odysseus", replacement: "Odysseus" }] } },
};

test("every supported method/path has a named real handler check", () => {
  expect(Object.keys(checks).length).toBeGreaterThan(0);
  expect([...Object.keys(checks), "GET /ws"].sort()).toEqual(documentedRoutes.filter((r) => r.classification === "S").map((r) => `${r.method} ${r.path}`).sort());
});

for (const [operation, check] of Object.entries(checks)) {
  test(`mounted supported handler: ${operation}`, async () => {
    const t = await httpContractApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" } });
    try {
      const owner = createPrincipal(t.app.db, { authMethod: "password", label: "Odysseus device", ttlSeconds: 3600 });
      const cookie = (await generateSignedCookie("brain_ui_session", owner.id, SECRET)).split(";")[0]!;
      t.app.db.query("INSERT INTO passkey_credentials (id, public_key, counter, rp_id, label, created_at) VALUES ('fixture-key', ?, 0, 'localhost', 'Fixture key', 1)").run(new Uint8Array([1, 2, 3]));
      if (operation === "POST /api/auth/login") t.app.db.exec("DELETE FROM passkey_credentials");
      if (operation === "DELETE /api/auth/principals/:id") {
        t.app.db.query("INSERT INTO principals (id, kind, auth_method, label, created_at, expires_at) VALUES ('owner-to-revoke', 'owner', 'password', 'Other fixture device', 1, ?)").run(Date.now() + 3600_000);
      }
      const store = createActivityStore(t.app.db, { writer: "http-contract" });
      store.startSpan({ spanId: "fixture-span", runId: "fixture-run", name: "Fixture turn", kind: "turn", origin: "session", sessionId: "fixture-session", principalId: owner.id, startedAt: Date.now() - 1000 });
      store.endSpan("fixture-span", { outcome: "success", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 } });
      store.rollupRun("fixture-run");
      mkdirSync(t.app.config.voice.cacheDir, { recursive: true });
      writeFileSync(join(t.app.config.voice.cacheDir, "keyterms.json"), JSON.stringify({ version: 2, generatedAt: Date.now(), keyterms: ["Odysseus"], count: 1, overrides: [{ match: "Odysseus", replacement: "Odysseus" }] }));
      const headers = new Headers(check.init?.headers);
      headers.set("cookie", cookie);
      headers.set("origin", "http://localhost");
      headers.set("host", "localhost");
      let body = check.init?.body;
      if (operation === "POST /api/share") { const form = new FormData(); form.set("text", "Odysseus reaches the harbor."); body = form; }
      const path = check.path ?? operation.slice(operation.indexOf(" ") + 1);
      const response = await t.fetch(path, { ...check.init, headers, body });
      expect(response.status).toBe(check.status ?? 200);
      if (check.body !== undefined) { expect(Object.keys(check.body as object).length).toBeGreaterThan(0); expect(await response.clone().json()).toMatchObject(check.body); }
      await check.verify?.(response, t);
      if (operation.includes("/api/brain/") && operation !== "POST /api/brain/sync") {
        const command = operation.split("/").at(-1)!;
        const args = readFileSync(join(t.root, "cli.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
        expect(args.some((a) => a[0] === (command === "history" ? "stats" : command))).toBe(true);
      }
    } finally { await t.close(); }
  });
}

test("coverage matrix names every supported operation and its real mounting receipt", () => {
  const rows = [...httpCoverageMatrix.matchAll(/^\| `(GET|POST|PUT|DELETE) ([^`]+)` \| ([^|]+) \|/gm)];
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.map((r) => `${r[1]} ${r[2]}`).sort()).toEqual(documentedRoutes.filter((r) => r.classification === "S").map((r) => `${r.method} ${r.path}`).sort());
  for (const row of rows) {
    expect(row[3]!.trim()).toBe(row[2] === "/ws" ? "Real upgrade and server_hello" : `\`mounted supported handler: ${row[1]} ${row[2]}\``);
  }
});
