import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSpeechProvider, type SpeechProvider } from "@schlessera/brain-ui-sdk/server";
import { runSpeechProviderContract } from "@schlessera/brain-ui-sdk/testing";
import type { VoiceConfig } from "../src/config/env";
import {
  createGeminiSpeechProvider, GEMINI_AUTH_TOKENS_URL, GEMINI_SESSION_FAILED, GEMINI_TRANSCRIBE_MODEL, GEMINI_TRANSCRIBE_URL,
} from "../src/voice/gemini-speech";
import { createSpeechProviderRegistry } from "../src/voice/speech-providers";
import { AUTH_TOKEN_WITH_VOCABULARY, AUTH_TOKEN_WITHOUT_VOCABULARY, authTokenWireError } from "./fixtures/gemini-auth-token-wire";
import { httpContractApp } from "./helpers/http-contract-app";

const KEY = "odysseus-fixture-gemini-key";
const TOKEN = "auth_tokens/ithaca-fixture-ephemeral";

interface Seen { method: string; url: string; headers: Record<string, string>; body: any }
type Answer = (seen: Seen) => Response | Promise<Response>;

/**
 * A loopback stand-in for Google's auth_tokens endpoint. The provider's
 * `fetch` to the real URL is redirected here, so the request crosses an
 * actual HTTP hop (method, headers, serialized body) and nothing leaves the
 * machine. Everything else is refused, as the test preload would. Like
 * Google's REST surface, it refuses a body that is not the AuthToken shape
 * captured from @google/genai's own serializer (the fixture), so a request
 * built from SDK option names fails here before any answer is scripted.
 */
function authTokensDouble(answer: Answer = () => Response.json({ name: TOKEN })) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const record = { method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body: JSON.parse(await request.text()) };
      seen.push(record);
      const invalid = authTokenWireError(record.body);
      if (invalid) return Response.json({ error: { code: 400, message: `Invalid JSON payload received: ${invalid}` } }, { status: 400 });
      return answer(record);
    },
  });
  const realFetch = globalThis.fetch;
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input) !== GEMINI_AUTH_TOKENS_URL) throw new Error(`Unexpected request to ${String(input)}`);
    return realFetch(`http://127.0.0.1:${server.port}/v1beta/auth_tokens`, init);
  }, { preconnect: fetch.preconnect }));
  return { seen, dispose: () => { mock.mockRestore(); server.stop(true); } };
}

let active: Array<() => void> = [];
afterEach(() => { for (const dispose of active.splice(0)) dispose(); });
function double(answer?: Answer) { const d = authTokensDouble(answer); active.push(d.dispose); return d; }

function probe(failing: boolean) {
  const d = authTokensDouble(failing ? () => new Response(`API key ${KEY} not valid`, { status: 403 }) : undefined);
  return {
    provider: createGeminiSpeechProvider(KEY),
    keyterms: () => d.seen.at(-1)?.body.bidiGenerateContentSetup.inputAudioTranscription.customVocabulary ?? [],
    dispose: d.dispose,
  };
}

runSpeechProviderContract({ name: "built-in Gemini Transcribe Live with a loopback auth_tokens double", create: () => probe(false), failing: () => probe(true) }, { describe, test, expect });

describe("Gemini dictation session", () => {
  test("mints one constrained single-use token locking model, TEXT modality and SMART transcription", async () => {
    const d = double();
    const before = Date.now();
    const session = await createGeminiSpeechProvider(KEY).createSession({ keyterms: ["Ithaca", "Penelope"] });
    const after = Date.now();
    expect(d.seen).toHaveLength(1);
    const [request] = d.seen;
    expect(request!.method).toBe("POST");
    expect(request!.headers["x-goog-api-key"]).toBe(KEY);
    expect(request!.headers["content-type"]).toBe("application/json");
    const { expireTime, newSessionExpireTime, ...rest } = request!.body;
    const { expireTime: _e, newSessionExpireTime: _n, ...captured } = AUTH_TOKEN_WITH_VOCABULARY;
    expect(authTokenWireError(request!.body), "GEMINI_CONSTRAINT_LOCK wire schema").toBeNull();
    expect(rest, "GEMINI_CONSTRAINT_LOCK").toEqual(captured);
    expect(Date.parse(newSessionExpireTime)).toBeGreaterThanOrEqual(before + 60_000 - 1);
    expect(Date.parse(newSessionExpireTime)).toBeLessThanOrEqual(after + 60_000);
    expect(Date.parse(expireTime)).toBeGreaterThanOrEqual(before + 11 * 60_000 - 1);
    expect(Date.parse(expireTime)).toBeLessThanOrEqual(after + 11 * 60_000);
    expect(session).toEqual({
      url: GEMINI_TRANSCRIBE_URL, token: TOKEN, expiresAt: Date.parse(newSessionExpireTime),
      params: { model: GEMINI_TRANSCRIBE_MODEL, mode: "SMART", sampleRate: "16000", vocabulary: JSON.stringify(["Ithaca", "Penelope"]), languageCodes: JSON.stringify(["en-US"]) },
    });
    expect(JSON.stringify(session)).not.toContain(KEY);
  });

  test("without keyterms the lock neither sets nor masks customVocabulary", async () => {
    const d = double();
    await createGeminiSpeechProvider(KEY).createSession({ keyterms: [] });
    const { expireTime: _e, newSessionExpireTime: _n, ...rest } = d.seen[0]!.body;
    const { expireTime: _ce, newSessionExpireTime: _cn, ...captured } = AUTH_TOKEN_WITHOUT_VOCABULARY;
    expect(rest, "GEMINI_CONSTRAINT_LOCK").toEqual(captured);
  });

  test("verbatim is used only when asked for, in the lock and the browser's setup alike", async () => {
    const d = double();
    const provider = createGeminiSpeechProvider(KEY);
    const verbatim = await provider.createSession({ keyterms: [], mode: "verbatim" });
    const smart = await provider.createSession({ keyterms: [], mode: "smart" });
    const unset = await provider.createSession({ keyterms: [] });
    expect(d.seen.map((seen) => seen.body.bidiGenerateContentSetup.inputAudioTranscription)).toEqual([{ mode: "VERBATIM", languageCodes: ["en-US"] }, { mode: "SMART", languageCodes: ["en-US"] }, { mode: "SMART", languageCodes: ["en-US"] }]);
    expect(d.seen.map((seen) => authTokenWireError(seen.body))).toEqual([null, null, null]);
    expect([verbatim, smart, unset].map((session) => [session.params!.mode, session.params!.vocabulary])).toEqual([["VERBATIM", "[]"], ["SMART", "[]"], ["SMART", "[]"]]);
  });

  test("vocabulary is the existing keyterms, bounded to 100 terms of at most 64 UTF-8 bytes", async () => {
    const d = double();
    const long = "Ω".repeat(33); // 66 UTF-8 bytes, 33 characters
    const terms = ["", "  ", "Telemachus", long, "Telemachus", "x".repeat(64), "x".repeat(65), ...Array.from({ length: 150 }, (_, i) => `Ithaca harbor ${i}`)];
    const session = await createGeminiSpeechProvider(KEY).createSession({ keyterms: terms });
    const sent: string[] = d.seen[0]!.body.bidiGenerateContentSetup.inputAudioTranscription.customVocabulary;
    expect(sent).toHaveLength(100);
    expect(sent.slice(0, 3)).toEqual(["Telemachus", "x".repeat(64), "Ithaca harbor 0"]);
    expect(sent).not.toContain(long);
    for (const term of sent) expect(new TextEncoder().encode(term).byteLength).toBeLessThanOrEqual(64);
    expect(JSON.parse(session.params!.vocabulary!)).toEqual(sent);
  });

  const failures: Array<[string, Answer | "network"]> = [
    ["an authentication refusal echoing the key", () => new Response(`API key ${KEY} not valid. Please pass a valid API key.`, { status: 400 })],
    ["a provider error", () => Response.json({ error: { message: `quota for ${KEY}` } }, { status: 500 })],
    ["a non-JSON success", () => new Response(`<html>${KEY}</html>`, { status: 200 })],
    ["a success without a token name", () => Response.json({ expireTime: "2026-07-12T09:00:00Z" })],
    ["a success naming something other than an auth token", () => Response.json({ name: `projects/${KEY}` })],
    ["a transport failure", "network"],
  ];
  for (const [name, answer] of failures) test(`${name} fails with the fixed message and never leaks the key or Google's text`, async () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); }));
    let mock: ReturnType<typeof spyOn> | undefined;
    try {
      if (answer === "network") mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => { throw new TypeError(`connect failed for ${GEMINI_AUTH_TOKENS_URL}?key=${KEY}`); }, { preconnect: fetch.preconnect }));
      else double(answer);
      let caught: unknown;
      try { await createGeminiSpeechProvider(KEY).createSession({ keyterms: ["Ithaca"] }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe(GEMINI_SESSION_FAILED);
      expect(String((caught as Error).stack)).not.toContain(KEY);
      expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(logs.join("\n")).not.toContain(KEY);
    } finally { mock?.mockRestore(); for (const spy of spies) spy.mockRestore(); }
  });

  test("a missing key is refused at construction", () => {
    expect(() => createGeminiSpeechProvider("  ")).toThrow("GEMINI_API_KEY");
  });
});

const voice = (overrides: Partial<VoiceConfig>): VoiceConfig => ({ provider: null, deepgramApiKey: null, geminiApiKey: null, keytermLimit: 0, cacheDir: "/tmp", ...overrides });

const NONE_SAVED = { defaultProvider: null, smart: true, revision: "0" };
const effective = (config: VoiceConfig, supplied?: SpeechProvider) =>
  createSpeechProviderRegistry(config, supplied ? { speechProvider: supplied } : {}).effective(NONE_SAVED);

describe("Gemini registration in the dictation registry", () => {
  test("VOICE_PROVIDER=gemini needs GEMINI_API_KEY, as a route error rather than a boot failure", () => {
    expect(() => effective(voice({ provider: "gemini" }))).toThrow("VOICE_PROVIDER=gemini but GEMINI_API_KEY is not set.");
    expect(effective(voice({ provider: "gemini", geminiApiKey: KEY, deepgramApiKey: "unused" })).id).toBe("gemini");
  });

  test("a Gemini key adds a choice; it is used unsaved only as the only provider, and Deepgram stays the host default (D3)", () => {
    expect(effective(voice({ geminiApiKey: KEY })).id).toBe("gemini");
    expect(effective(voice({ geminiApiKey: KEY, deepgramApiKey: "fixture-deepgram" })).id).toBe("deepgram");
    expect(effective(voice({ provider: "deepgram", geminiApiKey: KEY, deepgramApiKey: "fixture-deepgram" })).id).toBe("deepgram");
    const both = createSpeechProviderRegistry(voice({ geminiApiKey: KEY, deepgramApiKey: "fixture-deepgram" }));
    expect(both.discovery(NONE_SAVED).providers.map(p => p.id)).toEqual(["deepgram", "gemini"]);
    // Built-ins disclose their own name and destination; clients need no per-id mapping.
    expect(both.discovery(NONE_SAVED).providers.map(p => [p.label, p.destination !== undefined])).toEqual([["Deepgram", true], ["Google Gemini 3.5 Transcribe Live", true]]);
    const browser = createSpeechProviderRegistry(voice({ provider: "webspeech" })).discovery(NONE_SAVED).providers[0]!;
    expect(browser).toMatchObject({ id: "webspeech", label: "Browser speech recognition" });
    expect(browser.destination).toContain("Google");
    expect(both.effective({ ...NONE_SAVED, defaultProvider: "gemini" }).id).toBe("gemini");
    expect(() => effective(voice({}))).toThrow("Set DEEPGRAM_API_KEY or GEMINI_API_KEY");
    expect(() => effective(voice({ provider: "athena" }))).toThrow('Unknown VOICE_PROVIDER="athena"');
  });

  test("the declared capabilities are streaming, SMART, keyterms, manual Done and no saved audio", () => {
    const provider = effective(voice({ provider: "gemini", geminiApiKey: KEY }));
    expect(provider.capabilities).toEqual({ streaming: true, interimResults: true, keyterms: true, endpointing: false, smartTranscription: true, savedAudio: false });
    expect(provider.transcribeRecording).toBeUndefined();
    expect(provider.label).toBe("Google Gemini 3.5 Transcribe Live");
    expect(provider.destination).toContain("Google");
  });

  test("supplied providers' optional label, destination and smartTranscription are validated", () => {
    const base = { id: "fixture-speech", capabilities: { streaming: true, interimResults: false, keyterms: false, endpointing: false }, createSession: async () => ({ url: "", expiresAt: 0 }) };
    const invalid: Array<[Partial<SpeechProvider> & Record<string, unknown>, string]> = [
      [{ label: "" }, "label must be a nonempty string"],
      [{ destination: 7 as unknown as string }, "destination must be a nonempty string"],
      [{ capabilities: { ...base.capabilities, smartTranscription: "yes" as unknown as boolean } }, "smartTranscription must be boolean"],
    ];
    for (const [overrides, message] of invalid) {
      expect(() => effective(voice({}), { ...base, ...overrides } as SpeechProvider)).toThrow(message);
      expect(() => createSpeechProviderRegistry(voice({}), { speechProviders: [{ ...base, ...overrides } as SpeechProvider] })).toThrow(message);
    }
    const valid = defineSpeechProvider({ ...base, label: "Fixture", destination: "Audio stays on this fixture.", capabilities: { ...base.capabilities, smartTranscription: false } });
    expect(effective(voice({}), valid)).toMatchObject({ id: "fixture-speech", label: "Fixture", destination: "Audio stays on this fixture." });
  });
});

/** The brain's keyterm cache, as the builder writes it, so the route forwards real terms. */
function keyterms(t: Awaited<ReturnType<typeof httpContractApp>>, terms: string[]) {
  mkdirSync(t.app.config.voice.cacheDir, { recursive: true });
  writeFileSync(join(t.app.config.voice.cacheDir, "keyterms.json"), JSON.stringify({ version: 2, generatedAt: Date.now(), keyterms: terms, count: terms.length, overrides: [] }));
}

describe("Gemini dictation through the mounted app", () => {
  test("VOICE_PROVIDER=gemini serves capabilities and a constrained session on the real routes", async () => {
    const d = double();
    const t = await httpContractApp({ env: { VOICE_PROVIDER: "gemini", GEMINI_API_KEY: KEY } });
    try {
      const capabilities = await t.fetch("/api/voice/capabilities");
      expect(capabilities.status).toBe(200);
      const expected = { streaming: true, interimResults: true, keyterms: true, endpointing: false, smartTranscription: true, savedAudio: false };
      expect(await capabilities.json()).toEqual({ providerId: "gemini", capabilities: expected });
      expect(d.seen, "discovery mints nothing").toHaveLength(0);
      keyterms(t, ["Ithaca", "Penelope"]);
      const response = await t.fetch("/api/voice/session", { method: "POST" });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(KEY);
      const body = JSON.parse(text);
      expect(body).toMatchObject({ providerId: "gemini", url: GEMINI_TRANSCRIBE_URL, token: TOKEN, capabilities: expected });
      expect(body.params.mode).toBe("SMART");
      expect(d.seen).toHaveLength(1);
      expect(d.seen[0]!.body.bidiGenerateContentSetup).toEqual(AUTH_TOKEN_WITH_VOCABULARY.bidiGenerateContentSetup);
    } finally { await t.close(); }
  });

  test("a refused mint is the fixed 500 and no other provider is tried", async () => {
    const d = double(() => new Response(`API key ${KEY} expired`, { status: 403 }));
    const t = await httpContractApp({ env: { VOICE_PROVIDER: "", GEMINI_API_KEY: KEY } });
    try {
      keyterms(t, ["Ithaca"]);
      const response = await t.fetch("/api/voice/session", { method: "POST" });
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: GEMINI_SESSION_FAILED });
      expect(text).not.toContain(KEY);
      expect(d.seen).toHaveLength(1);
    } finally { await t.close(); }
  });

  test("with both keys and no VOICE_PROVIDER the host keeps Deepgram", async () => {
    const t = await httpContractApp({ env: { VOICE_PROVIDER: "", GEMINI_API_KEY: KEY, DEEPGRAM_API_KEY: "fixture-deepgram" } });
    try {
      expect((await (await t.fetch("/api/voice/capabilities")).json()).providerId).toBe("deepgram");
    } finally { await t.close(); }
  });
});
