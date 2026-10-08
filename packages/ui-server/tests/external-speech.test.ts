import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpeechProvider, type SpeechProvider, type SpeechSession } from "@schlessera/brain-ui-sdk/server";
import { createAsrClientRegistry, type AsrClientOptions } from "@schlessera/brain-ui-sdk/client";
import { runSpeechProviderContract } from "@schlessera/brain-ui-sdk/testing";
import { httpContractApp } from "./helpers/http-contract-app";

test("createApp uses a supplied provider on the mounted session route and its public client registry", async () => {
  const requests: string[][] = [];
  const provider = defineSpeechProvider({
    id: "fixture-speech",
    capabilities: { streaming: true, interimResults: false, keyterms: false, endpointing: false },
    async createSession({ keyterms }) {
      requests.push(keyterms);
      return { url: "wss://speech.example.test/dictation", token: "fixture-session-token", params: { language: "en" }, expiresAt: 12345 };
    },
  });
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "fixture-speech", DEEPGRAM_API_KEY: "unused-fixture-key" }, speechProvider: provider });
  try {
    const response = await t.fetch("/api/voice/session", { method: "POST" });
    expect(response.status).toBe(200);
    const session = await response.json();
    expect(session).toEqual({ providerId: provider.id, url: "wss://speech.example.test/dictation", token: "fixture-session-token", params: { language: "en" }, expiresAt: 12345, capabilities: { ...provider.capabilities, savedAudio: false } });
    expect(requests).toEqual([[]]);
    const received: AsrClientOptions[] = [];
    const registry = createAsrClientRegistry();
    const client = { start: async () => {}, stop() {}, drainAndStop: async () => {} };
    registry.register(provider.id, (options) => { received.push(options); return client; });
    expect(registry.create({ session, onEvent() {}, onError() {} })).toBe(client);
    expect(received).toHaveLength(1);
    expect(received[0]!.session).toEqual(session);
  } finally { await t.close(); }
});

const localSession: SpeechSession = { url: "", expiresAt: 0 };
function externalProvider(overrides: Partial<SpeechProvider> = {}): SpeechProvider {
  return defineSpeechProvider({ id: "fixture-speech", capabilities: { streaming: false, interimResults: false, keyterms: false, endpointing: false }, createSession: async () => localSession, ...overrides });
}

test("a supplied provider wins over automatic Deepgram discovery but never an explicit mismatch", async () => {
  let calls = 0;
  const provider = externalProvider({ createSession: async () => { calls++; return localSession; } });
  for (const selection of ["", "fixture-speech", "deepgram", "webspeech", "unknown"]) {
    const before = calls;
    const t = await httpContractApp({ env: { VOICE_PROVIDER: selection, DEEPGRAM_API_KEY: "unused-fixture-key" }, speechProvider: provider });
    try {
      const response = await t.fetch("/api/voice/session", { method: "POST" });
      const body = await response.json();
      if (selection === "" || selection === provider.id) {
        expect(response.status).toBe(200);
        expect(body).toEqual({ providerId: provider.id, ...localSession, capabilities: { ...provider.capabilities, savedAudio: false } });
        expect(calls).toBe(before + 1);
      } else {
        expect(response.status).toBe(500);
        expect(body).toEqual({ error: `VOICE_PROVIDER="${selection}" does not match supplied SpeechProvider "fixture-speech".` });
        expect(calls).toBe(before);
      }
    } finally { await t.close(); }
  }
});

test("supported keyterms reach the supplied provider and false capabilities skip the builder", async () => {
  for (const supported of [true, false]) {
    const requests: string[][] = [];
    const provider = externalProvider({ capabilities: { streaming: true, interimResults: false, keyterms: supported, endpointing: false }, createSession: async ({ keyterms }) => { requests.push(keyterms); return localSession; } });
    const t = await httpContractApp({ env: { VOICE_PROVIDER: provider.id }, speechProvider: provider });
    try {
      mkdirSync(t.app.config.voice.cacheDir, { recursive: true });
      const terms = ["Ithaca", "Odysseus"];
      expect(terms.length).toBeGreaterThan(0);
      writeFileSync(join(t.app.config.voice.cacheDir, "keyterms.json"), JSON.stringify({ version: 2, generatedAt: Date.now(), keyterms: terms, count: terms.length, overrides: [] }));
      const response = await t.fetch("/api/voice/session", { method: "POST" });
      expect(response.status).toBe(200);
      expect(requests).toEqual([supported ? terms : []]);
    } finally { await t.close(); }
  }
});

test("a provider failure stays a session error even when a built-in key is configured", async () => {
  const provider = externalProvider({ createSession: async () => { throw new Error("Fixture speech transport refused"); } });
  const t = await httpContractApp({ env: { VOICE_PROVIDER: "", DEEPGRAM_API_KEY: "unused-fixture-key" }, speechProvider: provider });
  try {
    const response = await t.fetch("/api/voice/session", { method: "POST" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Fixture speech transport refused" });
  } finally { await t.close(); }
});

test("selection without an external value preserves opt-in browser speech and fails closed otherwise", async () => {
  for (const selection of ["", "deepgram", "unknown", "webspeech"]) {
    const t = await httpContractApp({ env: { VOICE_PROVIDER: selection, DEEPGRAM_API_KEY: "" } });
    try {
      const response = await t.fetch("/api/voice/session", { method: "POST" });
      const body = await response.json();
      if (selection === "webspeech") {
        expect(response.status).toBe(200);
        expect(body).toEqual({ providerId: "webspeech", ...localSession, capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: false, savedAudio: false } });
      } else {
        expect(response.status).toBe(500);
        expect(Object.keys(body)).toEqual(["error"]);
        expect(body.error).toMatch(/No speech provider configured|DEEPGRAM_API_KEY is not set|Unknown VOICE_PROVIDER/);
      }
    } finally { await t.close(); }
  }
});

for (const [field, value] of [
  ["id", ""], ["id", " Fixture "], ["capabilities", {}],
  ["capabilities", { streaming: "true", interimResults: false, keyterms: false, endpointing: false }], ["createSession", null],
] as const) {
  test(`the mounted route rejects invalid provider ${field}: ${JSON.stringify(value)}`, async () => {
    let called = false;
    const provider = externalProvider({ createSession: async () => { called = true; return localSession; }, [field]: value } as unknown as Partial<SpeechProvider>);
    const t = await httpContractApp({ env: { VOICE_PROVIDER: "" }, speechProvider: provider });
    try {
      const response = await t.fetch("/api/voice/session", { method: "POST" });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: expect.stringContaining("Invalid SpeechProvider") });
      expect(called).toBe(false);
    } finally { await t.close(); }
  });
}

for (const [name, value] of [
  ["null", null], ["missing URL", { expiresAt: 0 }], ["invalid URL", { url: 1, expiresAt: 0 }],
  ["nonfinite expiry", { url: "", expiresAt: Infinity }], ["negative expiry", { url: "", expiresAt: -1 }],
  ["invalid token", { ...localSession, token: 1 }], ["array params", { ...localSession, params: ["en"] }],
  ["null params", { ...localSession, params: null }], ["invalid params value", { ...localSession, params: { language: 1 } }],
] as const) {
  test(`the mounted route rejects an invalid session: ${name}`, async () => {
    const provider = externalProvider({ createSession: async () => value as unknown as SpeechSession });
    const t = await httpContractApp({ env: { VOICE_PROVIDER: provider.id }, speechProvider: provider });
    try {
      const response = await t.fetch("/api/voice/session", { method: "POST" });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: expect.stringContaining("Invalid SpeechSession") });
    } finally { await t.close(); }
  });
}

runSpeechProviderContract({
  name: "external keyless provider",
  create: () => providerProbe(false),
  failing: () => providerProbe(true),
}, { describe, test, expect });

function providerProbe(failing: boolean) {
  let terms: string[] = [];
  const transport = async (keyterms: string[]): Promise<SpeechSession> => {
    terms = [...keyterms];
    if (failing) throw new Error("Fixture session transport failure");
    return { url: "wss://speech.example.test/dictation", params: { language: "en" }, expiresAt: 1000 };
  };
  let recording!: { audio: Uint8Array; contentType: string; keyterms: string[]; text: string };
  const provider = externalProvider({ capabilities: { streaming: true, interimResults: true, keyterms: true, endpointing: true }, createSession: ({ keyterms }) => transport(keyterms),
    async transcribeRecording({ audio, contentType, keyterms }) {
      recording = { audio: audio.slice(), contentType, keyterms: [...keyterms], text: "Odysseus sails for Ithaca." };
      if (failing) throw new Error("Fixture saved-audio transport failure");
      return { text: recording.text };
    },
  });
  return { provider, recording: () => recording, keyterms: () => terms, dispose() {} };
}
