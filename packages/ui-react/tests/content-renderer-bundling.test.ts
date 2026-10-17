import { afterEach, expect, spyOn, test } from "bun:test";
import { defaultContentRendererRegistry } from "@schlessera/brain-ui-sdk/client";
import { registerContentRendererPack, warnContentRendererVersions } from "../src/content-renderers/register.js";
import { createContentRendererStore } from "../src/stores/content-renderer-state.js";
import type { BrainApi } from "../src/lib/api-client.js";
const declaration = { module: "voyage", version: "0.43.1", name: "map", fences: ["voyage"], extensions: [".voyage"] };
afterEach(() => { defaultContentRendererRegistry.reset(); });
test("build registration renders claims and version warnings occur once per root only in development", () => {
  const pack = { renderers: [{ languages: ["voyage"], extensions: [".voyage"], needsBrowser: false, Component: () => null, toStatic: async () => "" }] };
  registerContentRendererPack(pack, { name: "voyage", version: "0.43.0" });
  expect(defaultContentRendererRegistry.forLanguage("voyage")).toBe(pack.renderers[0]);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const warned = new Set<string>();
    warnContentRendererVersions([declaration], false, warned);
    expect(warn).not.toHaveBeenCalled();
    warnContentRendererVersions([declaration, declaration], true, warned);
    warnContentRendererVersions([declaration], true, warned);
    expect(warn, "VERSION_SKEW_WARNS_ONCE_PER_ROOT").toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("bundled 0.43.0, server 0.43.1");
    warnContentRendererVersions([{ ...declaration, module: "unknown" }, { ...declaration, version: null }, { ...declaration, version: "0.43.0" }], true, warned);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally { warn.mockRestore(); }
});
test("one root deduplicates bootstrap and a reset refuses stale account metadata", async () => {
  const reads: Array<(status: { contentRenderers: typeof declaration[] }) => void> = [];
  const api = { status: () => new Promise(resolve => reads.push(resolve)) } as unknown as BrainApi;
  const store = createContentRendererStore({ api });
  const stale = store.getState().load();
  expect(store.getState().load()).toBe(stale);
  expect(reads).toHaveLength(1);
  store.getState().reset();
  const current = store.getState().load();
  reads[1]!({ contentRenderers: [{ ...declaration, module: "ithaca" }] }); await current;
  reads[0]!({ contentRenderers: [declaration] }); await stale;
  expect(store.getState().declarations, "OLD_ACCOUNT_DECLARATIONS_CANNOT_OVERWRITE_CURRENT_ROOT").toEqual([{ ...declaration, module: "ithaca" }]);
  await store.getState().load(); expect(reads).toHaveLength(2);
  const other = createContentRendererStore({ api }); expect(other.getState().declarations).toEqual([]);
});
test("failed bootstrap can retry and older servers leave ordinary source behavior", async () => {
  let count = 0;
  const store = createContentRendererStore({ api: { status: async () => { if (++count === 1) throw Error("offline"); return {}; } } as unknown as BrainApi });
  await store.getState().load(); expect(store.getState().loaded).toBe(false);
  await store.getState().load(); expect(store.getState().loaded).toBe(true); expect(store.getState().declarations).toEqual([]);
});

import { createBrainUiRoot } from "../src/root.js";
test("root account changes and dispose invalidate in-flight bootstrap responses", async () => {
  const reads: Array<(value: Response) => void> = [];
  const root = createBrainUiRoot({ storage: null, request: () => new Promise(resolve => reads.push(resolve)) });
  const stale = root.stores.contentRenderers.getState().load();
  root.stores.connection.getState().setVpnStatus("connected", "ithaca");
  expect(reads).toHaveLength(2);
  reads[1]!(Response.json({ contentRenderers: [{ ...declaration, module: "ithaca" }] }));
  await root.stores.contentRenderers.getState().load();
  reads[0]!(Response.json({ contentRenderers: [declaration] })); await stale;
  expect(root.stores.contentRenderers.getState().declarations).toEqual([{ ...declaration, module: "ithaca" }]);
  root.stores.contentRenderers.getState().reset();
  const disposed = root.stores.contentRenderers.getState().load();
  root.dispose();
  reads[2]!(Response.json({ contentRenderers: [declaration] })); await disposed;
  expect(root.stores.contentRenderers.getState().declarations, "DISPOSED_ROOT_REFUSES_INFLIGHT_METADATA").toEqual([]);
});
