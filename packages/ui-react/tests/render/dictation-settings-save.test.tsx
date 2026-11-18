// Settings › Voice writes and what the next take uses (#3709 review fixes).
// The pane is mounted against a root whose discovery, settings write and
// session answers the test controls; no microphone, no network. The
// real-browser proof against mounted routes is dictation-selection-runtime.test.ts.
import { unregisterDictationSettingsSaveDom } from "./dictation-settings-save-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AsrClient, VoiceSessionResponse } from "@schlessera/brain-ui-sdk/client";
import type { DictationSettings as Settings, VoiceProvidersResponse, VoiceSessionRequest } from "@schlessera/brain-ui-sdk/protocol";

import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ApiRequestError, type BrainApi } from "../../src/lib/api-client.js";
import { useDictation } from "../../src/voice/use-dictation.js";
import { acknowledge, providerDestination, providerLabel, providerShortLabel } from "../../src/voice/dictation-providers.js";
import { DictationSettings } from "../../src/components/settings/dictation-settings.js";

const roots: BrainUiRoot[] = [];
afterEach(() => {
  cleanup();
  for (const root of roots.splice(0)) root.dispose();
});
afterAll(unregisterDictationSettingsSaveDom);

const streaming = { streaming: true, interimResults: true, keyterms: false, endpointing: false };
const ALPHA = { id: "alpha", label: "Alpha Transcribe", destination: "Microphone audio streams from this browser to Alpha.", capabilities: { ...streaming, savedAudio: true, smartTranscription: false } };
const BETA = { id: "beta", label: "Beta Live", destination: "Microphone audio streams from this browser to Beta.", capabilities: { ...streaming, savedAudio: false, smartTranscription: true } };
const discovery = (saved: string | null, revision: string): VoiceProvidersResponse => ({
  providers: [ALPHA, BETA],
  dictation: { saved, savedUsable: saved !== null, host: null, effective: saved, source: saved ? "saved" : "none", smart: true, revision },
});

class FakeClient implements AsrClient {
  constructor(readonly providerId: string) {}
  async start() {}
  stop() {}
  async drainAndStop() {}
}

type Put = { settings: Settings; resolve: (value: Settings) => void; reject: (error: unknown) => void };

/**
 * A root whose server holds `state.saved`. Reads fail while `state.readsFail`;
 * writes answer at once unless `state.holdWrites`, and fail with `state.writeError`.
 */
function settingsRoot(account: string | null = "odysseus") {
  const state = { saved: "alpha" as string | null, revision: 1, readsFail: false, holdWrites: false, writeError: null as unknown };
  const puts: Put[] = [];
  const sessions: Array<VoiceSessionRequest | undefined> = [];
  const api = {
    voiceProviders: async () => {
      if (state.readsFail) throw new TypeError("Failed to fetch");
      return discovery(state.saved, String(state.revision));
    },
    saveDictationSettings: (settings: Settings) => new Promise<Settings>((resolve, reject) => {
      const put: Put = { settings, resolve, reject };
      puts.push(put);
      if (state.holdWrites) return;
      if (state.writeError) { reject(state.writeError); return; }
      state.saved = settings.defaultProvider; state.revision++;
      resolve({ defaultProvider: settings.defaultProvider, smart: settings.smart, revision: String(state.revision) });
    }),
    voiceSession: async (_signal?: AbortSignal, request?: VoiceSessionRequest): Promise<VoiceSessionResponse> => {
      sessions.push(request);
      return { providerId: request!.providerId!, url: "", expiresAt: Date.now() + 60_000, capabilities: streaming };
    },
    voiceOverrides: async () => ({ overrides: [] }),
    status: async () => ({ contentRenderers: [] }),
  } as unknown as BrainApi;
  const root = createBrainUiRoot({ storage: null, api });
  for (const id of ["alpha", "beta"]) root.asr.register(id, () => new FakeClient(id));
  // The authenticated probe has run; it names an account only for the owner.
  root.stores.connection.getState().setVpnStatus("connected", account);
  acknowledge(root, ALPHA); acknowledge(root, BETA);
  roots.push(root);
  return { root, state, puts, sessions };
}

const wrapper = (root: BrainUiRoot) => ({ children }: { children: ReactNode }) => <BrainUiProvider root={root}>{children}</BrainUiProvider>;
function pane(root: BrainUiRoot) {
  const view = render(<DictationSettings active />, { wrapper: wrapper(root) });
  return {
    ...view,
    radio: (id: string) => view.container.querySelector<HTMLInputElement>(`input[type="radio"][value="${id}"]`)!,
    text: () => view.container.textContent ?? "",
    reopen: async () => {
      await act(async () => { view.rerender(<DictationSettings active={false} />); });
      await act(async () => { view.rerender(<DictationSettings active />); });
      await settle();
    },
  };
}
/** Lets the pane's reads and writes, which resolve on microtasks, finish. */
async function settle() { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function takeOnce(root: BrainUiRoot) {
  const hook = renderHook(() => useDictation(), { wrapper: wrapper(root) });
  await act(async () => { await hook.result.current.start(); });
  await act(async () => { hook.result.current.cancel(); });
  hook.unmount();
}

describe("a confirmed save is what the next take uses", () => {
  test("a save whose follow-up read fails is shown, says the read failed, and no take uses the older snapshot", async () => {
    const s = settingsRoot();
    const view = pane(s.root);
    await settle();
    expect(view.radio("alpha").checked).toBe(true);

    s.state.readsFail = true;
    await act(async () => { fireEvent.click(view.radio("beta")); });
    await settle();
    expect(s.puts.map((put) => put.settings.defaultProvider)).toEqual(["beta"]);
    expect(view.radio("beta").checked, "SAVED_CHOICE_IS_SHOWN").toBe(true);
    expect(view.text(), "REFRESH_FAILURE_IS_SHOWN").toContain("Couldn't check the dictation services just now. What's shown may be out of date.");

    // A take while discovery still cannot be read: nothing, and above all not Alpha.
    await takeOnce(s.root);
    expect(s.sessions.map((request) => request?.providerId), "NO_TAKE_USES_THE_OBSOLETE_SNAPSHOT").toEqual([]);

    s.state.readsFail = false;
    await takeOnce(s.root);
    expect(s.sessions.map((request) => request?.providerId), "TAKE_AFTER_SAVE_USES_CONFIRMED_PROVIDER").toEqual(["beta"]);
  });

  test("a stale revision whose re-read fails never claims to show the current choice", async () => {
    const s = settingsRoot();
    const view = pane(s.root);
    await settle();
    s.state.readsFail = true;
    s.state.writeError = new ApiRequestError("dictation_settings_stale", 409);
    await act(async () => { fireEvent.click(view.radio("beta")); });
    await settle();
    expect(view.text()).toContain("Changed on another device.");
    expect(view.text(), "STALE_IS_NOT_DESCRIBED_AS_CURRENT").not.toContain("Showing the current choice");
    expect(view.text(), "STALE_REFRESH_FAILURE_IS_SHOWN").toContain("Couldn't check the dictation services just now.");

    // Once the server can be read, the current choice is shown and named as such.
    s.state.readsFail = false;
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Try again" })); });
    await settle();
    expect(view.text()).toContain("Changed on another device. Showing the current choice.");
    expect(view.text()).not.toContain("Couldn't check");
  });
});

describe("writes belong to the root, not to the open pane", () => {
  test("a choice queued behind a slow save is written after Settings closes", async () => {
    const s = settingsRoot();
    const view = pane(s.root);
    await settle();
    s.state.holdWrites = true;
    await act(async () => { fireEvent.click(view.radio("beta")); });
    await act(async () => { fireEvent.click(view.radio("alpha")); });
    expect(s.puts).toHaveLength(1);

    // Close the pane, then unmount it, while Beta's write is still on its way.
    await act(async () => { view.rerender(<DictationSettings active={false} />); });
    view.unmount();
    s.state.holdWrites = false;
    await act(async () => { s.state.saved = "beta"; s.state.revision++; s.puts[0]!.resolve({ defaultProvider: "beta", smart: true, revision: String(s.state.revision) }); });
    await settle();
    expect(s.puts.map((put) => put.settings.defaultProvider), "QUEUED_CHOICE_SURVIVES_CLOSE").toEqual(["beta", "alpha"]);
    expect(s.puts.map((put) => put.settings.revision), "each write is made against the newest revision").toEqual(["1", "2"]);
    expect(s.state.saved).toBe("alpha");
  });
});

describe("a queued choice belongs to the identity that made it", () => {
  /** Beta's write held on its way, Alpha queued behind it. */
  async function queued() {
    const s = settingsRoot();
    const view = pane(s.root);
    await settle();
    s.state.holdWrites = true;
    await act(async () => { fireEvent.click(view.radio("beta")); });
    await act(async () => { fireEvent.click(view.radio("alpha")); });
    expect(s.puts.map((put) => put.settings.defaultProvider)).toEqual(["beta"]);
    s.state.holdWrites = false;
    return { ...s, view };
  }

  test("an account change ends the queue: the queued choice is never written for the new account", async () => {
    const s = await queued();
    await act(async () => { s.root.stores.connection.getState().setVpnStatus("connected", "penelope"); });
    const pendingAtChange = s.root.stores.voice.getState().dictationSave.pending;
    await act(async () => { s.puts[0]!.resolve({ defaultProvider: "beta", smart: true, revision: "2" }); });
    await settle();
    expect(s.puts.map((put) => put.settings.defaultProvider), "QUEUED_CHOICE_DIES_WITH_ACCOUNT").toEqual(["beta"]);
    expect(pendingAtChange, "QUEUE_CLEARED_ON_ACCOUNT_CHANGE").toBeNull();
    expect(s.view.text(), "nothing is said to be saving").not.toContain("Saving");
  });

  test("auth loss ends the queue: nothing more is written and no failure is reported", async () => {
    const s = await queued();
    await act(async () => { await s.root.authLock.expire(); });
    const pendingAtLoss = s.root.stores.voice.getState().dictationSave.pending;
    await act(async () => { s.puts[0]!.reject(new TypeError("Failed to fetch")); });
    await settle();
    expect(s.puts.map((put) => put.settings.defaultProvider)).toEqual(["beta"]);
    expect(s.root.stores.voice.getState().dictationSave.status, "AUTH_LOSS_IS_NOT_A_SAVE_FAILURE").toBeNull();
    expect(pendingAtLoss, "QUEUE_CLEARED_ON_AUTH_LOSS").toBeNull();
  });

  test("disposing the root ends the queue: a failed earlier write never moves on to the queued choice", async () => {
    const s = await queued();
    s.view.unmount();
    roots.splice(roots.indexOf(s.root), 1);
    s.root.dispose();
    await act(async () => { s.puts[0]!.reject(new TypeError("Failed to fetch")); });
    await settle();
    expect(s.puts.map((put) => put.settings.defaultProvider), "QUEUED_CHOICE_DIES_WITH_ROOT").toEqual(["beta"]);
  });
});

describe("authority comes before the controls", () => {
  test("a principal the probe names no account for sees read-only controls before any save", async () => {
    const s = settingsRoot(null);
    const view = pane(s.root);
    await settle();
    const radios = [...view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.length).toBe(2);
    expect(radios.map((radio) => radio.disabled), "READ_ONLY_BEFORE_ANY_SAVE").toEqual([true, true]);
    expect(view.text()).toContain("Only the owner can change this.");
    await act(async () => { fireEvent.click(view.radio("beta")); });
    await settle();
    expect(s.puts, "no write is attempted").toHaveLength(0);
  });

  test("mounted without the connection gate, the pane asks the same probe before enabling anything", async () => {
    for (const [answer, owner] of [[{ vpn: true, accountKey: "odysseus-owner" }, true], [{ vpn: true }, false]] as const) {
      const s = settingsRoot(null);
      // Nothing has probed on this root yet.
      s.root.stores.connection.setState({ vpnStatus: "checking", accountKey: null });
      const probes: string[] = [];
      s.root.request = async (url: string) => { probes.push(url); return Response.json(answer); };
      const view = pane(s.root);
      await settle();
      expect(probes.filter((url) => url.endsWith("/api/vpn-check")), "the existing probe, once").toHaveLength(1);
      expect(view.radio("beta").disabled, owner ? "an owner may choose" : "anyone else may not").toBe(!owner);
      expect(view.text().includes("Only the owner can change this."), "the reason is shown only to a non-owner").toBe(!owner);
      cleanup();
    }
  });

  /** A root mounted without the connection gate: the pane's own probe answers `probe.answer`. */
  function standalone() {
    const s = settingsRoot(null);
    s.root.stores.connection.setState({ vpnStatus: "checking", accountKey: null });
    const probe = { answer: { vpn: true, accountKey: "odysseus-owner" } as Record<string, unknown>, hold: false, count: 0 };
    s.root.request = async () => {
      probe.count++;
      return probe.hold ? new Promise<Response>(() => {}) : Response.json(probe.answer);
    };
    return { ...s, probe };
  }

  test("a standalone refusal holds for the account the probe named, not for whoever probes next", async () => {
    const s = standalone();
    s.state.writeError = new ApiRequestError("owner_required", 403);
    const view = pane(s.root);
    await settle();
    await act(async () => { fireEvent.click(view.radio("beta")); });
    await settle();
    expect(view.text()).toContain("Only the owner can change this.");
    // The same account probes again: still refused.
    await view.reopen();
    expect(view.radio("beta").disabled, "REFUSAL_HOLDS_FOR_SAME_ACCOUNT").toBe(true);
    // Another account is signed in on this browser; its probe names it as owner.
    s.state.writeError = null;
    s.probe.answer = { vpn: true, accountKey: "penelope-owner" };
    await view.reopen();
    expect(view.radio("beta").disabled, "REFUSAL_IS_SCOPED_TO_THE_REFUSED_ACCOUNT").toBe(false);
    expect(view.text()).not.toContain("Only the owner can change this.");
    await act(async () => { fireEvent.click(view.radio("beta")); });
    await settle();
    expect(s.puts.map((put) => put.settings.defaultProvider)).toEqual(["beta", "beta"]);
  });

  test("a standalone probe's authority ends with its auth generation", async () => {
    const s = standalone();
    const view = pane(s.root);
    await settle();
    expect(view.radio("beta").disabled, "the owner probe enables the controls").toBe(false);
    // Sign-in state moves on (a lock); the next probe has not answered yet.
    s.probe.hold = true;
    s.root.stores.connection.setState({ wsStatus: "connected" });
    await act(async () => { await s.root.authLock.expire(); });
    await settle();
    expect(s.root.authLock.state.getState().phase).toBe("locked");
    expect(view.radio("beta").disabled, "EARLIER_PROBE_ENDS_WITH_GENERATION").toBe(true);
    expect(s.probe.count, "the new generation asks again").toBe(2);
  });

  test("a standalone probe's authority ends with an account change", async () => {
    const s = standalone();
    const view = pane(s.root);
    await settle();
    expect(view.radio("beta").disabled, "the owner probe enables the controls").toBe(false);
    // Another account comes and goes on the connection; the next probe has not answered.
    s.probe.hold = true;
    await act(async () => { s.root.stores.connection.setState({ accountKey: "penelope" }); });
    await act(async () => { s.root.stores.connection.setState({ accountKey: null }); });
    await settle();
    expect(view.radio("beta").disabled, "EARLIER_PROBE_ENDS_WITH_ACCOUNT_CHANGE").toBe(true);
  });

  test("a refused save stays read-only when Settings is opened again", async () => {
    const s = settingsRoot();
    s.state.writeError = new ApiRequestError("owner_required", 403);
    const view = pane(s.root);
    await settle();
    await act(async () => { fireEvent.click(view.radio("beta")); });
    await settle();
    expect(view.text()).toContain("Only the owner can change this.");
    await view.reopen();
    expect(view.text(), "READ_ONLY_SURVIVES_REOPEN").toContain("Only the owner can change this.");
    expect(view.radio("beta").disabled).toBe(true);
    expect(view.radio("alpha").checked, "the server value stands").toBe(true);
  });
});

describe("names and destinations prefer what the server sends", () => {
  test("a built-in's own fallback applies only when the server sent no label or destination", () => {
    const bare = { id: "deepgram", label: "deepgram", capabilities: streaming };
    expect(providerLabel(bare)).toBe("Deepgram");
    expect(providerShortLabel(bare)).toBe("Deepgram");
    expect(providerDestination(bare)).toBe("While you speak, microphone audio streams from this browser to Deepgram.");
    const described = { id: "deepgram", label: "Deepgram Nova-3", destination: "Audio streams to Deepgram's EU region.", capabilities: streaming };
    expect(providerLabel(described)).toBe("Deepgram Nova-3");
    expect(providerShortLabel(described), "SERVER_LABEL_WINS_FOR_THE_MIC").toBe("Deepgram Nova-3");
    expect(providerDestination(described)).toBe("Audio streams to Deepgram's EU region.");
    // The label a built-in registers by is still shortened for the mic.
    expect(providerShortLabel({ id: "gemini", label: "Google Gemini 3.5 Transcribe Live", capabilities: streaming })).toBe("Gemini");
    expect(providerShortLabel({ id: "webspeech", label: "Browser speech", capabilities: streaming })).toBe("Browser speech");
  });
});
