import { expect, test } from "bun:test";
import { generateSignedCookie } from "hono/cookie";

import { createPrincipal } from "../src/db/principals";
import { recordGovernanceEvent, type GovernanceEventInput } from "../src/governance/events";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";

const SECRET = "governance-http-fixture-secret-0123456789";
const ENV = { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: SECRET, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" };

async function withApp(run: (t: HttpContractApp, get: (path: string) => Promise<Response>) => Promise<void>): Promise<void> {
  const t = await httpContractApp({ env: ENV });
  try {
    const owner = createPrincipal(t.app.db, { authMethod: "password", label: "Odysseus device", ttlSeconds: 3600 });
    const cookie = (await generateSignedCookie("brain_ui_session", owner.id, SECRET)).split(";")[0]!;
    for (const id of ["sess-ithaca", "sess-troy"]) {
      t.app.db.query("INSERT INTO sessions (id, title, created_at, last_active_at) VALUES (?, 'Voyage', 1, 1)").run(id);
    }
    const write = (input: Partial<GovernanceEventInput> & Pick<GovernanceEventInput, "kind" | "payload">) =>
      recordGovernanceEvent(t.app.db, { sessionId: "sess-ithaca", turnId: "turn-1", actor: "interactive", model: "claude-opus-5", profile: "governed", at: 1_800_000_000_000, ...input } as GovernanceEventInput);
    const taint = { source: "web_fetch", tool: "WebFetch", detail: "https://sirens.example/song" } as const;
    const fallback = { path: ".claude/settings.json", reason: "symlink" } as const;
    write({ kind: "taint", payload: taint });
    write({ kind: "strict_fallback", payload: fallback });
    write({ kind: "strict_fallback", payload: fallback, turnId: "turn-2" });
    write({ kind: "taint", payload: taint, sessionId: "sess-troy", turnId: "turn-troy" });
    write({ kind: "taint", payload: taint, sessionId: null, turnId: "turn-refused" });
    await run(t, async (path) => t.fetch(path, { headers: { cookie, origin: "http://localhost", host: "localhost" } }));
  } finally { await t.close(); }
}

const ids = async (response: Response) => {
  expect(response.status).toBe(200);
  const body = await response.json() as { events: Array<{ sessionId: string | null; turnId: string | null; kind: string }>; nextAfter: number | null };
  return { events: body.events.map((e) => `${e.sessionId}/${e.turnId}/${e.kind}`), nextAfter: body.nextAfter };
};

test("governance events reject unauthenticated requests", async () => {
  await withApp(async (t) => {
    for (const init of [undefined, { headers: { cookie: "brain_ui_session=forged.value" } }]) {
      const response = await t.fetch("/api/governance/events?session=sess-ithaca", init);
      expect(response.status).toBe(401);
      expect(JSON.stringify(await response.json())).not.toContain("sirens");
    }
  });
});

test("governance events filter by session, turn and kind, and page in id order", async () => {
  await withApp(async (_, get) => {
    const all = await ids(await get("/api/governance/events"));
    expect(all).toEqual({ events: ["sess-ithaca/turn-1/taint", "sess-ithaca/turn-1/strict_fallback", "sess-ithaca/turn-2/strict_fallback", "sess-troy/turn-troy/taint", "null/turn-refused/taint"], nextAfter: null });
    expect((await ids(await get("/api/governance/events?session=sess-ithaca"))).events).toEqual(all.events.slice(0, 3));
    expect((await ids(await get("/api/governance/events?turn=turn-1"))).events).toEqual(all.events.slice(0, 2));
    expect((await ids(await get("/api/governance/events?kind=taint"))).events).toEqual([all.events[0], all.events[3], all.events[4]]);
    expect((await ids(await get("/api/governance/events?session=sess-ithaca&kind=strict_fallback&turn=turn-2"))).events).toEqual([all.events[2]]);
    expect((await ids(await get("/api/governance/events?kind=taint,strict_fallback&kind=taint&session=sess-troy"))).events).toEqual([all.events[3]]);
    expect((await ids(await get("/api/governance/events?session=sess-unknown"))).events).toEqual([]);

    const first = await get("/api/governance/events?limit=2");
    expect(first.headers.get("cache-control")).toBe("no-store");
    const page = await first.json() as { events: Array<{ id: number }>; nextAfter: number };
    expect(page.events).toHaveLength(2);
    expect(page.nextAfter).toBe(page.events[1]!.id);
    expect(await ids(await get(`/api/governance/events?limit=2&after=${page.nextAfter}`))).toMatchObject({ events: all.events.slice(2, 4) });
    expect((await ids(await get("/api/governance/events?limit=5"))).nextAfter).not.toBeNull();
    expect((await ids(await get("/api/governance/events?limit=6"))).nextAfter).toBeNull();

    const [event] = (await (await get("/api/governance/events?turn=turn-2")).json()).events;
    expect(event).toEqual({ id: expect.any(Number), sessionId: "sess-ithaca", turnId: "turn-2", at: 1_800_000_000_000, kind: "strict_fallback", schemaVersion: 1, actor: "interactive", model: "claude-opus-5", profile: "governed", payload: { path: ".claude/settings.json", reason: "symlink" } });
  });
});

test("governance events refuse malformed parameters", async () => {
  await withApp(async (_, get) => {
    for (const query of ["kind=cyclops", "kind=", "kind=taint,", "limit=0", "limit=501", "limit=ten", "limit=1.5", "after=-1", "after=x",
      "session=", "session=a&session=b", "turn=", `turn=${"t".repeat(201)}`]) {
      const response = await get(`/api/governance/events?${query}`);
      expect({ query, status: response.status }).toEqual({ query, status: 400 });
      expect((await response.json()).error).toBeString();
    }
  });
});

test("a governance event storage failure is a 500", async () => {
  await withApp(async (t, get) => {
    t.app.db.exec("DROP TABLE governance_events");
    const response = await get("/api/governance/events");
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBeString();
  });
});
