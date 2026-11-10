// #3616: which registered live service a Start opens. Two keyless adapter
// doubles stand in for the two existing adapters; every assertion names the
// double whose `open` ran, or that neither did.
import { afterEach, describe, expect, test } from "bun:test";
import type { LiveConversationProvider } from "@schlessera/brain-ui-sdk/server";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createUiDb } from "../src/db/client";
import type { WSContext } from "../src/ws/clients";
import { createWsHandlers } from "../src/ws/connection";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { createLiveProviderRegistry } from "../src/voice/live-providers";
import { makeFakeBackend } from "./helpers/fake-backend";
import { fakeLiveProvider, type FakeLiveSession } from "./helpers/live-conversation";
import { testPrincipal } from "./helpers/principal";
import { httpContractApp } from "./helpers/http-contract-app";
import { createPrincipal } from "../src/db/principals";
import { getLiveDefaultProvider, getSetting } from "../src/db/settings";
import { isLiveSettingsWriter } from "../src/routes/live-settings";
import { generateSignedCookie } from "hono/cookie";
import { Database } from "bun:sqlite";
import { resolveAmbientPrincipal } from "../src/db/principals";

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A fake adapter under its own id and disclosure; `sessions` records every `open`. */
function double(id: string, voiceService: string): { provider: LiveConversationProvider; sessions: FakeLiveSession[] } {
  const fake = fakeLiveProvider();
  return { provider: { ...fake.provider, id, disclosure: { ...fake.provider.disclosure, voiceService } }, sessions: fake.sessions };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { await cleanup?.(); cleanup = null; });

function setup(options: { ids: ("gemini" | "gpt")[]; host?: string; saved?: string | null; legacy?: boolean }) {
  const gemini = double("gemini-live", "Fictional Gemini Live of Ithaca");
  const gpt = double("gpt-live", "Fictional GPT-Live of Ithaca");
  const pick = { gemini, gpt };
  const providers = options.ids.map((id) => pick[id].provider);
  const db = createUiDb(":memory:");
  let saved = options.saved ?? null;
  const backend = makeFakeBackend({ id: "fake" });
  const host = new WsHost({
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog: createSessionCatalog(() => db),
    ...(options.legacy ? { conversationProvider: providers[0]! } : { conversationProviders: providers }),
    ...(options.host ? { defaultConversationProviderId: options.host } : {}),
    liveDefaultProvider: () => saved,
  });
  cleanup = async () => { await host.close(); db.close(); };
  const opened = () => ({ gemini: gemini.sessions.length, gpt: gpt.sessions.length });
  async function connect() {
    const handlers = createWsHandlers(host, testPrincipal());
    const sent: string[] = [];
    const ws = { send: (data: string) => sent.push(data) } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    const frames = (type?: string): any[] => sent.map((s) => JSON.parse(s)).filter((f) => type === undefined || f.type === type);
    const hello = frames("server_hello")[0];
    /** Start and wait for its answer: the opened frame, or the refusal. */
    async function start(frame: Record<string, unknown>) {
      const requestId = crypto.randomUUID();
      const before = sent.length;
      await handlers.onMessage({ data: JSON.stringify({ type: "conversation_start", contextualTasks: true, requestId, ...frame }) } as MessageEvent, ws);
      await until(() => sent.slice(before).some((s) => { const f = JSON.parse(s); return f.requestId === requestId && (f.type === "conversation_opened" || f.type === "error" || f.type === "conversation_closed"); }));
      return sent.slice(before).map((s) => JSON.parse(s)).find((f) => f.requestId === requestId);
    }
    return { hello, frames, start, sent };
  }
  return { host, gemini, gpt, opened, connect, setSaved: (id: string | null) => { saved = id; } };
}

const profileOf = (s: ReturnType<typeof setup>, id: string) => s.host.conversations!.profile(true, id)!;

describe("registration", () => {
  const a = double("gemini-live", "A"), b = double("gpt-live", "B");
  test("startup fails on both options, duplicate ids or an unregistered host default", () => {
    expect(() => createLiveProviderRegistry({ conversationProvider: a.provider, conversationProviders: [b.provider] })).toThrow("not both");
    expect(() => createLiveProviderRegistry({ conversationProviders: [a.provider, { ...b.provider, id: "gemini-live" }] })).toThrow('Duplicate live conversation provider id "gemini-live"');
    expect(() => createLiveProviderRegistry({ conversationProviders: [a.provider], defaultConversationProviderId: "gpt-live" })).toThrow("not a registered");
    expect(() => createLiveProviderRegistry({ defaultConversationProviderId: "gpt-live" })).toThrow("not a registered");
    expect(() => createLiveProviderRegistry({ conversationProviders: [{ ...a.provider, id: "Gemini" }] })).toThrow("lowercase");
  });
  test("the legacy option means a list of one and is accepted alone", () => {
    expect(createLiveProviderRegistry({ conversationProvider: a.provider }).providers.map((p) => p.id)).toEqual(["gemini-live"]);
    expect(createLiveProviderRegistry({}).providers).toEqual([]);
  });
});

// §4 of the design: every row, the hello a client sees and which double a
// Start without a pick opens. `effective: null` means no double opens.
const rows: { name: string; ids: ("gemini" | "gpt")[]; saved: string | null; host?: string; effective: string | null; source: string; legacy?: boolean }[] = [
  { name: "one, nothing saved, legacy option", ids: ["gemini"], saved: null, effective: "gemini-live", source: "only", legacy: true },
  { name: "one, nothing saved, host default", ids: ["gpt"], saved: null, host: "gpt-live", effective: "gpt-live", source: "host" },
  { name: "one, saved that one", ids: ["gemini"], saved: "gemini-live", effective: "gemini-live", source: "saved" },
  { name: "one, saved removed", ids: ["gemini"], saved: "gpt-live", effective: null, source: "none" },
  { name: "two, nothing saved, host default", ids: ["gemini", "gpt"], saved: null, host: "gpt-live", effective: "gpt-live", source: "host" },
  { name: "two, nothing saved, no host default", ids: ["gemini", "gpt"], saved: null, effective: null, source: "none" },
  { name: "two, saved usable over the host default", ids: ["gemini", "gpt"], saved: "gemini-live", host: "gpt-live", effective: "gemini-live", source: "saved" },
  { name: "two, saved unusable, host default not substituted", ids: ["gemini", "gpt"], saved: "retired-live", host: "gpt-live", effective: null, source: "none" },
];

describe("compatibility table", () => {
  for (const row of rows) test(row.name, async () => {
    const s = setup({ ids: row.ids, host: row.host, saved: row.saved, legacy: row.legacy });
    const client = await s.connect();
    const ids: string[] = row.ids.map((id) => id === "gemini" ? "gemini-live" : "gpt-live");
    expect(client.hello.capabilities.liveConversation).toBe(true);
    expect(client.hello.conversationProfiles.map((p: { providerId: string }) => p.providerId)).toEqual(ids);
    expect(client.hello.liveDefault).toEqual({ saved: row.saved, savedUsable: row.saved !== null && ids.includes(row.saved), effective: row.effective, source: row.source });
    // The legacy field is the effective profile, and absent without one (R1).
    if (row.effective) expect(client.hello.conversationProfile).toEqual(profileOf(s, row.effective));
    else expect("conversationProfile" in client.hello).toBe(false);
    // An SDK client parses the additive hello whole.
    const parsed = parseServerMessage(JSON.stringify(client.hello));
    expect(parsed.ok && parsed.message.type === "server_hello" && parsed.message.liveDefault).toEqual(client.hello.liveDefault);
    expect(s.opened(), "discovery opens no provider").toEqual({ gemini: 0, gpt: 0 });

    // A legacy Start (no providerId) echoes the hello's profile. Without an
    // effective service, even a crafted echo of the host default or the only
    // registered profile opens nothing.
    const legacy = await client.start({ disclosed: client.hello.conversationProfile ?? profileOf(s, row.host ?? ids[0]!) });
    if (row.effective) {
      expect(legacy.type).toBe("conversation_opened");
      expect(legacy.providerId).toBe(row.effective);
      expect(legacy.providerSource).toBe(row.source);
      expect(s.opened()).toEqual({ gemini: row.effective === "gemini-live" ? 1 : 0, gpt: row.effective === "gpt-live" ? 1 : 0 });
    } else {
      expect(legacy).toMatchObject({ type: "error", code: "CONVERSATION_DISCLOSURE" });
      expect(s.opened(), "no effective service opens nothing, not the host default").toEqual({ gemini: 0, gpt: 0 });
    }
  });
});

describe("explicit pick", () => {
  test("Change opens the picked service for this Start only and writes nothing", async () => {
    const s = setup({ ids: ["gemini", "gpt"], saved: "gemini-live" });
    const client = await s.connect();
    const opened = await client.start({ providerId: "gpt-live", disclosed: profileOf(s, "gpt-live") });
    expect(opened).toMatchObject({ type: "conversation_opened", providerId: "gpt-live", providerSource: "change" });
    expect(s.opened()).toEqual({ gemini: 0, gpt: 1 });
    expect(s.host.conversations!.liveDefault()).toEqual({ saved: "gemini-live", savedUsable: true, effective: "gemini-live", source: "saved" });
  });

  test("an unusable saved default needs an explicit pick, which then opens", async () => {
    const s = setup({ ids: ["gemini", "gpt"], saved: "retired-live", host: "gemini-live" });
    const client = await s.connect();
    expect(await client.start({ disclosed: profileOf(s, "gemini-live") })).toMatchObject({ type: "error", code: "CONVERSATION_DISCLOSURE" });
    expect(s.opened(), "the host default is never substituted").toEqual({ gemini: 0, gpt: 0 });
    expect(await client.start({ providerId: "gpt-live", disclosed: profileOf(s, "gpt-live") })).toMatchObject({ type: "conversation_opened", providerId: "gpt-live" });
    expect(s.opened()).toEqual({ gemini: 0, gpt: 1 });
  });

  test("a providerId that differs from the disclosed profile, or is unregistered, opens nothing", async () => {
    const s = setup({ ids: ["gemini", "gpt"], host: "gemini-live" });
    const client = await s.connect();
    expect(await client.start({ providerId: "gpt-live", disclosed: profileOf(s, "gemini-live") })).toMatchObject({ type: "error", code: "CONVERSATION_DISCLOSURE" });
    expect(await client.start({ providerId: "retired-live", disclosed: { ...profileOf(s, "gemini-live"), providerId: "retired-live" } })).toMatchObject({ type: "error", code: "CONVERSATION_DISCLOSURE" });
    expect(s.opened()).toEqual({ gemini: 0, gpt: 0 });
  });
});

describe("activation", () => {
  test("a saved default applies at the next Start; a running conversation and its resume keep their service", async () => {
    const s = setup({ ids: ["gemini", "gpt"], saved: "gemini-live" });
    const client = await s.connect();
    const first = await client.start({ disclosed: client.hello.conversationProfile });
    expect(first).toMatchObject({ type: "conversation_opened", providerId: "gemini-live", providerSource: "saved" });
    s.setSaved("gpt-live");
    s.host.conversations!.broadcastSettings();
    const update = client.frames("live_settings").at(-1);
    expect(update.liveDefault).toEqual({ saved: "gpt-live", savedUsable: true, effective: "gpt-live", source: "saved" });
    expect(parseServerMessage(JSON.stringify(update)).ok).toBe(true);
    expect(s.gemini.sessions[0]!.closed, "a save never closes or retargets the running conversation").toBe(false);
    expect(s.opened()).toEqual({ gemini: 1, gpt: 0 });
    // Reconnect of the same conversation keeps gemini, with or without providerId.
    const resumed = await client.start({ conversationId: first.conversationId, disclosed: profileOf(s, "gemini-live") });
    expect(resumed).toMatchObject({ type: "conversation_opened", providerId: "gemini-live", conversationId: first.conversationId, epoch: 2 });
    expect(await client.start({ conversationId: first.conversationId, providerId: "gpt-live", disclosed: profileOf(s, "gpt-live") }))
      .toMatchObject({ type: "error", code: "CONVERSATION_DISCLOSURE" });
    expect(s.opened()).toEqual({ gemini: 2, gpt: 0 });
    // A new connection's next explicit Start uses the new default.
    const other = await s.connect();
    expect(other.hello.conversationProfile.providerId).toBe("gpt-live");
    expect(await other.start({ disclosed: other.hello.conversationProfile })).toMatchObject({ type: "conversation_opened", providerId: "gpt-live", providerSource: "saved" });
    expect(s.opened()).toEqual({ gemini: 2, gpt: 1 });
  });

  test("a default changed between disclosure and Start refuses a legacy Start", async () => {
    const s = setup({ ids: ["gemini", "gpt"], saved: "gemini-live" });
    const client = await s.connect();
    const disclosed = client.hello.conversationProfile;
    s.setSaved("gpt-live");
    expect(await client.start({ disclosed })).toMatchObject({ type: "error", code: "CONVERSATION_DISCLOSURE" });
    expect(s.opened()).toEqual({ gemini: 0, gpt: 0 });
  });
});

describe("Settings › Voice live default route", () => {
  const secret = "odysseus-live-settings-cookie-secret";
  const path = "/api/settings/voice";
  async function app() {
    const gemini = double("gemini-live", "Fictional Gemini Live of Ithaca");
    const gpt = double("gpt-live", "Fictional GPT-Live of Ithaca");
    const t = await httpContractApp({
      env: { AUTH_MODE: "password", COOKIE_SECRET: secret, BRAIN_UI_PASSWORD_HASH: "fixture" },
      live: { conversationProviders: [gemini.provider, gpt.provider], defaultConversationProviderId: "gemini-live" },
    });
    const cookie = async (id: string) => ({ cookie: (await generateSignedCookie("brain_ui_session", id, secret)).split(";")[0]! });
    return { t, gemini, gpt, cookie };
  }
  const put = (body: unknown, headers: Record<string, string>) => ({ method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("owner-only writes, revisions, unknown ids and persistence across a restart", async () => {
    const { t, gemini, gpt, cookie } = await app();
    try {
      const owner = createPrincipal(t.app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
      const agent = createPrincipal(t.app.db, { authMethod: "delegated", label: "Eurylochus", createdBy: owner.id, ttlSeconds: 3600 });
      const ownerHeaders = await cookie(owner.id);
      const agentHeaders = await cookie(agent.id);
      expect((await t.fetch(path)).status).toBe(401);
      const initial = await t.fetch(path, { headers: ownerHeaders });
      expect(initial.headers.get("cache-control")).toBe("no-store");
      expect(await initial.json()).toEqual({ defaultProvider: null, revision: 0 });

      // The guard refuses a delegated principal with an empty body, before validation.
      for (const body of [{ defaultProvider: "gpt-live", revision: 0 }, { nonsense: true }]) {
        const refused = await t.fetch(path, put(body, agentHeaders));
        expect(refused.status, "LIVE_SETTINGS_OWNER_ONLY").toBe(403);
        expect(await refused.text()).toBe("");
      }
      expect((await t.fetch(path, { headers: agentHeaders })).status, "an agent principal does not read it either").toBe(403);
      expect(getLiveDefaultProvider(t.app.db)).toEqual({ defaultProvider: null, revision: 0 });

      expect((await t.fetch(path, { ...put({ defaultProvider: "gpt-live", revision: 0 }, ownerHeaders), headers: { ...ownerHeaders, "content-type": "text/plain" } })).status).toBe(415);
      const invalid = await t.fetch(path, put({ defaultProvider: "gpt-live" }, ownerHeaders));
      expect(invalid.status).toBe(400); expect((await invalid.json()).error).toBe("LIVE_SETTINGS_INVALID");
      const unknown = await t.fetch(path, put({ defaultProvider: "retired-live", revision: 0 }, ownerHeaders));
      expect(unknown.status).toBe(400);
      const unknownBody = await unknown.text();
      expect(JSON.parse(unknownBody).error).toBe("LIVE_PROVIDER_UNKNOWN");

      const concurrent = await Promise.all([t.fetch(path, put({ defaultProvider: "gpt-live", revision: 0 }, ownerHeaders)), t.fetch(path, put({ defaultProvider: "gemini-live", revision: 0 }, ownerHeaders))]);
      expect(concurrent.map((r) => r.status).sort()).toEqual([200, 409]);
      const current = await concurrent.find((r) => r.status === 200)!.json();
      expect(current.revision).toBe(1);
      expect(await concurrent.find((r) => r.status === 409)!.json()).toEqual({ error: "LIVE_SETTINGS_CHANGED", message: "Changed on another device.", current });
      const saved = await (await t.fetch(path, put({ defaultProvider: "gpt-live", revision: 1 }, ownerHeaders))).json();
      expect(saved).toEqual({ defaultProvider: "gpt-live", revision: 2 });
      expect(gemini.sessions.length + gpt.sessions.length, "a save opens no provider").toBe(0);
      // Nothing secret: no credential, key presence or endpoint in any answer.
      expect(JSON.stringify([current, saved, unknownBody])).not.toMatch(/key|token|wss?:|https?:/i);

      // The ordinary model default is independent.
      expect(getSetting(t.app.db, "models.default", null)).toBe(null);

      // Persisted server state: another connection to the database file reads
      // it, and a host started over it without that service keeps the saved
      // id, unusable, with no host-default substitution.
      const reader = new Database(t.app.config.dbPath);
      let later: WsHost | undefined;
      try {
        expect(getLiveDefaultProvider(reader)).toEqual({ defaultProvider: "gpt-live", revision: 2 });
        later = new WsHost({ registry: createStaticBackendRegistry([makeFakeBackend({ id: "fake" })], "fake"), catalog: createSessionCatalog(() => reader),
          conversationProviders: [gemini.provider], defaultConversationProviderId: "gemini-live", liveDefaultProvider: () => getLiveDefaultProvider(reader).defaultProvider });
        expect(later.conversations!.liveDefault()).toEqual({ saved: "gpt-live", savedUsable: false, effective: null, source: "none" });
      } finally { await later?.close(); reader.close(); }
    } finally {
      await t.close();
    }
  });

  test("an ambient human may write; a save tells every open connection without retargeting", async () => {
    const gemini = double("gemini-live", "Fictional Gemini Live of Ithaca");
    const gpt = double("gpt-live", "Fictional GPT-Live of Ithaca");
    const t = await httpContractApp({ live: { conversationProviders: [gemini.provider, gpt.provider] } });
    try {
      const sent: string[] = [];
      const ws = { send: (data: string) => sent.push(data), close: () => {}, readyState: 1 } as unknown as WSContext;
      const handlers = createWsHandlers(t.app.wsHost, resolveAmbientPrincipal(t.app.db, "none", "No authentication", "No authentication"));
      await handlers.onOpen(undefined as never, ws);
      expect(JSON.parse(sent[0]!).liveDefault).toEqual({ saved: null, savedUsable: false, effective: null, source: "none" });
      const saved = await t.fetch(path, put({ defaultProvider: "gpt-live", revision: 0 }, {}));
      expect(saved.status).toBe(200);
      const update = sent.map((s) => JSON.parse(s)).find((f) => f.type === "live_settings");
      expect(update).toEqual({ type: "live_settings", liveDefault: { saved: "gpt-live", savedUsable: true, effective: "gpt-live", source: "saved" },
        conversationProfiles: t.app.wsHost.conversations!.profiles() });
      expect(gemini.sessions.length + gpt.sessions.length).toBe(0);
      await handlers.onClose({ code: 1000 } as CloseEvent, ws);
    } finally { await t.close(); }
  });
});

test("the write guard: owner human sessions and the ambient human only", () => {
  const base = testPrincipal();
  expect(isLiveSettingsWriter(base, 0)).toBe(true);
  expect(isLiveSettingsWriter({ ...base, authMethod: "passkey" }, 0)).toBe(true);
  expect(isLiveSettingsWriter({ ...base, kind: "ambient", authMethod: "ambient" }, 0)).toBe(true);
  expect(isLiveSettingsWriter({ ...base, kind: "agent", authMethod: "delegated" }, 0)).toBe(false);
  expect(isLiveSettingsWriter({ ...base, kind: "owner", authMethod: "delegated" }, 0)).toBe(false);
  expect(isLiveSettingsWriter({ ...base, kind: "system", authMethod: "ambient" }, 0)).toBe(false);
  expect(isLiveSettingsWriter({ ...base, revokedAt: 1 }, 2)).toBe(false);
  expect(isLiveSettingsWriter(undefined, 0)).toBe(false);
});
