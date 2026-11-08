// Which service a take goes to, against the mounted useDictation hook (#3709).
// Two deterministic provider doubles, alpha and beta, stand in for registered
// services; discovery, the session request and the ASR clients are fakes on
// the root, so no microphone and no network are involved. The real-browser
// proof against mounted server routes is dictation-selection-runtime.test.ts.
import { unregisterDictationSelectionDom } from "./dictation-selection-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AsrClient, VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";
import type { VoiceProvidersResponse, VoiceSessionRequest } from "@schlessera/brain-ui-sdk/protocol";

import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ApiRequestError, type BrainApi } from "../../src/lib/api-client.js";
import { useDictation } from "../../src/voice/use-dictation.js";
import { acknowledge, dictationTarget, freshDiscovery, isAcknowledged, isDiscovery, loadDiscovery, providerDestination } from "../../src/voice/dictation-providers.js";

const roots: BrainUiRoot[] = [];
afterEach(() => {
  cleanup();
  for (const root of roots.splice(0)) root.dispose();
});
afterAll(unregisterDictationSelectionDom);

const streaming = { streaming: true, interimResults: true, keyterms: false, endpointing: false };
const ALPHA = { id: "alpha", label: "Alpha Transcribe", destination: "Microphone audio streams from this browser to Alpha.", capabilities: { ...streaming, savedAudio: true, smartTranscription: false } };
const BETA = { id: "beta", label: "Beta Live", destination: "Microphone audio streams from this browser to Beta.", capabilities: { ...streaming, savedAudio: false, smartTranscription: true } };

function discovery(dictation: Partial<VoiceProvidersResponse["dictation"]>, providers = [ALPHA, BETA]): VoiceProvidersResponse {
  return { providers, dictation: { saved: null, savedUsable: false, host: null, effective: null, source: "none", smart: true, revision: "1", ...dictation } };
}
const alphaSaved = () => discovery({ saved: "alpha", savedUsable: true, effective: "alpha", source: "saved" });
const betaSaved = () => discovery({ saved: "beta", savedUsable: true, effective: "beta", source: "saved", smart: false, revision: "2" });

class FakeClient implements AsrClient {
  started = 0; stopped = 0;
  constructor(readonly providerId: string) {}
  async start() { this.started++; }
  stop() { this.stopped++; }
  async drainAndStop() { this.stopped++; }
}

/** A root with alpha/beta clients whose discovery and session answers the test controls. */
function selectionRoot(options: { server: () => VoiceProvidersResponse; storage?: Storage | null; holdSession?: boolean }) {
  const sessions: Array<{ request: VoiceSessionRequest | undefined; signal: AbortSignal; resolve: (s: VoiceSessionResponse) => void; reject: (e: unknown) => void }> = [];
  const discoveries: number[] = [];
  const clients: FakeClient[] = [];
  let respond: (request: VoiceSessionRequest | undefined) => VoiceSessionResponse = (request) => ({ providerId: request?.providerId ?? options.server().dictation.effective!, url: "", expiresAt: Date.now() + 60_000, capabilities: streaming });
  const api = {
    voiceProviders: async () => { discoveries.push(Date.now()); return structuredClone(options.server()); },
    voiceSession: (signal?: AbortSignal, request?: VoiceSessionRequest) => new Promise<VoiceSessionResponse>((resolve, reject) => {
      sessions.push({ request, signal: signal!, resolve, reject });
      if (!options.holdSession) resolve(respond(request));
    }),
    voiceOverrides: async () => ({ overrides: [] }),
    status: async () => ({ contentRenderers: [] }),
  } as unknown as BrainApi;
  const root = createBrainUiRoot({ storage: options.storage ?? null, api });
  for (const id of ["alpha", "beta"]) root.asr.register(id, () => { const client = new FakeClient(id); clients.push(client); return client; });
  roots.push(root);
  return { root, sessions, discoveries, clients, answer(fn: typeof respond) { respond = fn; } };
}

function mount(root: BrainUiRoot) {
  return renderHook(() => useDictation(), { wrapper: ({ children }: { children: ReactNode }) => <BrainUiProvider root={root}>{children}</BrainUiProvider> });
}
const voice = (root: BrainUiRoot) => root.stores.voice.getState();

describe("the take's target from discovery (plan §4)", () => {
  test("a usable saved choice, the host default and the only provider are each effective; nothing else falls back", () => {
    expect(dictationTarget(alphaSaved())).toMatchObject({ kind: "ready", provider: { id: "alpha" } });
    expect(dictationTarget(discovery({ host: "alpha", effective: "alpha", source: "host" }))).toMatchObject({ kind: "ready", provider: { id: "alpha" } });
    expect(dictationTarget(discovery({ effective: "beta", source: "only" }, [BETA]))).toMatchObject({ kind: "ready", provider: { id: "beta" }, smart: true });
    expect(dictationTarget(discovery({}))).toEqual({ kind: "blocked", reason: "choose", saved: null });
    expect(dictationTarget(discovery({ saved: "webspeech", savedUsable: false, host: "alpha", source: "unavailable" })), "a removed saved choice never falls back to the host default").toEqual({ kind: "blocked", reason: "unavailable", saved: "webspeech" });
    expect(dictationTarget(discovery({}, []))).toEqual({ kind: "blocked", reason: "none", saved: null });
    expect(dictationTarget(discovery({ saved: "alpha", source: "unavailable" }, [])), "nothing registered: nothing to choose in Settings either").toEqual({ kind: "blocked", reason: "none", saved: null });
  });

  test("only a well-formed discovery answer is accepted", () => {
    expect(isDiscovery(alphaSaved())).toBe(true);
    expect(isDiscovery({})).toBe(false);
    expect(isDiscovery({ ...alphaSaved(), dictation: { ...alphaSaved().dictation, source: "fallback" } })).toBe(false);
    expect(isDiscovery({ ...alphaSaved(), providers: [{ id: "", label: "x", capabilities: {} }] })).toBe(false);
  });
});

describe("the one-time acknowledgement (D4)", () => {
  test("is keyed by provider and destination text, per account, and storage that fails is never consent", () => {
    const stored = new Map<string, string>();
    const storage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); }, removeItem: (k: string) => { stored.delete(k); } } as unknown as Storage;
    const { root } = selectionRoot({ server: alphaSaved, storage });
    expect(isAcknowledged(root, ALPHA)).toBe(false);
    acknowledge(root, ALPHA);
    expect(isAcknowledged(root, ALPHA)).toBe(true);
    expect(isAcknowledged(root, BETA), "another provider asks on its own").toBe(false);
    expect(isAcknowledged(root, { ...ALPHA, destination: "Microphone audio now streams to Alpha's new region." }), "a changed destination asks again").toBe(false);
    root.stores.connection.getState().setVpnStatus("connected", "telemachus");
    expect(isAcknowledged(root, ALPHA), "another account on this device asks on its own").toBe(false);
    expect([...stored.values()]).toEqual([providerDestination(ALPHA)]);

    // Storage that refuses this record (a quota, a blocked partition) while the rest of the root reads normally.
    const ours = (key: string) => key.includes("dictation-acknowledged");
    const broken = { getItem: (k: string) => { if (ours(k)) throw new DOMException("denied", "SecurityError"); return null; }, setItem: (k: string) => { if (ours(k)) throw new DOMException("full", "QuotaExceededError"); }, removeItem: () => {} } as unknown as Storage;
    const failing = selectionRoot({ server: alphaSaved, storage: broken }).root;
    acknowledge(failing, ALPHA);
    expect(isAcknowledged(failing, ALPHA), "STORAGE_FAILURE_IS_NOT_CONSENT").toBe(false);
  });

  test("no session is requested and no client is created before Start dictation", async () => {
    const s = selectionRoot({ server: alphaSaved });
    const hook = mount(s.root);
    await act(async () => { void hook.result.current.start(); await Promise.resolve(); });
    await act(async () => {});
    expect(s.sessions, "NO_SESSION_BEFORE_START_DICTATION").toHaveLength(0);
    expect(s.clients).toHaveLength(0);
    expect(voice(s.root).dictationGate, "the acknowledgement card is up").toMatchObject({ kind: "consent", provider: { id: "alpha" } });
    expect(voice(s.root).connecting, "the sheet does not claim to connect").toBe(false);

    await act(async () => { hook.result.current.confirm(); });
    await act(async () => {});
    expect(s.sessions.map((x) => x.request), "the disclosed service and SMART choice are sent").toEqual([{ providerId: "alpha", smart: true }]);
    expect(s.clients.map((c) => [c.providerId, c.started])).toEqual([["alpha", 1]]);
    expect(voice(s.root).dictationTarget?.id).toBe("alpha");
    expect(isAcknowledged(s.root, ALPHA)).toBe(true);

    // Later takes start at once.
    await act(async () => { await hook.result.current.stop(false); });
    await act(async () => { await hook.result.current.start(); });
    expect(voice(s.root).dictationGate).toBeNull();
    expect(s.sessions).toHaveLength(2);
  });

  test("Cancel on the card opens nothing and acknowledges nothing", async () => {
    const s = selectionRoot({ server: alphaSaved });
    const hook = mount(s.root);
    let pending!: Promise<void>;
    await act(async () => { pending = hook.result.current.start(); });
    await act(async () => {});
    expect(voice(s.root).dictationGate?.kind).toBe("consent");
    await act(async () => { hook.result.current.cancel(); await pending; });
    expect(voice(s.root).mode).toBe("idle");
    expect(voice(s.root).dictationGate).toBeNull();
    expect(s.sessions).toHaveLength(0);
    expect(s.clients).toHaveLength(0);
    expect(isAcknowledged(s.root, ALPHA)).toBe(false);
  });
});

describe("binding a take to what it disclosed (plan §5)", () => {
  test("a default changed elsewhere after disclosure does not retarget the take", async () => {
    let server = alphaSaved();
    const s = selectionRoot({ server: () => server });
    const hook = mount(s.root);
    await act(async () => { void hook.result.current.start(); });
    await act(async () => {});
    expect(voice(s.root).dictationGate).toMatchObject({ kind: "consent", provider: { id: "alpha" } });
    // Another device saves Beta while the card shows Alpha; the snapshot ages out.
    server = betaSaved();
    s.root.stores.voice.setState({ discovery: { snapshot: voice(s.root).discovery!.snapshot, at: Date.now() - 120_000 } });
    await act(async () => { hook.result.current.confirm(); });
    await act(async () => {});
    expect(s.sessions.map((x) => x.request?.providerId), "DISCLOSED_PROVIDER_IS_SENT").toEqual(["alpha"]);
    expect(s.clients.map((c) => c.providerId)).toEqual(["alpha"]);
    expect(voice(s.root).dictationTarget?.id).toBe("alpha");
  });

  test("a session for another service is refused, never used in its place", async () => {
    const s = selectionRoot({ server: alphaSaved });
    acknowledge(s.root, ALPHA);
    s.answer(() => ({ providerId: "beta", url: "", expiresAt: Date.now() + 60_000, capabilities: streaming }));
    const hook = mount(s.root);
    await act(async () => { await hook.result.current.start(); });
    expect(s.clients, "no client for the substituted service").toHaveLength(0);
    expect(voice(s.root).mode).toBe("idle");
    expect(voice(s.root).dictationNotice).toEqual({ reason: "unknown", phase: "startup", retained: false });
    expect(voice(s.root).discovery?.stale, "the next tap reads the choice again").toBe(true);
    expect(freshDiscovery(s.root)).toBeNull();
  });

  test("409 speech_provider_unavailable uses the startup notice and starts no other recognizer", async () => {
    const s = selectionRoot({ server: alphaSaved, holdSession: true });
    acknowledge(s.root, ALPHA);
    const hook = mount(s.root);
    let pending!: Promise<void>;
    await act(async () => { pending = hook.result.current.start(); });
    await act(async () => {});
    await act(async () => { s.sessions[0]!.reject(new ApiRequestError("speech_provider_unavailable", 409)); await pending; });
    expect(s.clients).toHaveLength(0);
    expect(s.sessions).toHaveLength(1);
    expect(voice(s.root).dictationNotice?.phase).toBe("startup");
  });

  test("cancelling while the session is minted aborts it and opens no client", async () => {
    const s = selectionRoot({ server: alphaSaved, holdSession: true });
    acknowledge(s.root, ALPHA);
    const hook = mount(s.root);
    let pending!: Promise<void>;
    await act(async () => { pending = hook.result.current.start(); });
    await act(async () => {});
    expect(s.sessions).toHaveLength(1);
    act(() => hook.result.current.cancel());
    expect(s.sessions[0]!.signal.aborted, "the mint request is aborted").toBe(true);
    await act(async () => { s.sessions[0]!.resolve({ providerId: "alpha", url: "", expiresAt: Date.now() + 60_000, capabilities: streaming }); await pending; });
    expect(s.clients, "no client opens after a cancelled mint").toHaveLength(0);
    expect(voice(s.root).mode).toBe("idle");
  });

  test("cancelling while discovery is read opens nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const s = selectionRoot({ server: alphaSaved });
    const read = s.root.api.voiceProviders;
    s.root.api.voiceProviders = async () => { await gate; return read(); };
    const hook = mount(s.root);
    let pending!: Promise<void>;
    await act(async () => { pending = hook.result.current.start(); });
    act(() => hook.result.current.cancel());
    await act(async () => { release(); await pending; });
    expect(voice(s.root).dictationGate).toBeNull();
    expect(s.sessions).toHaveLength(0);
  });

  test("a snapshot older than a minute is read again before the session request", async () => {
    let server = alphaSaved();
    const s = selectionRoot({ server: () => server });
    acknowledge(s.root, ALPHA); acknowledge(s.root, BETA);
    await loadDiscovery(s.root);
    server = betaSaved();
    s.root.stores.voice.setState({ discovery: { snapshot: voice(s.root).discovery!.snapshot, at: Date.now() - 61_000 } });
    const hook = mount(s.root);
    await act(async () => { await hook.result.current.start(); });
    expect(s.discoveries).toHaveLength(2);
    expect(s.sessions.map((x) => x.request), "the refreshed choice and its SMART setting").toEqual([{ providerId: "beta", smart: false }]);
  });

  for (const [name, server, reason] of [
    ["several services, none chosen", () => discovery({}), "choose"],
    ["a saved service that is gone", () => discovery({ saved: "webspeech", savedUsable: false, host: "alpha", source: "unavailable" }), "unavailable"],
    ["no service at all", () => discovery({}, []), "none"],
  ] as const) {
    test(`${name}: the sheet explains, and nothing is minted or opened`, async () => {
      const s = selectionRoot({ server });
      const hook = mount(s.root);
      await act(async () => { await hook.result.current.start(); });
      expect(voice(s.root).dictationGate).toMatchObject({ kind: "blocked", reason });
      expect(voice(s.root).mode, "the sheet stays to explain").toBe("dictate");
      expect(s.sessions).toHaveLength(0);
      expect(s.clients).toHaveLength(0);
      act(() => hook.result.current.cancel());
      expect(voice(s.root).mode).toBe("idle");
      expect(voice(s.root).dictationGate).toBeNull();
    });
  }
});
