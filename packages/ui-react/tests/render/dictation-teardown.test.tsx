// useDictation's effect cleanup (#620) against the mounted hook. The cleanup
// must reach the session and client that exist when it RUNS, not the ones that
// existed when the effect was set up: every start() below happens after mount.
// The ASR client is a fake registered on the root and the session request is a
// deferred promise, so no microphone prompt and no network are involved.
import { unregisterDictationTeardownDom } from "./dictation-teardown-dom.js";

import { afterAll, afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AsrClient, VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";

import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { BrainApi } from "../../src/lib/api-client.js";
import { useDictation } from "../../src/voice/use-dictation.js";

const roots: BrainUiRoot[] = [];
afterEach(() => {
  cleanup();
  for (const root of roots.splice(0)) root.dispose();
});
afterAll(unregisterDictationTeardownDom);

const session: VoiceSessionResponse = {
  providerId: "fake",
  url: "",
  expiresAt: Date.now() + 60_000,
  capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: false },
};

class FakeClient implements AsrClient {
  started = 0;
  stopped = 0;
  drained = 0;
  async start() { this.started++; }
  stop() { this.stopped++; }
  async drainAndStop() { this.drained++; }
}

/** A root whose session request stays pending until the test resolves it. */
function dictationRoot() {
  const requests: { signal: AbortSignal; resolve: (s: VoiceSessionResponse) => void }[] = [];
  const clients: FakeClient[] = [];
  const api = {
    voiceSession: (signal?: AbortSignal) =>
      new Promise<VoiceSessionResponse>((resolve) => {
        requests.push({ signal: signal!, resolve });
      }),
    voiceOverrides: async () => ({ overrides: [] }),
  } as unknown as BrainApi;
  const root = createBrainUiRoot({ storage: null, api });
  root.asr.register("fake", () => {
    const client = new FakeClient();
    clients.push(client);
    return client;
  });
  roots.push(root);
  return { root, requests, clients };
}

function mount(initial: BrainUiRoot) {
  let current = initial;
  const hook = renderHook(() => useDictation(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <BrainUiProvider root={current}>{children}</BrainUiProvider>
    ),
  });
  return {
    ...hook,
    switchRoot(next: BrainUiRoot) {
      current = next;
      hook.rerender();
    },
  };
}

/** start() and resolve its session, leaving capture live. */
async function startCapture(
  hook: ReturnType<typeof mount>,
  target: ReturnType<typeof dictationRoot>,
) {
  let started!: Promise<void>;
  act(() => { started = hook.result.current.start(); });
  expect(target.requests).toHaveLength(1);
  await act(async () => {
    target.requests[0].resolve(session);
    await started;
  });
  expect(target.clients).toHaveLength(1);
  expect(target.clients[0].started).toBe(1);
  expect(target.root.stores.voice.getState().connecting).toBe(false);
  return target.clients[0];
}

test("unmount aborts a pending session request and no client opens after it resolves", async () => {
  const a = dictationRoot();
  const hook = mount(a.root);
  let started!: Promise<void>;
  act(() => { started = hook.result.current.start(); });
  expect(a.requests).toHaveLength(1);
  expect(a.requests[0].signal.aborted).toBe(false);

  hook.unmount();
  expect(a.requests[0].signal.aborted).toBe(true);

  // The fake ignores the abort and resolves anyway, so only the generation
  // guard stands between this session and a client opening the mic.
  a.requests[0].resolve(session);
  await started;
  expect(a.clients).toHaveLength(0);
});

test("unmount stops a client created after the effect was set up", async () => {
  const a = dictationRoot();
  const hook = mount(a.root);
  const client = await startCapture(hook, a);
  expect(client.stopped).toBe(0);

  hook.unmount();
  expect(client.stopped).toBe(1);
  expect(client.drained).toBe(0);
});

test("a root change tears down the old root's capture and the new root owns the next one", async () => {
  const a = dictationRoot();
  const b = dictationRoot();
  const hook = mount(a.root);
  const first = await startCapture(hook, a);

  act(() => hook.switchRoot(b.root));
  expect(first.stopped).toBe(1);

  const second = await startCapture(hook, b);
  expect(a.clients).toHaveLength(1);
  expect(second.stopped).toBe(0);

  hook.unmount();
  expect(second.stopped).toBe(1);
  expect(first.stopped).toBe(1);
});

test("a root change while the session is pending aborts it and opens nothing on either root", async () => {
  const a = dictationRoot();
  const b = dictationRoot();
  const hook = mount(a.root);
  let started!: Promise<void>;
  act(() => { started = hook.result.current.start(); });
  expect(a.requests).toHaveLength(1);

  act(() => hook.switchRoot(b.root));
  expect(a.requests[0].signal.aborted).toBe(true);

  a.requests[0].resolve(session);
  await started;
  expect(a.clients).toHaveLength(0);
  expect(b.clients).toHaveLength(0);
});

test("Stop still drains the live client into review after the refactor", async () => {
  const a = dictationRoot();
  const hook = mount(a.root);
  const client = await startCapture(hook, a);
  act(() => { a.root.stores.voice.getState().appendFinal("hello"); });

  await act(() => hook.result.current.stop());
  expect(client.drained).toBe(1);
  expect(client.stopped).toBe(0);
  expect(a.root.stores.voice.getState().reviewText).toBe("hello");

  // Nothing left for the cleanup to close.
  hook.unmount();
  expect(client.stopped).toBe(0);
});
