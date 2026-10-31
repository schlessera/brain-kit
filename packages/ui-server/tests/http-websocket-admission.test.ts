import { expect, test } from "bun:test";
import { PROTOCOL_REV } from "@schlessera/brain-ui-sdk/client";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";

// Bun 1.3's global constructor accepts handshake headers. The DOM constructor
// type omits that runtime option; keep the adaptation confined to this harness.
const HeaderWebSocket = WebSocket as unknown as {
  new(url: string, options: { headers: Record<string, string> }): WebSocket;
};

async function listener(t: HttpContractApp) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: t.app.fetch, websocket: t.app.websocket });
  return {
    server,
    http: `http://127.0.0.1:${server.port}`,
    ws: `ws://127.0.0.1:${server.port}/ws`,
    host: `127.0.0.1:${server.port}`,
  };
}

// Success means the real upgrade and connection handler sent their frame,
// rather than merely observing that an HTTP error was not a 403.
async function hello(url: string, headers: Record<string, string>) {
  const ws = new HeaderWebSocket(url, { headers });
  try {
    return await new Promise<{ type: string; protocolRev: number }>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("No server_hello after real WebSocket admission")); }, 3000);
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "server_hello") { clearTimeout(timer); resolve(frame); }
      });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Real WebSocket upgrade failed")); });
      ws.addEventListener("close", () => { clearTimeout(timer); reject(new Error("WebSocket closed before server_hello")); });
    });
  } finally { ws.close(); }
}

for (const [name, trustProxy, scheme, forwarded] of [
  ["untrusted proxy accepts a matching HTTPS Origin", false, "https", undefined],
  ["trusted proxy accepts forwarded HTTPS", true, "https", "https"],
  ["trusted proxy maps WSS to HTTPS", true, "https", "wss"],
  ["trusted proxy maps WS to HTTP", true, "http", "ws"],
] as const) {
  test(`real WebSocket admission: ${name}`, async () => {
    const t = await httpContractApp({ env: { TRUST_PROXY: trustProxy ? "1" : "0" } });
    const running = await listener(t);
    try {
      // A plain await: admission resolves its principal on the write worker
      // (#2850), whose reply `.resolves`' nested loop never delivers.
      expect(await hello(running.ws, {
        origin: `${scheme}://${running.host}`,
        ...(forwarded ? { "x-forwarded-proto": forwarded } : {}),
      })).toMatchObject({ type: "server_hello", protocolRev: PROTOCOL_REV });
    } finally { running.server.stop(true); await t.close(); }
  });
}

test("real WebSocket admission rejects origin, authentication and capacity before upgrading", async () => {
  const t = await httpContractApp({ env: {
    AUTH_MODE: "proxy", TRUST_PROXY: "1", PROXY_AUTH_HEADER: "x-fixture-user", BRAIN_UI_WS_MAX_CONNECTIONS: "1",
  } });
  const running = await listener(t);
  const upgradeHeaders = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };
  const request = (headers: Record<string, string>) => fetch(`${running.http}/ws`, { headers: { ...upgradeHeaders, ...headers } });
  let ws: WebSocket | undefined;
  try {
    const rejected = await request({ origin: "https://attacker.example", "x-fixture-user": "Odysseus" });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: "Cross-origin WebSocket rejected" });
    const crossed = await request({ origin: `https://${running.host}`, "x-forwarded-proto": "ws", "x-fixture-user": "Odysseus" });
    expect(crossed.status).toBe(403);
    const anonymous = await request({ origin: running.http });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "Authentication required" });
    const ordinary = await fetch(`${running.http}/ws`, { headers: { "x-fixture-user": "Odysseus" } });
    expect(ordinary.status).toBe(400);
    expect(await ordinary.json()).toEqual({ error: "WebSocket upgrade required" });

    ws = new HeaderWebSocket(running.ws, { headers: { origin: running.http, "x-fixture-user": "Odysseus" } });
    await new Promise<void>((resolve, reject) => {
      ws!.addEventListener("open", () => resolve());
      ws!.addEventListener("error", () => reject(new Error("Authorized positive-control socket failed")));
    });
    expect(t.app.wsHost.clients.count()).toBe(1);
    const full = await request({ origin: running.http, "x-fixture-user": "Odysseus" });
    expect(full.status).toBe(503);
    expect(await full.text()).toBe("WebSocket connection limit reached");
  } finally { ws?.close(); running.server.stop(true); await t.close(); }
});

test("real Tailscale WebSocket admission uses the configured trusted forwarded identity", async () => {
  const t = await httpContractApp({ env: {
    AUTH_MODE: "tailscale", TRUST_PROXY: "1", TRUST_PROXY_HOPS: "2",
  } });
  const running = await listener(t);
  try {
    // The socket itself is loopback. The configured trusted path must still
    // reject this peer, even with an attacker-controlled CGNAT leftmost entry.
    const deniedIdentity = "100.64.0.9, 192.168.1.1, 10.0.0.2";
    const health = await fetch(`${running.http}/api/health`, {
      headers: { "x-forwarded-for": deniedIdentity },
    });
    expect(health.status).toBe(200);
    const denied = await fetch(`${running.http}/ws`, { headers: {
      origin: running.http, "x-forwarded-for": deniedIdentity,
      connection: "Upgrade", upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13",
    } });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "Authentication required" });
    expect(t.app.wsHost.clients.count()).toBe(0);
    expect(t.app.db.query("SELECT label FROM principals WHERE kind = 'ambient'").all()).toEqual([]);

    for (const identity of ["100.100.1.1", "127.0.0.1"]) {
      expect(await hello(running.ws, {
        origin: running.http,
        "x-forwarded-for": `192.168.1.1, ${identity}, 10.0.0.2`,
      })).toMatchObject({ type: "server_hello", protocolRev: PROTOCOL_REV });
      // The admitted principal comes from the configured hop, not the socket,
      // the spoofable first entry or the rightmost proxy address.
      expect(t.app.db.query("SELECT label FROM principals WHERE kind = 'ambient' AND label = ?").all(identity))
        .toEqual([{ label: identity }]);
    }
  } finally { running.server.stop(true); await t.close(); }
});
