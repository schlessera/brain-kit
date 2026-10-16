import { afterEach, expect, test } from "bun:test";
import { defaultContentRendererRegistry } from "@schlessera/brain-ui-sdk/client";
import { createBrainUiRoot } from "../src/root.js";
import { mermaidThemeVariables, type MermaidTheme } from "../src/lib/mermaid-theme.js";

afterEach(() => defaultContentRendererRegistry.reset());

test("built-in Mermaid owns both fence and file aliases through the content registry", () => {
  const root = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
  root.dispose();
  const renderer = defaultContentRendererRegistry.forLanguage("mermaid");
  expect(renderer, "MERMAID_BUILTIN_REGISTERED_ON_CONTENT_SEAM").not.toBeNull();
  expect(defaultContentRendererRegistry.forLanguage("mmd")).toBe(renderer);
  expect(defaultContentRendererRegistry.forExtension(".mmd")).toBe(renderer);
  expect(defaultContentRendererRegistry.forExtension(".mermaid")).toBe(renderer);
  expect(renderer!.needsBrowser).toBe(true);
});

test("Mermaid print palette uses the document's white paper", () => {
  expect(mermaidThemeVariables("print" as MermaidTheme).background, "MERMAID_PRINT_GROUND_IS_DOCUMENT_PAPER").toBe("#ffffff");
});
