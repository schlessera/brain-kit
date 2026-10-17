import { afterEach, expect, test } from "bun:test";
import { createContentRendererRegistry, defaultContentRendererRegistry, registerContentRenderers } from "../src/client/content-renderers.js";
import { createStaticRendererRegistry, registerStaticRenderers, staticRendererFor } from "@schlessera/brain-ui-sdk/render";
import type { ContentRendererPack } from "@schlessera/brain-ui-sdk/client";

const first: ContentRendererPack = { renderers: [{ languages: ["odyssey"], extensions: [".odyssey.yaml"], needsBrowser: false, Component: () => null, toStatic: async (source) => source }] };
const second: ContentRendererPack = { renderers: [{ ...first.renderers[0]!, toStatic: async () => "second" }] };
afterEach(() => defaultContentRendererRegistry.reset());
test("first registered content claims win and duplicate pack identity is a no-op", () => {
  const registry = createContentRendererRegistry();
  registry.register(first); registry.register(second); registry.register(first);
  expect(registry.forLanguage("odyssey")).toBe(first.renderers[0]!);
  expect(registry.forExtension(".odyssey.yaml")).toBe(first.renderers[0]!);
  expect(registry.forLanguage("Odyssey")).toBeNull();
  expect(registry.forExtension("odyssey.yaml")).toBeNull();
  expect(registry.has(first)).toBe(true);
  registry.reset(); expect(registry.has(first)).toBe(false); expect(registry.forLanguage("odyssey")).toBeNull();
  registry.register(second); expect(registry.forLanguage("odyssey")).toBe(second.renderers[0]!);
});
test("duplicate identity cannot introduce a later claim, reset releases identity", () => {
  const languages = ["one"];
  const pack = { renderers: [{ ...first.renderers[0]!, languages }] };
  const registry = createContentRendererRegistry(); registry.register(pack);
  languages.push("two"); registry.register(pack); expect(registry.forLanguage("two")).toBeNull();
  registry.reset(); registry.register(pack); expect(registry.forLanguage("two")).toBe(pack.renderers[0]!);
});
test("default client registry and independent static registry resolve exact claims", async () => {
  registerContentRenderers(first); registerContentRenderers(second);
  expect(defaultContentRendererRegistry.forLanguage("odyssey")).toBe(first.renderers[0]!);
  const registry = createStaticRendererRegistry(); registry.register(first); registry.register(second);
  expect(await registry.forExtension(".odyssey.yaml")!.toStatic("raft", { theme: "print" })).toBe("raft");
  expect(registry.forLanguage("missing")).toBeNull();
  registry.reset(); expect(registry.has(first)).toBe(false);
  registerStaticRenderers(first); registerStaticRenderers(second);
  expect(staticRendererFor("odyssey")).toBe(first.renderers[0]!);
  expect(staticRendererFor(".odyssey.yaml")).toBe(first.renderers[0]!);
  expect(staticRendererFor("missing")).toBeNull();
});
test("static public entry imports in a fresh DOM-free Bun process and has no React dependency", async () => {
  const child = Bun.spawn([process.execPath, "-e", `if (typeof document !== "undefined" || typeof window !== "undefined") throw Error("DOM present"); const m = await import("@schlessera/brain-ui-sdk/render"); if(m.staticRendererFor("missing")!==null) throw Error("unexpected renderer"); console.log("SERVER_SAFE");`], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0); expect(await new Response(child.stdout).text()).toContain("SERVER_SAFE");
  const built = await Bun.build({ entrypoints: [new URL("../src/render.ts", import.meta.url).pathname], target: "bun" });
  expect(built.success).toBe(true);
  expect(await built.outputs[0]!.text()).not.toMatch(/react|document|window|HTMLElement/);
});
