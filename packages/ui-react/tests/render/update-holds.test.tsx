// The service-worker update reload waits for a root's update holds (#1015):
// a live dictation, dictated text under review, a text field's draft, and
// any hold registered through `registerUpdateHold`. Each test drives a real
// `controllerchange` sequence through `useServiceWorkerUpdates` and counts
// reloads through its `reload` test hook, rather than asking the predicate.
// The dictation is the real `useDictation` over a fake ASR client and a
// deferred session request: no microphone and no network.
import { unregisterUpdateHoldsDom } from "./update-holds-dom.js";

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AsrClient, AsrEvent, VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";

import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { BrainApi } from "../../src/lib/api-client.js";
import { useDictation } from "../../src/voice/use-dictation.js";
import { registerUpdateHold, useServiceWorkerUpdates } from "../../src/index.js";

const roots: BrainUiRoot[] = [];
afterEach(() => {
  cleanup();
  for (const root of roots.splice(0)) root.dispose();
  document.body.innerHTML = "";
});
afterAll(unregisterUpdateHoldsDom);

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
beforeEach(() => {
  serviceWorker = new FakeServiceWorkerContainer();
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });
});

/** An update installed over an existing controller, then taking over. */
function takeOver() {
  act(() => {
    serviceWorker.worker.install();
    serviceWorker.takeControl();
  });
}

const session: VoiceSessionResponse = {
  providerId: "fake",
  url: "",
  expiresAt: Date.now() + 60_000,
  capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: false },
};

class FakeClient implements AsrClient {
  constructor(readonly emit: (event: AsrEvent) => void) {}
  drain: (() => void) | null = null;
  async start() {}
  stop() {}
  drainAndStop() { return new Promise<void>((resolve) => { this.drain = resolve; }); }
}

/** A root whose voice session stays pending until the test resolves it. */
function voiceRoot() {
  const sessions: ((s: VoiceSessionResponse) => void)[] = [];
  const clients: FakeClient[] = [];
  const api = {
    voiceSession: () => new Promise<VoiceSessionResponse>((resolve) => { sessions.push(resolve); }),
    voiceOverrides: async () => ({ overrides: [] }),
  } as unknown as BrainApi;
  const root = createBrainUiRoot({ storage: null, api });
  root.asr.register("fake", (opts) => {
    const client = new FakeClient(opts.onEvent);
    clients.push(client);
    return client;
  });
  roots.push(root);
  return { root, sessions, clients };
}

/**
 * The reload guard as a shell mounts it, with the default DOM probe, and
 * dictation beside it under the same root. An existing controller makes the
 * next install an update rather than a first install.
 */
async function mountGuard(root: BrainUiRoot) {
  serviceWorker.controller = {} as ServiceWorker;
  let reloads = 0;
  const hook = renderHook(() => {
    useServiceWorkerUpdates({ isBusy: false, reload: () => reloads++ });
    return useDictation();
  }, { wrapper: ({ children }: { children: ReactNode }) => <BrainUiProvider root={root}>{children}</BrainUiProvider> });
  await act(async () => Promise.resolve());
  return { hook, reloads: () => reloads };
}

/** The composer's empty text field: the DOM probe sees nothing in it. */
function emptyComposer() {
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  return textarea;
}

test("a live dictation holds an update reload until it stops; then it reloads once", async () => {
  const { root, sessions } = voiceRoot();
  emptyComposer();
  const { hook, reloads } = await mountGuard(root);

  let started!: Promise<void>;
  act(() => { started = hook.result.current.start(); });
  expect(root.stores.voice.getState().connecting, "the session is still connecting").toBe(true);
  takeOver();
  expect(reloads(), "no reload while busy: the dictation connects").toBe(0);

  await act(async () => { sessions[0]!(session); await started; });
  expect(root.stores.voice.getState().mode, "the mic is listening").toBe("dictate");
  expect(root.stores.voice.getState().connecting).toBe(false);
  act(() => root.stores.voice.getState().setAudioLevel(0.4));
  expect(reloads(), "no reload while busy: the dictation is live").toBe(0);

  await act(async () => { hook.result.current.cancel(); await Promise.resolve(); });
  expect(root.stores.voice.getState().mode).toBe("idle");
  expect(reloads(), "the dictation stopped: one reload").toBe(1);

  takeOver();
  expect(reloads(), "never a second").toBe(1);
});

test("a dictation draining its transcript after Done holds the reload until it settles", async () => {
  const { root, sessions, clients } = voiceRoot();
  const { hook, reloads } = await mountGuard(root);
  let started!: Promise<void>;
  act(() => { started = hook.result.current.start(); });
  await act(async () => { sessions[0]!(session); await started; });

  let stopped!: Promise<void>;
  act(() => { stopped = hook.result.current.stop(); });
  expect(root.stores.voice.getState().draining, "the transcript is draining").toBe(true);
  takeOver();
  expect(reloads(), "no reload while busy: the transcript drains").toBe(0);

  // Nothing was heard, so nothing waits for review afterwards.
  await act(async () => { clients[0]!.drain!(); await stopped; });
  expect(root.stores.voice.getState().reviewText).toBe("");
  expect(reloads(), "drained and idle: one reload").toBe(1);
});

test("Done hands the transcript to review without a moment in which nothing holds the reload", async () => {
  const { root, sessions, clients } = voiceRoot();
  emptyComposer();
  const { hook, reloads } = await mountGuard(root);
  let started!: Promise<void>;
  act(() => { started = hook.result.current.start(); });
  await act(async () => { sessions[0]!(session); await started; });
  act(() => clients[0]!.emit({ type: "final", text: "Ask Nestor about the ships", endsTurn: false }));
  takeOver();
  expect(reloads()).toBe(0);

  let stopped!: Promise<void>;
  act(() => { stopped = hook.result.current.stop(); });
  await act(async () => { clients[0]!.drain!(); await stopped; });
  expect(root.stores.voice.getState().reviewText, "the transcript waits for review").toBe("Ask Nestor about the ships");
  expect(reloads(), "no reload while busy: the transcript moved from capture to review").toBe(0);

  act(() => root.stores.voice.getState().clearReview());
  expect(reloads(), "the review card closed: one reload").toBe(1);
});

test("dictated text waiting for review holds the reload with the composer's field empty; accepting it releases one reload", async () => {
  const { root } = voiceRoot();
  const field = emptyComposer();
  const { reloads } = await mountGuard(root);
  act(() => root.stores.voice.getState().setReviewText("Ask Nestor about the ships"));
  expect(field.value, "the DOM probe has nothing to see").toBe("");

  takeOver();
  expect(reloads(), "no reload while busy: the transcript is unaccepted").toBe(0);

  act(() => root.stores.voice.getState().clearReview());
  expect(reloads(), "the review card closed: one reload").toBe(1);
});

test("a nonempty text field holds the reload until it is emptied", async () => {
  const { root } = voiceRoot();
  const field = emptyComposer();
  field.value = "Twenty trees for the raft";
  const { reloads } = await mountGuard(root);

  takeOver();
  expect(reloads(), "no reload while busy: the draft is in the field").toBe(0);

  act(() => {
    field.value = "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(reloads(), "the field emptied: one reload").toBe(1);
});

test("a hold registered through registerUpdateHold holds the reload while busy and releases it when idle", async () => {
  const { root } = voiceRoot();
  // A stand-in for a running local recording.
  let recording = true;
  const listeners = new Set<() => void>();
  const release = registerUpdateHold(root, {
    busy: () => recording,
    subscribe: (onChange) => { listeners.add(onChange); return () => listeners.delete(onChange); },
  });
  const { reloads } = await mountGuard(root);

  takeOver();
  expect(reloads(), "no reload while the recording runs").toBe(0);
  act(() => { for (const l of listeners) l(); });
  expect(reloads(), "a change that leaves it busy is no release").toBe(0);

  act(() => { recording = false; for (const l of listeners) l(); });
  expect(reloads(), "the recording stopped: one reload").toBe(1);
  release();
  expect(listeners.size, "releasing the hold unsubscribes it").toBe(0);
});

test("releasing a busy registered hold is itself the transition to idle", async () => {
  const { root } = voiceRoot();
  const release = registerUpdateHold(root, { busy: () => true, subscribe: () => () => {} });
  const { reloads } = await mountGuard(root);
  takeOver();
  expect(reloads()).toBe(0);
  act(() => release());
  expect(reloads(), "the hold is gone: one reload").toBe(1);
});

test("with nothing busy an update takeover reloads once, and a first install never reloads", async () => {
  const { root } = voiceRoot();
  emptyComposer();
  const { reloads } = await mountGuard(root);
  takeOver();
  expect(reloads(), "idle: the update reloads at once").toBe(1);
  takeOver();
  expect(reloads(), "and only once").toBe(1);

  cleanup();
  serviceWorker = new FakeServiceWorkerContainer();
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });
  let firstInstallReloads = 0;
  renderHook(() => useServiceWorkerUpdates({ isBusy: false, reload: () => firstInstallReloads++ }), {
    wrapper: ({ children }: { children: ReactNode }) => <BrainUiProvider root={root}>{children}</BrainUiProvider>,
  });
  await act(async () => Promise.resolve());
  // No controller yet: this is the first install.
  takeOver();
  expect(firstInstallReloads, "a first install never reloads").toBe(0);
});
