import { afterEach, describe, expect, test } from "bun:test";
import { CONVERSATION_LIMITS, type ClientMessage, type ConversationCapabilities, type ConversationProfile } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../src/root.js";
import { createConversationClient } from "../src/voice/conversation-client.js";

const CAPS: ConversationCapabilities = {
  nonblockingWork: "supported",
  manualEndpoint: "supported",
  finalTranscript: "unproven",
  remoteOutputCancelAck: "unproven",
  exactPermissionSpeech: "unproven",
  echoIsolatedInput: "unproven",
  outputWordAlignment: "unproven",
};

const PROFILE: ConversationProfile = {
  providerId: "gpt-live",
  capabilities: CAPS,
  disclosure: {
    voiceService: "Odysseus voice fixture",
    destinations: ["Audio and transcripts: fixture voice API."],
  },
};

class FakeWakeLockSentinel extends EventTarget {
  released = false;
  releaseCalls = 0;
  readonly type = "screen" as const;

  async release(): Promise<void> {
    this.releaseCalls++;
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  }

  /** Simulate the browser/OS revoking the wake lock externally (e.g. page hidden). */
  revokeExternally(): void {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  }
}

class FakeDocument extends EventTarget {
  hidden = false;
  get visibilityState(): DocumentVisibilityState {
    return this.hidden ? "hidden" : "visible";
  }
  setHidden(value: boolean) {
    this.hidden = value;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

const restores: Array<() => void> = [];
const roots: BrainUiRoot[] = [];

function replaceGlobal(target: object, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else Reflect.deleteProperty(target, key);
  });
}

function setupEnv(options: { getUserMedia?: () => Promise<unknown> } = {}) {
  const doc = new FakeDocument();
  const sentinels: FakeWakeLockSentinel[] = [];
  const requestedTypes: string[] = [];

  replaceGlobal(globalThis, "document", doc);
  replaceGlobal(globalThis, "navigator", {
    wakeLock: {
      request: async (type: string) => {
        requestedTypes.push(type);
        const sentinel = new FakeWakeLockSentinel();
        sentinels.push(sentinel);
        return sentinel;
      },
    },
    ...(options.getUserMedia ? { mediaDevices: { getUserMedia: options.getUserMedia } } : {}),
  });

  const root = createBrainUiRoot({ storage: null });
  roots.push(root);
  root.stores.connection.getState().setWsStatus("connected");

  const sent: ClientMessage[] = [];
  const client = createConversationClient(
    root,
    (msg) => {
      sent.push(msg);
      return true;
    },
    () => false,
  );
  restores.push(() => client.dispose());
  client.frame({
    type: "server_hello",
    protocolRev: 5,
    principalKey: "odysseus",
    capabilities: { liveConversation: true, conversationPause: true },
    conversationProfile: PROFILE,
  });

  return { root, client, doc, sentinels, requestedTypes, sent };
}

async function flushMicrotasks() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

afterEach(() => {
  for (const root of roots.splice(0)) root.dispose();
  for (const restore of restores.splice(0).reverse()) restore();
});

describe("live conversation screen wake lock", () => {
  test("acquires on start (not on enter), holds across mute and suspend, re-acquires on visibility return, and releases on leave", async () => {
    const { root, client, doc, sentinels, requestedTypes } = setupEnv();

    client.enter();
    await flushMicrotasks();
    expect(requestedTypes).toEqual([]);

    client.start();
    await flushMicrotasks();
    expect(requestedTypes).toEqual(["screen"]);
    expect(sentinels).toHaveLength(1);
    expect(sentinels[0]!.released).toBe(false);

    // Muting inside an active conversation keeps the screen awake.
    client.mute();
    await flushMicrotasks();
    expect(sentinels[0]!.released).toBe(false);
    expect(sentinels).toHaveLength(1);

    // Transient transport disconnect (suspend) preserves the wake lock.
    root.stores.connection.getState().setWsStatus("disconnected");
    await flushMicrotasks();
    expect(sentinels[0]!.released).toBe(false);
    expect(sentinels).toHaveLength(1);

    root.stores.connection.getState().setWsStatus("connected");
    client.frame({
      type: "server_hello",
      protocolRev: 5,
      principalKey: "odysseus",
      capabilities: { liveConversation: true, conversationPause: true },
      conversationProfile: PROFILE,
    });
    await flushMicrotasks();
    expect(sentinels[0]!.released).toBe(false);

    // Hiding the page lets the OS revoke the sentinel; returning re-acquires it.
    sentinels[0]!.revokeExternally();
    doc.setHidden(true);
    await flushMicrotasks();
    expect(sentinels).toHaveLength(1);

    doc.setHidden(false);
    await flushMicrotasks();
    expect(sentinels).toHaveLength(2);
    expect(sentinels[1]!.released).toBe(false);

    // Leaving releases the sentinel and stops re-acquiring on visibility change.
    client.leave();
    await flushMicrotasks();
    expect(sentinels[1]!.released).toBe(true);

    doc.setHidden(true);
    doc.setHidden(false);
    await flushMicrotasks();
    expect(sentinels).toHaveLength(2);
  });

  test("releases on disclosure invalidation, principal change, dispose, and mic failure, then re-acquires on resume", async () => {
    let failMic = true;
    const { client, sentinels, sent } = setupEnv({
      getUserMedia: async () => {
        if (failMic) throw new DOMException("Permission denied", "NotAllowedError");
        return new Promise(() => {});
      },
    });

    client.enter();
    client.start();
    await flushMicrotasks();
    expect(sentinels).toHaveLength(1);
    expect(sentinels[0]!.released).toBe(false);

    const startMsg = sent.find((m) => m.type === "conversation_start");
    expect(startMsg?.type).toBe("conversation_start");
    const requestId = startMsg?.type === "conversation_start" ? startMsg.requestId : undefined;

    // Open an epoch and signal ready so capture() runs and fails with NotAllowedError -> capture === "stopped".
    const opened = {
      type: "conversation_opened" as const,
      conversationId: "ithaca-voice",
      epoch: 1,
      requestId,
      providerId: PROFILE.providerId,
      capabilities: CAPS,
      disclosure: PROFILE.disclosure,
      limits: { ...CONVERSATION_LIMITS },
      resync: { work: 0, outputs: 0 },
    };
    client.receive(opened);
    client.receive({
      type: "conversation_event",
      conversationId: "ithaca-voice",
      epoch: 1,
      event: {
        kind: "ready",
        input: { encoding: "pcm16", channels: 1, sampleRate: 24000 },
        output: { encoding: "pcm16", channels: 1, sampleRate: 24000 },
      },
    });
    await flushMicrotasks();
    expect(client.state.getState().capture).toBe("stopped");
    expect(sentinels[0]!.released).toBe(true);

    // Explicit resume re-acquires the wake lock.
    failMic = false;
    client.resume();
    await flushMicrotasks();
    expect(client.state.getState().capture).toBe("listening");
    expect(sentinels).toHaveLength(2);
    expect(sentinels[1]!.released).toBe(false);
    client.leave();
    await flushMicrotasks();
    expect(sentinels[1]!.released).toBe(true);

    // Disclosure change releases wake lock even while muted.
    const env2 = setupEnv();
    env2.client.enter();
    env2.client.start();
    await flushMicrotasks();
    expect(env2.sentinels).toHaveLength(1);
    env2.client.mute();
    await flushMicrotasks();
    expect(env2.sentinels[0]!.released).toBe(false);

    env2.client.frame({
      type: "server_hello",
      protocolRev: 5,
      principalKey: "odysseus",
      capabilities: { liveConversation: true, conversationPause: true },
      conversationProfile: {
        ...PROFILE,
        disclosure: { voiceService: "Changed fixture", destinations: ["New destination."] },
      },
    });
    await flushMicrotasks();
    expect(env2.sentinels[0]!.released).toBe(true);

    // Principal change clears private dialogue and releases wake lock.
    const env3 = setupEnv();
    env3.client.enter();
    env3.client.start();
    await flushMicrotasks();
    expect(env3.sentinels).toHaveLength(1);
    expect(env3.sentinels[0]!.released).toBe(false);
    env3.client.frame({
      type: "server_hello",
      protocolRev: 5,
      principalKey: "penelope",
      capabilities: { liveConversation: true, conversationPause: true },
      conversationProfile: PROFILE,
    });
    await flushMicrotasks();
    expect(env3.sentinels[0]!.released).toBe(true);

    // Dispose releases wake lock.
    const env4 = setupEnv();
    env4.client.enter();
    env4.client.start();
    await flushMicrotasks();
    expect(env4.sentinels).toHaveLength(1);
    expect(env4.sentinels[0]!.released).toBe(false);
    env4.client.dispose();
    await flushMicrotasks();
    expect(env4.sentinels[0]!.released).toBe(true);
  });
});
