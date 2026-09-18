import { useEffect, useRef, useState } from "react";
import {
  type BillingMode,
  type ModelCatalogEntry,
  type ModelCatalogResponse,
  type ThinkingLevel,
} from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import type { BrainUiRoot } from "../../root.js";
import { useProviderStore } from "../../stores/provider-store.js";
import { ModelsCatalogView } from "./models-list.js";
import { PiAccountsSection } from "./pi-accounts.js";
import { WebSearchSection } from "./web-search-settings.js";
import { ToolPermissionsSection } from "./tool-permissions.js";

/**
 * The model picker's contents, and which of them to show.
 *
 * The roster comes from the server (Anthropic model discovery plus any
 * host-declared profiles), so this tab never hardcodes model names. Hiding is
 * presentation only — a session already pinned to a hidden model keeps running.
 *
 * This is the container (S7): the request, the optimistic commits, their
 * ordering gate and their write queue live here; `ModelsCatalogView` draws
 * the roster.
 */
export function ModelsTab({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const api = root.api;
  const lifetime = useRef(0);
  const [catalog, setCatalog] = useState<ModelCatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadProviders = useProviderStore((s) => s.loadProviders);
  const commitGate = useRef(createRequestGate());
  /** Serializes full-record PUTs — see commitCatalog. */
  const commitQueues = useRef(new WeakMap<BrainUiRoot, Promise<void>>());

  useEffect(() => {
    const generation = ++lifetime.current;
    const latest = commitGate.current.begin();
    const current = () => generation === lifetime.current && latest();
    setCatalog(null);
    setLoading(active);
    setRefreshing(false);
    setError(null);
    if (active) {
      // Returning to a root waits for its accepted writes before reading.
      void (commitQueues.current.get(root) ?? Promise.resolve())
        .then(() => current() ? api.models() : null)
        .then((data) => { if (data && current()) setCatalog(data); })
        .catch((err: unknown) => {
          if (current()) setError(err instanceof Error ? err.message : "Could not load models");
        })
        .finally(() => { if (generation === lifetime.current) setLoading(false); });
    }
    const invalidate = () => { lifetime.current++; };
    return invalidate;
  }, [active, root, api]);

  /**
   * Optimistic-update skeleton shared by the hidden toggle and the billing
   * select: the change is the user's own click, so reflect it immediately,
   * commit, then reload the composer picker's own roster copy (fetched once
   * on mount, it would otherwise lag until a page reload). A failed write
   * rolls back and surfaces the error.
   *
   * Ordered through `createRequestGate`: two rows edited within one
   * round-trip interleave, and without the guard the FIRST response (or its
   * failure rollback) lands last and silently overwrites the newer edit. A
   * superseded response/rollback is dropped — the newer request's payload
   * was built on top of this one's optimistic state, so it already carries
   * this change (and its own catch surfaces any error that still matters).
   */
  async function commitCatalog(
    optimistic: ModelCatalogResponse,
    commit: () => Promise<ModelCatalogResponse>
  ) {
    const generation = lifetime.current;
    const latest = commitGate.current.begin();
    const isCurrent = () => generation === lifetime.current && latest();
    const previous = catalog;
    setCatalog(optimistic);
    setError(null);
    // The gate drops superseded RESPONSES; this queue serializes the WRITES.
    // Both matter: the server stores full records, so two concurrent PUTs
    // could land older-last and silently clobber the newer record server-side
    // even while the client looked right. Each commit waits for the previous
    // one to settle; payloads are built on optimistic state, so the newest
    // write already carries every earlier edit.
    const run = (commitQueues.current.get(root) ?? Promise.resolve()).then(async () => {
      try {
        const confirmed = await commit();
        if (isCurrent()) setCatalog(confirmed);
        void loadProviders();
      } catch (err) {
        if (isCurrent()) {
          setCatalog(previous);
          setError(err instanceof Error ? err.message : "Could not save");
        }
      }
    });
    commitQueues.current.set(root, run);
    await run;
  }

  async function toggleHidden(entry: ModelCatalogEntry) {
    if (!catalog) return;
    const hidden = catalog.models
      .filter((model) =>
        model.id === entry.id ? !entry.hidden : model.hidden
      )
      .map((model) => model.id);

    await commitCatalog(
      {
        ...catalog,
        models: catalog.models.map((model) =>
          model.id === entry.id ? { ...model, hidden: !model.hidden } : model
        ),
      },
      () => api.setHiddenModels(hidden)
    );
  }

  async function changeBilling(entry: ModelCatalogEntry, next: BillingMode | "auto") {
    if (!catalog) return;

    // What "auto" resolves to is only known server-side, so switching back to
    // auto keeps the current resolved mode until the confirmed catalog
    // corrects it a beat later.
    await commitCatalog(
      {
        ...catalog,
        models: catalog.models.map((model) => {
          if (model.id !== entry.id) return model;
          const { billingOverride: _cleared, ...base } = model;
          return next === "auto" ? base : { ...base, billingOverride: next, billingMode: next };
        }),
      },
      () => api.setBillingOverrides(nextBillingOverrides(catalog.models, entry.id, next))
    );
  }

  async function changeThinking(entry: ModelCatalogEntry, next: ThinkingLevel | "auto") {
    if (!catalog) return;
    await commitCatalog(
      {
        ...catalog,
        models: catalog.models.map((model) => {
          if (model.id !== entry.id) return model;
          const { thinkingOverride: _cleared, ...base } = model;
          return next === "auto"
            ? base
            : { ...base, thinkingOverride: next, thinkingLevel: next };
        }),
      },
      () => api.setThinkingOverrides(nextThinkingOverrides(catalog.models, entry.id, next))
    );
  }

  async function changeDefault(next: string | null) {
    if (!catalog) return;
    await commitCatalog(
      { ...catalog, defaultModelId: next },
      () => api.setDefaultModel(next)
    );
  }

  async function setCustom(models: string[]) {
    if (!catalog) return;
    await commitCatalog(
      { ...catalog, customModels: models },
      () => api.setCustomModels(models)
    );
  }

  async function onRefresh() {
    if (refreshing) return;
    const generation = lifetime.current;
    const latest = commitGate.current.begin();
    const current = () => generation === lifetime.current && latest();
    setRefreshing(true);
    setError(null);
    try {
      await (commitQueues.current.get(root) ?? Promise.resolve());
      if (generation !== lifetime.current) return;
      const next = await api.refreshModels();
      if (current()) setCatalog(next);
      // A refresh can surface newly released models — put them in the picker
      // now, not on next load.
      void loadProviders();
    } catch (err) {
      if (current()) setError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      if (generation === lifetime.current) setRefreshing(false);
    }
  }

  return (
    <ModelsCatalogView
      catalog={catalog}
      loading={loading}
      refreshing={refreshing}
      error={error}
      sections={
        <>
          <PiAccountsSection active={active} />
          <WebSearchSection active={active} />
          <ToolPermissionsSection active={active} />
        </>
      }
      onToggleHidden={(entry) => void toggleHidden(entry)}
      onBilling={(entry, next) => void changeBilling(entry, next)}
      onThinking={(entry, next) => void changeThinking(entry, next)}
      onDefault={(next) => void changeDefault(next)}
      onCustomModels={(models) => void setCustom(models)}
      onRefresh={() => void onRefresh()}
    />
  );
}

/**
 * Request-ordering guard for optimistic commits: `begin()` claims a token
 * and returns a predicate that holds only while no later request has begun.
 * An older in-flight request must never write over a newer edit's state.
 */
export function createRequestGate(): { begin: () => () => boolean } {
  let seq = 0;
  return {
    begin() {
      const token = ++seq;
      return () => seq === token;
    },
  };
}

/**
 * The billing-override record PUT after changing one profile: every other
 * profile keeps its stored override, the changed one is set — or, for "auto",
 * REMOVED, never stored as a redundant explicit value.
 */
export function nextBillingOverrides(
  models: ModelCatalogEntry[],
  id: string,
  next: BillingMode | "auto"
): Record<string, BillingMode> {
  const billing: Record<string, BillingMode> = {};
  for (const model of models) {
    const value = model.id === id ? (next === "auto" ? undefined : next) : model.billingOverride;
    if (value) billing[model.id] = value;
  }
  return billing;
}

/**
 * The effort-override record PUT after changing one profile: every other
 * profile keeps its stored override, the changed one is set — or, for "auto",
 * REMOVED, never stored as a redundant explicit value.
 */
export function nextThinkingOverrides(
  models: ModelCatalogEntry[],
  id: string,
  next: ThinkingLevel | "auto"
): Record<string, ThinkingLevel> {
  const thinking: Record<string, ThinkingLevel> = {};
  for (const model of models) {
    const value =
      model.id === id ? (next === "auto" ? undefined : next) : model.thinkingOverride;
    if (value) thinking[model.id] = value;
  }
  return thinking;
}
