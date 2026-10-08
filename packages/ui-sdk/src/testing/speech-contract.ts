import type { AsrEvent, VoiceSessionResponse } from "../protocol.js";
import type { SpeechProvider } from "../server/speech.js";
import type { AsrClient, AsrClientOptions } from "../client/asr.js";
import type { ContractTestPrimitives } from "./index.js";

/** A fresh provider running against a caller-owned, keyless fake transport. */
export interface SpeechProviderContractProbe {
  provider: SpeechProvider;
  /** Terms observed by the actual provider's transport, when keyterms is true. */
  keyterms(): readonly string[];
  /** Observe saved-audio transport input/result, when the method is supplied. */
  recording?(): { audio: Uint8Array; contentType: string; keyterms: readonly string[]; text: string };
  dispose(): void | Promise<void>;
}

export interface SpeechProviderContractHarness {
  name: string;
  create(): SpeechProviderContractProbe;
  /** Same implementation with a failing transport; null only for transport-free sessions. */
  failing: (() => SpeechProviderContractProbe) | null;
}

/** Register dictation session, capability, keyterm and failure assertions. */
export function runSpeechProviderContract(
  harness: SpeechProviderContractHarness,
  { describe, test, expect }: ContractTestPrimitives,
): void {
  describe(`SpeechProvider contract: ${harness.name}`, () => {
    test("declares a usable identity and complete boolean capabilities", async () => {
      const probe = harness.create();
      try {
        const { provider } = probe;
        expect(typeof provider.id).toBe("string");
        expect(provider.id.length).toBeGreaterThan(0);
        expect(provider.id).toBe(provider.id.trim().toLowerCase());
        for (const name of ["streaming", "interimResults", "keyterms", "endpointing"] as const) {
          expect(typeof provider.capabilities[name]).toBe("boolean");
        }
        expect(typeof provider.createSession).toBe("function");
      } finally { await probe.dispose(); }
    });

    test("mints a serializable session and forwards supported nonempty keyterms without mutating input", async () => {
      const probe = harness.create();
      try {
        const terms = ["Ithaca", "Odysseus"];
        expect(terms.length).toBeGreaterThan(0);
        const session = await probe.provider.createSession({ keyterms: terms });
        expect(terms).toEqual(["Ithaca", "Odysseus"]);
        if (probe.provider.capabilities.keyterms) expect(probe.keyterms()).toEqual(terms);
        expect(typeof session.url).toBe("string");
        expect(Number.isFinite(session.expiresAt)).toBe(true);
        expect(session.expiresAt).toBeGreaterThanOrEqual(0);
        if (session.token !== undefined) expect(typeof session.token).toBe("string");
        if (session.params !== undefined) {
          expect(Array.isArray(session.params)).toBe(false);
          expect(session.params !== null && typeof session.params === "object").toBe(true);
          for (const value of Object.values(session.params)) expect(typeof value).toBe("string");
        }
        expect(JSON.parse(JSON.stringify(session))).toEqual(session);
      } finally { await probe.dispose(); }
    });

    test("optional saved-audio method forwards unmodified bytes and rejects transport failure", async () => {
      const probe = harness.create();
      try {
        const method = probe.provider.transcribeRecording;
        if (probe.provider.capabilities.savedAudio !== undefined) expect(probe.provider.capabilities.savedAudio).toBe(typeof method === "function");
        if (!method) return;
        const audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
        const keyterms = ["Ithaca"];
        const result = await method.call(probe.provider, { audio, contentType: "audio/webm;codecs=opus", keyterms, signal: new AbortController().signal });
        expect(typeof result.text).toBe("string"); expect(result.text.trim().length).toBeGreaterThan(0);
        expect(audio).toEqual(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]));
        expect(keyterms).toEqual(["Ithaca"]);
        // A fixture without transport observation is not a conformance proof.
        expect(typeof probe.recording).toBe("function");
        expect(probe.recording!()).toEqual({ audio, contentType: "audio/webm;codecs=opus", keyterms: probe.provider.capabilities.keyterms ? keyterms : [], text: result.text });
      } finally { await probe.dispose(); }
      if (harness.failing) {
        const failure = harness.failing();
        try {
          expect(typeof failure.provider.transcribeRecording).toBe("function");
          let caught: unknown;
          try { await failure.provider.transcribeRecording!({ audio: new Uint8Array([1]), contentType: "audio/mp4", keyterms: [], signal: new AbortController().signal }); }
          catch (error) { caught = error; }
          expect(caught).toBeInstanceOf(Error);
        } finally { await failure.dispose(); }
      }
    });

    if (harness.failing) test("rejects a session transport failure instead of returning fallback connection material", async () => {
      const probe = harness.failing!();
      try {
        let failure: unknown;
        try { await probe.provider.createSession({ keyterms: ["Ithaca"] }); }
        catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
      } finally { await probe.dispose(); }
    });
  });
}

/** Drive an implementation through its real capture/recognition transport. */
export interface AsrClientContractProbe {
  client: AsrClient;
  /** Observe microphone tracks/recognizer state, rather than a method-call count. */
  captureActive(): boolean;
  /** Observe the socket/recognizer lifecycle independently of microphone tracks. */
  connectionActive(): boolean;
  /** Deliver a transport result and wait for callbacks queued by that result. */
  deliver(event: AsrEvent): void | Promise<void>;
  /** Deliver a transport failure; it must reach onError as an Error. */
  fail(): void | Promise<void>;
  /** Complete the transport's graceful flush with this final event. */
  finishDrain(event: AsrEvent & { type: "final" }): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface AsrClientContractHarness {
  name: string;
  session: VoiceSessionResponse;
  create(options: AsrClientOptions): AsrClientContractProbe;
}

/** Register capture, supported events, error, hard-stop and graceful-drain assertions. */
export function runAsrClientContract(
  harness: AsrClientContractHarness,
  { describe, test, expect }: ContractTestPrimitives,
): void {
  describe(`AsrClient contract: ${harness.name}`, () => {
    const makeProbe = () => {
      const events: AsrEvent[] = [], errors: Error[] = [];
      const probe = harness.create({ session: harness.session, onEvent: (event) => events.push(event), onError: (error) => errors.push(error) });
      return { probe, events, errors };
    };

    test("start activates capture and delivers supported transcript events and errors", async () => {
      const { probe, events, errors } = makeProbe();
      try {
        expect(probe.captureActive()).toBe(false);
        await probe.client.start();
        expect(probe.captureActive()).toBe(true);
        expect(probe.connectionActive()).toBe(true);
        if (harness.session.capabilities.interimResults) {
          await probe.deliver({ type: "partial", text: "At the" });
          expect(events).toEqual([{ type: "partial", text: "At the" }]);
        }
        const final: AsrEvent = { type: "final", text: "At the harbor", endsTurn: harness.session.capabilities.endpointing };
        await probe.deliver(final);
        expect(events[events.length - 1]).toEqual(final);
        await probe.fail();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(Error);
      } finally { probe.client.stop(); await probe.dispose(); }
    });

    test("hard stop releases capture without waiting for a graceful final", async () => {
      const { probe, events } = makeProbe();
      try {
        await probe.client.start();
        expect(probe.captureActive()).toBe(true);
        probe.client.stop();
        expect(probe.captureActive()).toBe(false);
        expect(probe.connectionActive()).toBe(false);
        expect(events).toHaveLength(0);
      } finally { probe.client.stop(); await probe.dispose(); }
    });

    test("drain delivers the buffered final before resolving and releases capture", async () => {
      const { probe, events } = makeProbe();
      try {
        await probe.client.start();
        expect(probe.captureActive()).toBe(true);
        let settled = false;
        const draining = probe.client.drainAndStop().then(() => { settled = true; });
        // The fixture holds a buffered final: an implementation that returns
        // before its transport flush completes must fail here. Yield a whole
        // task, not one microtask: a drain that awaits a few resolved promises
        // and then stops without flushing would otherwise still read pending.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        const final: AsrEvent & { type: "final" } = { type: "final", text: "Departure tomorrow", endsTurn: harness.session.capabilities.endpointing };
        await probe.finishDrain(final);
        await draining;
        expect(events).toEqual([final]);
        expect(probe.captureActive()).toBe(false);
        expect(probe.connectionActive()).toBe(false);
      } finally { probe.client.stop(); await probe.dispose(); }
    });
  });
}
