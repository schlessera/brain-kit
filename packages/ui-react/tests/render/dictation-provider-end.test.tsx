// A dictation the speech provider ends on its own (#1189): the Deepgram
// socket closes (end of stream, an idle timeout, a dropped connection, an
// expired grant) or the browser's recognizer fires `onend` without a stop.
// What was heard must reach the review card exactly once, in the same store
// update that ends the dictation, so the update reload (#1015) never sees a
// moment in which the words are held by nothing.
//
// Both shipped clients run for real through `useDictation`: the built-in
// registrations, the Deepgram client over a scripted socket, recorder and
// microphone, and the Web Speech client over a scripted recognizer. No
// network, no microphone, no provider key.
import { unregisterDictationProviderEndDom } from "./dictation-provider-end-dom.js";

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";

import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { BrainApi } from "../../src/lib/api-client.js";
import { useDictation } from "../../src/voice/use-dictation.js";
import { useServiceWorkerUpdates } from "../../src/index.js";

afterAll(unregisterDictationProviderEndDom);

// ── The browser each client needs, scripted ────────────────────────────────

const restores: (() => void)[] = [];
function replaceGlobal(target: object, name: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
  restores.push(() => {
    if (original) Object.defineProperty(target, name, original);
    else Reflect.deleteProperty(target, name);
  });
}

class FakeSocket {
  static readonly OPEN = 1;
  static readonly all: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send() {}
  /** The client closing it. */
  close() { this.finish(1000); }
  /** The provider or the network closing it. */
  finish(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

class FakeRecorder {
  static isTypeSupported() { return true; }
  state = "inactive";
  ondataavailable: unknown = null;
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; }
}

class FakeRecognition {
  static readonly all: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() { FakeRecognition.all.push(this); }
  start() {}
  abort() {}
  stop() {}
}

beforeEach(() => {
  FakeSocket.all.length = 0;
  FakeRecognition.all.length = 0;
  replaceGlobal(globalThis, "WebSocket", FakeSocket);
  replaceGlobal(globalThis, "MediaRecorder", FakeRecorder);
  // No audio meter: the client reports it and carries on.
  replaceGlobal(globalThis, "AudioContext", class { constructor() { throw new Error("no audio graph in this test"); } });
  replaceGlobal(console, "warn", () => {});
  replaceGlobal(navigator, "mediaDevices", { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) });
  replaceGlobal(window, "SpeechRecognition", FakeRecognition);
  serviceWorker = new FakeServiceWorkerContainer();
  replaceGlobal(navigator, "serviceWorker", serviceWorker);
});

const roots: BrainUiRoot[] = [];
afterEach(() => {
  cleanup();
  for (const root of roots.splice(0)) root.dispose();
  for (const restore of restores.splice(0).reverse()) restore();
  document.body.innerHTML = "";
});

// ── The update reload guard, as in update-holds.test.tsx ───────────────────

class FakeServiceWorker extends EventTarget {
  state: ServiceWorkerState = "installing";
  install(): void {
    this.state = "installed";
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeServiceWorkerContainer extends EventTarget {
  controller: ServiceWorker | null = null;
  readonly worker = new FakeServiceWorker();
  readonly registration = Object.assign(new EventTarget(), { installing: this.worker as unknown as ServiceWorker });
  async register(): Promise<ServiceWorkerRegistration> {
    return this.registration as unknown as ServiceWorkerRegistration;
  }
  takeControl(): void {
    this.controller = this.worker as unknown as ServiceWorker;
    this.dispatchEvent(new Event("controllerchange"));
  }
}

let serviceWorker: FakeServiceWorkerContainer;

/** An update installed over an existing controller, then taking over. */
function takeOver() {
  act(() => {
    serviceWorker.worker.install();
    serviceWorker.takeControl();
  });
}

// ── The two shipped providers ──────────────────────────────────────────────

type Ending = { name: string; end: () => void };

interface Provider {
  id: "deepgram" | "webspeech";
  /** The provider recognizes words, finally or still interim. */
  hear: (text: string, final: boolean) => void;
  /** Every way this provider ends a dictation on its own. */
  endings: Ending[];
}

const capabilities = { streaming: true, interimResults: true, keyterms: false, endpointing: false };

const socket = () => FakeSocket.all.at(-1)!;
const recognition = () => FakeRecognition.all.at(-1)!;

const deepgram: Provider = {
  id: "deepgram",
  hear(text, final) {
    socket().onmessage?.({ data: JSON.stringify({ type: "Results", is_final: final, speech_final: false, channel: { alternatives: [{ transcript: text }] } }) });
  },
  endings: [
    // Deepgram closes the stream itself: after its idle timeout (1011) or a CloseStream from elsewhere (1000).
    { name: "the stream closes", end: () => socket().finish(1000) },
    { name: "the provider times the stream out", end: () => socket().finish(1011) },
    // The network drops: an error, then an abnormal close.
    { name: "the socket drops", end: () => { socket().onerror?.(); socket().finish(1006); } },
    // The short-lived grant runs out mid-stream.
    { name: "the grant expires", end: () => socket().finish(1008) },
  ],
};

const webspeech: Provider = {
  id: "webspeech",
  hear(text, final) {
    recognition().onresult?.({ resultIndex: 0, results: [{ isFinal: final, 0: { transcript: text } }] });
  },
  endings: [
    // The browser ends recognition on its own after a pause or its own time limit.
    { name: "the recognizer ends", end: () => recognition().onend?.() },
    // A recognition error, which the browser follows with `end`.
    { name: "the recognizer fails", end: () => { recognition().onerror?.({ error: "network" }); recognition().onend?.(); } },
  ],
};

function voiceRoot(provider: Provider) {
  const session: VoiceSessionResponse = {
    providerId: provider.id,
    url: "wss://speech.invalid/v1/listen",
    token: "odysseus-grant",
    expiresAt: Date.now() + 60_000,
    capabilities,
  };
  const api = {
    voiceSession: async () => session,
    voiceOverrides: async () => ({ overrides: [] }),
  } as unknown as BrainApi;
  const root = createBrainUiRoot({ storage: null, api });
  roots.push(root);
  return root;
}

function wrapper(root: BrainUiRoot) {
  return ({ children }: { children: ReactNode }) => <BrainUiProvider root={root}>{children}</BrainUiProvider>;
}

/** The reload guard and a dictation under the same root, an update pending. */
async function mount(root: BrainUiRoot) {
  serviceWorker.controller = {} as ServiceWorker;
  let reloads = 0;
  renderHook(() => useServiceWorkerUpdates({ isBusy: false, reload: () => reloads++ }), { wrapper: wrapper(root) });
  const dictation = renderHook(() => useDictation(), { wrapper: wrapper(root) });
  await act(async () => Promise.resolve());
  return { dictation, reloads: () => reloads };
}

/** start() until the provider's client is live and listening. */
async function listen(root: BrainUiRoot, dictation: { result: { current: ReturnType<typeof useDictation> } }) {
  await act(async () => { await dictation.result.current.start(); });
  // The Deepgram client opens its socket once the microphone is live.
  if (FakeSocket.all.length > 0 && socket().readyState === 0) act(() => { socket().readyState = 1; socket().onopen?.(); });
  const voice = root.stores.voice.getState();
  expect(voice.mode, "the dictation is live").toBe("dictate");
  expect(voice.connecting, "the microphone is open").toBe(false);
}

const voice = (root: BrainUiRoot) => root.stores.voice.getState();

for (const provider of [deepgram, webspeech]) {
  for (const ending of provider.endings) {
    test(`${provider.id}: ${ending.name}, and what was heard waits for review, once, with the reload held throughout`, async () => {
      const root = voiceRoot(provider);
      const { dictation, reloads } = await mount(root);
      await listen(root, dictation);
      act(() => provider.hear("Ask Nestor", true));
      act(() => provider.hear("about the ships", false));
      expect(voice(root).finalText, "the words are heard").toBe("Ask Nestor");
      takeOver();
      expect(reloads(), "no reload while busy: the dictation is live").toBe(0);

      // Every state the store passes through while the provider ends it.
      const seen: { mode: string; finalText: string; partial: string; reviewText: string }[] = [];
      const unsubscribe = root.stores.voice.subscribe((s) => seen.push({ mode: s.mode, finalText: s.finalText, partial: s.partial, reviewText: s.reviewText }));
      act(() => ending.end());
      unsubscribe();

      expect(voice(root).mode, "the provider ended the dictation").toBe("idle");
      expect(voice(root).reviewText, "what was heard waits for review").toBe("Ask Nestor about the ships");
      expect(voice(root).finalText, "nothing is stranded in the capture").toBe("");
      expect(voice(root).partial).toBe("");
      expect(seen.length, "the provider's end changed the store").toBeGreaterThan(0);
      expect(
        seen.filter((s) => s.mode === "idle" && s.reviewText === ""),
        "never idle with the words held by nothing",
      ).toEqual([]);
      expect(reloads(), "no reload while busy: the transcript moved to review").toBe(0);

      // Whatever ends this hook later, the words do not reach review twice.
      await act(async () => { await dictation.result.current.stop(); });
      dictation.unmount();
      expect(voice(root).reviewText, "review holds the words once").toBe("Ask Nestor about the ships");

      act(() => voice(root).clearReview());
      expect(reloads(), "the review card closed: one reload").toBe(1);
    });
  }

  test(`${provider.id}: the words join text already under review`, async () => {
    const root = voiceRoot(provider);
    const { dictation } = await mount(root);
    act(() => voice(root).setReviewText("Twenty trees for the raft."));
    await listen(root, dictation);
    act(() => provider.hear("Lash them with bronze", true));
    act(() => provider.endings[0]!.end());
    expect(voice(root).reviewText).toBe("Twenty trees for the raft. Lash them with bronze");
  });

  test(`${provider.id}: a provider ending with nothing heard leaves the review text as it was and releases the reload`, async () => {
    const root = voiceRoot(provider);
    const { dictation, reloads } = await mount(root);
    await listen(root, dictation);
    takeOver();
    expect(reloads()).toBe(0);
    act(() => provider.endings[0]!.end());
    expect(voice(root).mode).toBe("idle");
    expect(voice(root).reviewText, "nothing to review").toBe("");
    expect(reloads(), "nothing holds it any more: one reload").toBe(1);

    // With a take already under review, it stays exactly as it was.
    const second = voiceRoot(provider);
    const again = await mount(second);
    act(() => voice(second).setReviewText("Twenty trees for the raft."));
    await listen(second, again.dictation);
    act(() => provider.endings[0]!.end());
    expect(voice(second).reviewText).toBe("Twenty trees for the raft.");
  });
}

test("a replaced client ending on its own does not end the dictation that replaced it", async () => {
  const root = voiceRoot(webspeech);
  const { dictation } = await mount(root);
  const other = renderHook(() => useDictation(), { wrapper: wrapper(root) });
  await listen(root, dictation);
  const first = recognition();
  act(() => webspeech.hear("Ask Nestor", true));
  // A second dictation takes the root over; the first recognizer is still running.
  await listen(root, other);
  act(() => webspeech.hear("Sail at dawn", true));
  act(() => first.onend?.());
  expect(voice(root).mode, "the second dictation is still live").toBe("dictate");
  expect(voice(root).finalText, "its words stay in its capture").toBe("Sail at dawn");
  expect(voice(root).reviewText).toBe("");
});

test("a dictation torn down while listening hands what was heard to review, with the reload held", async () => {
  const root = voiceRoot(deepgram);
  const { dictation, reloads } = await mount(root);
  await listen(root, dictation);
  act(() => deepgram.hear("Ask Nestor", true));
  act(() => deepgram.hear("about the ships", false));
  takeOver();
  dictation.unmount();
  expect(voice(root).mode, "the dictation ended with its hook").toBe("idle");
  expect(voice(root).reviewText, "what was heard waits for review").toBe("Ask Nestor about the ships");
  expect(voice(root).finalText).toBe("");
  expect(reloads(), "no reload while busy: the transcript waits for review").toBe(0);
  act(() => voice(root).clearReview());
  expect(reloads(), "one reload").toBe(1);
});

test("words a client reports after its provider ended the dictation are not committed a second time", async () => {
  const root = voiceRoot(webspeech);
  const { dictation } = await mount(root);
  await listen(root, dictation);
  const ended = recognition();
  act(() => webspeech.hear("Ask Nestor", true));
  act(() => ended.onend?.());
  expect(voice(root).reviewText).toBe("Ask Nestor");

  // A client that keeps talking after it ended: nothing would show its words.
  act(() => ended.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "Ask Nestor" } }] }));
  expect(voice(root).finalText, "the ended capture takes no more words").toBe("");
  await act(async () => { await dictation.result.current.stop(); });
  expect(voice(root).reviewText, "review holds the words once").toBe("Ask Nestor");
});

test("a Done after the provider ended the dictation does not reopen it to late words while it drains", async () => {
  const root = voiceRoot(webspeech);
  const { dictation } = await mount(root);
  await listen(root, dictation);
  const ended = recognition();
  act(() => webspeech.hear("Ask Nestor", true));
  act(() => webspeech.hear("about the ships", false));
  act(() => ended.onend?.());
  expect(voice(root).reviewText, "the interim tail went to review with the rest").toBe("Ask Nestor about the ships");

  let stopped!: Promise<void>;
  act(() => { stopped = dictation.result.current.stop(); });
  // The recognizer finalizes the tail it already reported while Done waits on it.
  await act(async () => {
    ended.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "about the ships" } }] });
    ended.onend?.();
    await stopped;
  });
  expect(voice(root).reviewText, "review holds the words once").toBe("Ask Nestor about the ships");
});

for (const end of ["Done", "Cancel"] as const) test(`a dictation ${end} has ended takes no late words`, async () => {
  const root = voiceRoot(deepgram);
  const { dictation } = await mount(root);
  await listen(root, dictation);
  act(() => deepgram.hear("Ask Nestor", true));
  await act(async () => {
    const stopped = dictation.result.current.stop(end === "Done");
    // Deepgram's closing summary settles Done's drain.
    socket().onmessage?.({ data: JSON.stringify({ type: "Metadata" }) });
    await stopped;
  });
  const expected = end === "Done" ? "Ask Nestor" : "";
  expect(voice(root).reviewText).toBe(expected);

  const late = { data: JSON.stringify({ type: "Results", is_final: true, speech_final: false, channel: { alternatives: [{ transcript: "about the ships" }] } }) };
  act(() => socket().onmessage?.(late));
  expect(voice(root).finalText, "the ended capture takes no more words").toBe("");
  await act(async () => { await dictation.result.current.stop(); });
  expect(voice(root).reviewText, "review holds the words once").toBe(expected);
});

test("another dictation ending on its own does not release the reload while a Done is still draining", async () => {
  const root = voiceRoot(webspeech);
  const { dictation: first, reloads } = await mount(root);
  const second = renderHook(() => useDictation(), { wrapper: wrapper(root) });
  await listen(root, first);
  const draining = recognition();
  takeOver();

  // The first dictation's Done waits for its recognizer's last words.
  let stopped!: Promise<void>;
  act(() => { stopped = first.result.current.stop(); });
  expect(voice(root).draining, "the first transcript drains").toBe(true);
  // Meanwhile a second starts, and its provider ends it with nothing heard.
  await listen(root, second);
  act(() => recognition().onend?.());
  expect(voice(root).mode).toBe("idle");
  expect(voice(root).draining, "the first drain still holds").toBe(true);
  expect(reloads(), "no reload while busy: a transcript still drains").toBe(0);

  await act(async () => {
    draining.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "Sail at dawn" } }] });
    draining.onend?.();
    await stopped;
  });
  expect(voice(root).reviewText, "the drained words wait for review").toBe("Sail at dawn");
  expect(reloads(), "no reload while busy: the drain ended in the update that moved its words to review").toBe(0);
  act(() => voice(root).clearReview());
  expect(reloads(), "one reload").toBe(1);
});
