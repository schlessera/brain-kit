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
  fail: ((error: Error) => void) | null = null;
  async start() {}
  stop() {}
  drainAndStop() { return new Promise<void>((resolve, reject) => { this.drain = resolve; this.fail = reject; }); }
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

for (const phase of ["connecting", "listening"] as const) test(`a dictation torn down while ${phase} stops holding the reload; review text stays`, async () => {
  const { root, sessions } = voiceRoot();
  const { reloads } = await mountGuard(root);
  // The dictation is mounted apart from the guard, as a composer is.
  const dictation = renderHook(() => useDictation(), {
    wrapper: ({ children }: { children: ReactNode }) => <BrainUiProvider root={root}>{children}</BrainUiProvider>,
  });
  let started!: Promise<void>;
  act(() => { started = dictation.result.current.start(); });
  if (phase === "listening") await act(async () => { sessions[0]!(session); await started; });
  takeOver();
  expect(reloads(), `no reload while busy: the dictation is ${phase}`).toBe(0);

  act(() => root.stores.voice.getState().setReviewText("Earlier take"));
  dictation.unmount();
  expect(root.stores.voice.getState().mode, "the dictation ended with its hook").toBe("idle");
  expect(reloads(), "review text still holds it").toBe(0);
  act(() => root.stores.voice.getState().clearReview());
  expect(reloads(), "nothing holds it any more: one reload").toBe(1);
});

/** A dictation mounted apart from the guard, as a composer is. */
function mountDictation(initial: BrainUiRoot) {
  let current = initial;
  const hook = renderHook(() => useDictation(), {
    wrapper: ({ children }: { children: ReactNode }) => <BrainUiProvider root={current}>{children}</BrainUiProvider>,
  });
  return Object.assign(hook, { switchRoot(next: BrainUiRoot) { current = next; hook.rerender(); } });
}

for (const torn of [false, true]) test(`Done hands the transcript to review, words heard while it drains included, without a moment in which nothing holds the reload${torn ? ", even when the dictation is torn down mid-drain" : ""}`, async () => {
  const { root, sessions, clients } = voiceRoot();
  emptyComposer();
  const { reloads } = await mountGuard(root);
  const dictation = mountDictation(root);
  let started!: Promise<void>;
  act(() => { started = dictation.result.current.start(); });
  await act(async () => { sessions[0]!(session); await started; });
  act(() => clients[0]!.emit({ type: "final", text: "Ask Nestor", endsTurn: false }));
  takeOver();
  expect(reloads()).toBe(0);

  let stopped!: Promise<void>;
  act(() => { stopped = dictation.result.current.stop(); });
  act(() => clients[0]!.emit({ type: "final", text: "about the ships", endsTurn: false }));
  if (torn) dictation.unmount();
  expect(reloads(), "no reload while busy: the transcript still drains").toBe(0);
  await act(async () => { clients[0]!.drain!(); await stopped; });
  expect(root.stores.voice.getState().reviewText, "the whole transcript waits for review").toBe("Ask Nestor about the ships");
  expect(root.stores.voice.getState().mode).toBe("idle");
  expect(reloads(), "no reload while busy: the transcript moved from capture to review").toBe(0);

  act(() => root.stores.voice.getState().clearReview());
  expect(reloads(), "the review card closed: one reload").toBe(1);
});

test("a field's text holds the reload while a replaced root's dictation is torn down", async () => {
  const ithaca = voiceRoot();
  const pylos = voiceRoot();
  const field = emptyComposer();
  field.value = "Twenty trees for the raft";
  serviceWorker.controller = {} as ServiceWorker;
  let reloads = 0;
  let current = ithaca.root;
  // Dictation first, as a composer that also hosts the guard would: its
  // teardown runs before the guard rebinds to the new root.
  const hook = renderHook(() => {
    const dictation = useDictation();
    useServiceWorkerUpdates({ isBusy: false, reload: () => reloads++ });
    return dictation;
  }, { wrapper: ({ children }: { children: ReactNode }) => <BrainUiProvider root={current}>{children}</BrainUiProvider> });
  await act(async () => Promise.resolve());
  act(() => { void hook.result.current.start(); });
  takeOver();
  expect(reloads).toBe(0);

  current = pylos.root;
  act(() => hook.rerender());
  expect(ithaca.root.stores.voice.getState().mode, "Ithaca's dictation ended with the switch").toBe("idle");
  expect(reloads, "no reload while busy: the field still holds text").toBe(0);
  act(() => {
    field.value = "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(reloads, "the field emptied: one reload").toBe(1);
});

test("a drain that fails still hands what was heard to review and ends the dictation", async () => {
  const { root, sessions, clients } = voiceRoot();
  const { reloads } = await mountGuard(root);
  const dictation = mountDictation(root);
  let started!: Promise<void>;
  act(() => { started = dictation.result.current.start(); });
  await act(async () => { sessions[0]!(session); await started; });
  act(() => clients[0]!.emit({ type: "final", text: "Ask Nestor about the ships", endsTurn: false }));
  takeOver();
  let stopped!: Promise<void>;
  act(() => { stopped = dictation.result.current.stop(); });
  dictation.unmount();
  let failure: unknown = null;
  await act(async () => { clients[0]!.fail!(new Error("socket closed")); await stopped.catch((error) => { failure = error; }); });
  expect((failure as Error | null)?.message, "the failure is not swallowed").toBe("socket closed");
  expect(root.stores.voice.getState().mode, "the dictation ended").toBe("idle");
  expect(root.stores.voice.getState().reviewText, "what was heard waits for review").toBe("Ask Nestor about the ships");
  expect(reloads(), "no reload while busy: the transcript waits for review").toBe(0);
  act(() => root.stores.voice.getState().clearReview());
  expect(reloads(), "nothing holds it: one reload").toBe(1);
});

test("tearing down one dictation hook leaves a dictation another hook started on the same root live", async () => {
  const { root, sessions } = voiceRoot();
  const { reloads } = await mountGuard(root);
  const first = mountDictation(root);
  const second = mountDictation(root);
  let started!: Promise<void>;
  act(() => { started = first.result.current.start(); });
  await act(async () => { sessions[0]!(session); await started; });
  act(() => { started = second.result.current.start(); });
  await act(async () => { sessions[1]!(session); await started; });
  takeOver();

  first.unmount();
  expect(root.stores.voice.getState().mode, "the second dictation is still live").toBe("dictate");
  expect(reloads(), "no reload while busy: the second dictation is live").toBe(0);
  await act(async () => { second.result.current.cancel(); await Promise.resolve(); });
  expect(reloads(), "the second dictation stopped: one reload").toBe(1);
});

test("an old root's drain settling does not leave a newer root's dictation unable to end", async () => {
  const ithaca = voiceRoot();
  const pylos = voiceRoot();
  const { reloads } = await mountGuard(pylos.root);
  const dictation = mountDictation(ithaca.root);
  let started!: Promise<void>;
  act(() => { started = dictation.result.current.start(); });
  await act(async () => { ithaca.sessions[0]!(session); await started; });
  let stopped!: Promise<void>;
  act(() => { stopped = dictation.result.current.stop(); });

  dictation.switchRoot(pylos.root);
  act(() => { started = dictation.result.current.start(); });
  await act(async () => { pylos.sessions[0]!(session); await started; });
  takeOver();
  await act(async () => { ithaca.clients[0]!.drain!(); await stopped; });
  expect(reloads(), "no reload while busy: Pylos is dictating").toBe(0);

  dictation.unmount();
  expect(pylos.root.stores.voice.getState().mode, "Pylos's dictation ended with its hook").toBe("idle");
  expect(reloads(), "nothing holds it: one reload").toBe(1);
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
