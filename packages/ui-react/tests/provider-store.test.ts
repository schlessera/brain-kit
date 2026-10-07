import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderInfo } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot } from "../src/root.js";
import { api } from "../src/lib/api-client.js";
import { useProviderStore } from "../src/stores/provider-store.js";

const realProviders = api.providers;

/** Stub the roster the server would return from GET /api/providers. */
function serveProviders(providers: ProviderInfo[]) {
  api.providers = async () => ({ providers, backends: {} });
}

afterEach(() => {
  api.providers = realProviders;
  useProviderStore.setState({
    available: [],
    selectedId: "",
    pinnedId: null,
    backends: {},
    loaded: false,
  });
});

describe("provider store — reloading the roster", () => {
  test("keeps the selection when it is still on offer", async () => {
    serveProviders([
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ]);
    useProviderStore.setState({ selectedId: "claude-haiku-4-5" });

    await useProviderStore.getState().loadProviders();

    expect(useProviderStore.getState().selectedId).toBe("claude-haiku-4-5");
    expect(useProviderStore.getState().available).toHaveLength(2);
  });

  test("moves the selection off a model that is no longer offered", async () => {
    // What hiding the selected model in Settings → Models looks like from here:
    // the same endpoint simply stops listing it.
    serveProviders([{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }]);
    useProviderStore.setState({ selectedId: "claude-haiku-4-5" });

    await useProviderStore.getState().loadProviders();

    const state = useProviderStore.getState();
    expect(state.selectedId).toBe("claude-opus-5-5");
    expect(state.available.map((p) => p.id)).toEqual(["claude-opus-5-5"]);
  });

  test("persists the fallback so the stale id is not re-read on boot", async () => {
    const values = new Map([["brain-ui:provider-id", "claude-haiku-4-5"]]);
    const storage: Storage = {
      get length() { return values.size; },
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
      clear: () => { values.clear(); },
      key: (index) => [...values.keys()][index] ?? null,
    };
    const options = { storage, storagePrefix: "", request: async () => Response.json({ providers: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }], backends: {} }) };
    const root = createBrainUiRoot(options);
    try {
      expect(root.stores.provider.getState().selectedId).toBe("claude-haiku-4-5");
      await root.stores.provider.getState().loadProviders();
      expect(storage.getItem("brain-ui:provider-id")).toBe("claude-opus-5-5");
      const rebooted = createBrainUiRoot(options);
      try { expect(rebooted.stores.provider.getState().selectedId).toBe("claude-opus-5-5"); }
      finally { rebooted.dispose(); }
    } finally { root.dispose(); }
  });

  test("picks up a model that has just appeared", async () => {
    // The Refresh button in Settings → Models can surface a newly released
    // model; reloading the roster is what puts it in the picker.
    serveProviders([{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }]);
    await useProviderStore.getState().loadProviders();
    expect(useProviderStore.getState().available).toHaveLength(1);

    serveProviders([
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-brand-new", label: "Claude Brand New" },
    ]);
    await useProviderStore.getState().loadProviders();

    expect(useProviderStore.getState().available.map((p) => p.id)).toEqual([
      "claude-opus-5-5",
      "claude-brand-new",
    ]);
    // An existing valid selection is untouched by the new arrival.
    expect(useProviderStore.getState().selectedId).toBe("claude-opus-5-5");
  });

  test("a failed reload leaves the previous roster in place", async () => {
    serveProviders([{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }]);
    await useProviderStore.getState().loadProviders();

    api.providers = async () => {
      throw new Error("network down");
    };
    await useProviderStore.getState().loadProviders();

    expect(useProviderStore.getState().available.map((p) => p.id)).toEqual([
      "claude-opus-5-5",
    ]);
  });
});
