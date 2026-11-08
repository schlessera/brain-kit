import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { SpeechProvider } from "@schlessera/brain-ui-sdk/server";
import { SpeechTranscriptionError } from "@schlessera/brain-ui-sdk/server";
import { httpContractApp, type HttpContractApp } from "./helpers/http-contract-app";
import { createSettingsWrites } from "../src/db/settings-writes";
import { getDictationSettings } from "../src/db/settings";
import { generateSignedCookie } from "hono/cookie";
import { createPrincipal } from "../src/db/principals";
import { Database } from "bun:sqlite";

function doubles() {
  const calls = { alpha: [] as unknown[], beta: [] as unknown[], audio: [] as Uint8Array[] };
  const alpha: SpeechProvider = { id: "alpha", label: "Ithaca dictation", destination: "Audio goes to the Ithaca fixture.",
    capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: true },
    async createSession(options) { calls.alpha.push(options); return { url: "", expiresAt: 0 }; },
    async transcribeRecording({ audio }) { calls.audio.push(audio); return { text: "Odysseus reaches Ithaca." }; },
  };
  const beta: SpeechProvider = { id: "beta", capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: false, smartTranscription: true },
    async createSession(options) { calls.beta.push(options); return { url: "", expiresAt: 0 }; },
  };
  return { alpha, beta, calls };
}
const settingsPath = "/api/voice/dictation/settings";
const audio = new Uint8Array([1, 2, 3]);
const path = (id: string) => `/api/voice/recordings/${id}/transcription`;
const upload = (provider?: string): RequestInit => ({ method: "PUT", body: audio,
  headers: { "Content-Type": "audio/webm", "Content-SHA256": createHash("sha256").update(audio).digest("hex"), ...(provider !== undefined ? { "Speech-Provider": provider } : {}) } });
const mint = (providerId?: string, smart?: boolean): RequestInit => ({ method: "POST", ...(providerId !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId, smart }) } : {}) });
const save = (t: HttpContractApp, defaultProvider: string | null, revision = "0", smart = true, headers = {}) => t.fetch(settingsPath, {
  method: "PUT", headers: { "Content-Type": "application/json", "If-Match": `"${revision}"`, ...headers }, body: JSON.stringify({ defaultProvider, smart }),
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

// The plan's Deepgram/Gemini rows use the same alpha/beta executors by value.
for (const row of [
  { name: "zero", ids: [], saved: null, host: undefined, effective: null, source: "none" },
  { name: "zero with saved", ids: [], saved: "removed", host: undefined, effective: null, source: "unavailable" },
  { name: "one with host", ids: ["alpha"], saved: null, host: "alpha", effective: "alpha", source: "host" },
  { name: "one without host", ids: ["beta"], saved: null, host: undefined, effective: "beta", source: "only" },
  { name: "two with host", ids: ["alpha", "beta"], saved: null, host: "alpha", effective: "alpha", source: "host" },
  { name: "saved overrides host", ids: ["alpha", "beta"], saved: "beta", host: "alpha", effective: "beta", source: "saved" },
  { name: "removed blocks host", ids: ["alpha", "beta"], saved: "removed", host: "alpha", effective: null, source: "unavailable" },
  { name: "two require choice", ids: ["alpha", "beta"], saved: null, host: undefined, effective: null, source: "none" },
  { name: "legacy supplied", ids: ["alpha"], saved: "alpha", host: "alpha", effective: "alpha", source: "saved", legacy: true },
]) test(`selection matrix: ${row.name}; legacy bodyless session and upload use the effective provider`, async () => {
  const { alpha, beta, calls } = doubles();
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "" }, defaultSpeechProviderId: row.host,
    ...("legacy" in row ? { speechProvider: alpha } : { speechProviders: row.ids.map(id => id === "alpha" ? alpha : beta) }) });
  try {
    if (row.saved) {
      // Model persisted settings from another startup, including a removed id.
      const writer = new Database(t.app.config.dbPath);
      try { await createSettingsWrites(writer).setSetting("voice.dictation", { defaultProvider: row.saved, smart: false, revision: 3 }); }
      finally { writer.close(); }
    }
    const discovery = await t.fetch("/api/voice/providers");
    expect(discovery.status).toBe(200); expect(discovery.headers.get("cache-control")).toBe("no-store");
    const body = await discovery.json();
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(row.ids);
    expect(body.dictation).toEqual({ saved: row.saved, savedUsable: row.saved !== null && row.ids.some(id => id === row.saved), host: row.host ?? null,
      effective: row.effective, source: row.source, smart: !row.saved, revision: row.saved ? "3" : "0" });
    expect(calls).toEqual({ alpha: [], beta: [], audio: [] });
    const capabilities = await t.fetch("/api/voice/capabilities");
    const session = await t.fetch("/api/voice/session", mint());
    expect(session.status).toBe(row.effective ? 200 : 500);
    expect(capabilities.status).toBe(session.status);
    if (row.effective) {
      const expected = row.effective === "alpha" ? alpha : beta;
      expect(await capabilities.text()).toBe(JSON.stringify({ providerId: expected.id, capabilities: { ...expected.capabilities, savedAudio: expected.id === "alpha" } }));
      expect(await session.text()).toBe(JSON.stringify({ providerId: expected.id, url: "", expiresAt: 0, capabilities: { ...expected.capabilities, savedAudio: expected.id === "alpha" } }));
    }
    expect(calls.alpha).toEqual(row.effective === "alpha" ? [{ keyterms: [] }] : []);
    expect(calls.beta).toEqual(row.effective === "beta" ? [{ keyterms: [], mode: row.saved ? "verbatim" : "smart" }] : []);
    const result = await t.fetch(path(randomUUID()), upload());
    expect(result.status).toBe(row.effective === "alpha" ? 200 : row.effective === "beta" ? 501 : 500);
    expect(calls.audio).toEqual(row.effective === "alpha" ? [audio] : []);
  } finally { await t.close(); }
});

test("held mint keeps the requested provider across a default save", async () => {
  const { alpha, beta, calls } = doubles(); const entered = gate(), held = gate();
  const original = beta.createSession;
  beta.createSession = async opts => { const result = await original(opts); entered.release(); await held.promise; return result; };
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "" }, speechProviders: [alpha, beta], defaultSpeechProviderId: "alpha" });
  let pending: Promise<Response> | undefined;
  try {
    pending = Promise.resolve(t.fetch("/api/voice/session", mint("beta", false)));
    // Race-safe even under the mutation: a wrong provider resolves immediately.
    await Promise.race([entered.promise, pending]);
    expect(calls.beta, "the disclosed beta provider must mint, even while alpha is the default").toEqual([{ keyterms: [], mode: "verbatim" }]);
    expect((await save(t, "beta")).status).toBe(200);
    expect((await save(t, "alpha", "1")).status).toBe(200);
    held.release(); const result = await (await pending).json();
    expect(result.providerId).toBe("beta"); expect(result.capabilities.smartTranscription).toBe(true);
    expect(calls.alpha).toEqual([]); expect(calls.audio).toEqual([]);
  } finally { held.release(); await pending; await t.close(); }
});

test("held upload keeps the header provider across a default save", async () => {
  const { alpha, beta, calls } = doubles(); const entered = gate(), held = gate();
  const original = alpha.transcribeRecording!;
  alpha.transcribeRecording = async opts => { const result = await original(opts); entered.release(); await held.promise; return result; };
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "" }, speechProviders: [alpha, beta], defaultSpeechProviderId: "beta" });
  let pending: Promise<Response> | undefined;
  try {
    const id = randomUUID(); pending = Promise.resolve(t.fetch(path(id), upload("alpha")));
    await Promise.race([entered.promise, pending]);
    expect(calls.audio, "the disclosed alpha provider must receive the audio despite the streaming-only default").toEqual([audio]);
    expect((await save(t, "alpha")).status).toBe(200);
    expect((await save(t, "beta", "1")).status).toBe(200);
    held.release(); const receipt = await (await pending).json();
    expect(receipt.providerId).toBe("alpha"); expect(receipt.status).toBe("done");
    expect(await (await t.fetch(path(id), upload("alpha"))).json()).toEqual(receipt);
    expect(calls.audio).toHaveLength(1); expect(calls.alpha).toEqual([]); expect(calls.beta).toEqual([]);
  } finally { held.release(); await pending; await t.close(); }
});

test("upload admission freezes the header before the request body finishes", async () => {
  const { alpha, beta, calls } = doubles(); const reading = gate(); let finish!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(audio); finish = () => { finish = () => {}; c.close(); }; }, pull() { reading.release(); } }, { highWaterMark: 0 });
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "" }, speechProviders: [alpha, beta], defaultSpeechProviderId: "alpha" });
  let pending: Promise<Response> | undefined;
  try {
    pending = Promise.resolve(t.fetch(path(randomUUID()), { ...upload("alpha"), body, duplex: "half" } as RequestInit));
    await reading.promise;
    expect((await save(t, "beta")).status).toBe(200);
    finish(); const result = await (await pending).json();
    expect(result.providerId).toBe("alpha"); expect(calls.audio).toEqual([audio]); expect(calls.beta).toEqual([]);
  } finally { finish(); await pending; await t.close(); }
});

test("exact selections refuse unknown providers and streaming-only uploads before claims; failures never fall back", async () => {
  const { alpha, beta, calls } = doubles();
  beta.createSession = async options => { calls.beta.push(options); throw new Error("fixture-secret-not-for-client"); };
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "" }, speechProviders: [alpha, beta], defaultSpeechProviderId: "alpha" });
  try {
    for (const id of ["removed", ""]) {
      const response = await t.fetch("/api/voice/session", mint(id));
      expect(response.status).toBe(409); expect((await response.json()).error).toBe("speech_provider_unavailable");
    }
    for (const provider of ["removed", "beta"]) {
      const id = randomUUID(), response = await t.fetch(path(id), upload(provider));
      expect(response.status).toBe(provider === "beta" ? 501 : 409);
      expect((await t.fetch(path(id))).status).toBe(404);
    }
    const failure = await t.fetch("/api/voice/session", mint("beta"));
    expect(failure.status).toBe(500); expect(await failure.text()).not.toContain("fixture-secret");
    expect(calls.beta).toEqual([{ keyterms: [], mode: "smart" }]); expect(calls.alpha).toEqual([]); expect(calls.audio).toEqual([]);
  } finally { await t.close(); }
});

test("retry cannot change the provider of a durable receipt", async () => {
  const { alpha, beta, calls } = doubles(); let otherCalls = 0;
  alpha.transcribeRecording = async ({ audio }) => { calls.audio.push(audio); throw new SpeechTranscriptionError("provider_error", 503); };
  // A second saved-audio implementation is needed to reach the receipt check.
  const other: SpeechProvider = { ...alpha, id: "other", async transcribeRecording() { otherCalls++; return { text: "Ithaca" }; } };
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "" }, speechProviders: [alpha, beta, other], defaultSpeechProviderId: "alpha" });
  try {
    const id = randomUUID(), receipt = await (await t.fetch(path(id), upload("alpha"))).json();
    expect(receipt.status).toBe("failed");
    expect((await save(t, "other")).status).toBe(200);
    const response = await t.fetch(`${path(id)}?retry=${receipt.attemptId}`, upload("other"));
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "transcription_provider_mismatch", message: "Retry with the original transcription service.", receipt });
    expect(calls.audio).toHaveLength(1); expect(otherCalls).toBe(0); expect(calls.beta).toEqual([]);
    expect((await t.fetch(`${path(id)}?retry=${receipt.attemptId}`, upload("alpha"))).status).toBe(200);
    expect(calls.audio).toHaveLength(2);
  } finally { await t.close(); }
});

test("settings enforce owner authority and atomic revisions without minting", async () => {
  const { alpha, beta, calls } = doubles(); const secret = "odysseus-dictation-cookie-secret";
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "", AUTH_MODE: "password", COOKIE_SECRET: secret, BRAIN_UI_PASSWORD_HASH: "fixture" }, speechProviders: [alpha, beta] });
  try {
    const owner = createPrincipal(t.app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
    const agent = createPrincipal(t.app.db, { authMethod: "delegated", label: "Eurylochus", createdBy: owner.id, ttlSeconds: 3600 });
    const cookie = async (id: string) => ({ cookie: (await generateSignedCookie("brain_ui_session", id, secret)).split(";")[0]! });
    const ownerHeaders = await cookie(owner.id);
    expect((await t.fetch(settingsPath)).status).toBe(401);
    expect((await t.fetch("/api/voice/providers")).status).toBe(401);
    expect((await save(t, "alpha", "0", true, await cookie(agent.id))).status).toBe(403);
    const initial = await t.fetch(settingsPath, { headers: ownerHeaders });
    expect(await initial.json()).toEqual({ defaultProvider: null, smart: true, revision: "0" });
    expect(initial.headers.get("etag")).toBe('"0"');
    expect((await t.fetch(settingsPath, { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ defaultProvider: "alpha" }) })).status).toBe(428);
    const unknown = await save(t, "removed", "0", true, ownerHeaders);
    expect(unknown.status).toBe(400); expect((await unknown.json()).error).toBe("speech_provider_unknown");
    const concurrent = await Promise.all([save(t, "alpha", "0", false, ownerHeaders), save(t, "beta", "0", false, ownerHeaders)]);
    expect(concurrent.map(r => r.status).sort()).toEqual([200, 409]);
    const current = await concurrent.find(r => r.status === 200)!.json();
    expect(current.revision).toBe("1"); expect(current.smart).toBe(false);
    expect(await concurrent.find(r => r.status === 409)!.json()).toEqual({ error: "dictation_settings_stale", message: "Changed on another device.", current });
    expect((await save(t, null, "1", true, ownerHeaders)).status).toBe(200);
    expect(getDictationSettings(t.app.db)).toEqual({ defaultProvider: null, smart: true, revision: "2" });
    const reader = new Database(t.app.config.dbPath);
    try { expect(getDictationSettings(reader)).toEqual(getDictationSettings(t.app.db)); } finally { reader.close(); }
    expect(calls).toEqual({ alpha: [], beta: [], audio: [] });
  } finally { await t.close(); }
});

test("invalid settings are total and malformed requests do not change them", async () => {
  const { alpha, beta, calls } = doubles();
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "" }, speechProviders: [alpha, beta] });
  const writer = new Database(t.app.config.dbPath);
  try {
    for (const value of ["{", "null", "[]", '{"defaultProvider":"alpha","smart":true,"revision":-1}', '{"defaultProvider":"alpha","smart":"yes","revision":1}']) {
      writer.query("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('voice.dictation', ?, 0)").run(value);
      expect(await (await t.fetch(settingsPath)).json()).toEqual({ defaultProvider: null, smart: true, revision: "0" });
    }
    for (const body of ["{", "null", "[]", '{}', '{"defaultProvider":"alpha","smart":1}']) {
      expect((await t.fetch(settingsPath, { method: "PUT", headers: { "If-Match": '"0"' }, body })).status).toBe(400);
    }
    for (const body of ["{", "null", "[]", '{"providerId":42}', '{"smart":1}']) {
      expect((await t.fetch("/api/voice/session", { method: "POST", headers: { "Content-Type": "application/json" }, body })).status).toBe(400);
    }
    expect(calls).toEqual({ alpha: [], beta: [], audio: [] });
  } finally { writer.close(); await t.close(); }
});

test("registration validates duplicate ids, mutually exclusive options and unregistered defaults at construction", async () => {
  const { alpha, beta } = doubles();
  for (const options of [{ speechProviders: [alpha, alpha] }, { speechProvider: alpha, speechProviders: [beta] },
    { speechProviders: [alpha], defaultSpeechProviderId: "removed" }, { speechProviders: [{ ...alpha, id: " Alpha " }] },
    { speechProviders: [{ ...alpha, capabilities: { ...alpha.capabilities, savedAudio: false } }] }]) {
    await expect(httpContractApp({ env: { VOICE_PROVIDER: "" }, ...options })).rejects.toThrow();
  }
  await expect(httpContractApp({ env: { VOICE_PROVIDER: "", DEEPGRAM_API_KEY: "fixture" }, speechProviders: [{ ...alpha, id: "deepgram" }] })).rejects.toThrow("Duplicate");
});

test("built-ins register by key and browser speech remains opt-in; options precede environment defaults", async () => {
  const { alpha, beta, calls } = doubles();
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "", DEEPGRAM_API_KEY: "fixture-private-key" }, speechProviders: [alpha, beta] });
  try {
    const response = await t.fetch("/api/voice/providers"), raw = await response.text(), body = JSON.parse(raw);
    expect(raw).not.toContain("fixture-private-key"); expect(body.providers.map((p: { id: string }) => p.id)).toEqual(["deepgram", "alpha", "beta"]);
    expect(body.dictation.host).toBe("deepgram"); expect(body.dictation.effective).toBe("deepgram");
    expect(calls).toEqual({ alpha: [], beta: [], audio: [] });
  } finally { await t.close(); }
  const browser = await httpContractApp({ env: { VOICE_PROVIDER: "webspeech" }, speechProviders: [alpha], defaultSpeechProviderId: "alpha" });
  try {
    const body = await (await browser.fetch("/api/voice/providers")).json();
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(["webspeech", "alpha"]); expect(body.dictation.host).toBe("alpha");
  } finally { await browser.close(); }
});
