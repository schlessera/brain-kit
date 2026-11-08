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
