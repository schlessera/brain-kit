import { afterEach, expect, spyOn, test } from "bun:test";
import { defaultContentRendererRegistry, registerContentRenderers } from "@schlessera/brain-ui-sdk/client";
import { preRenderBrowserFences } from "../src/lib/content-renderer-share.js";

afterEach(() => defaultContentRendererRegistry.reset());

test("browser-only share dispatch uses the matching bundled pack and print theme", async () => {
  const calls: string[] = [];
  let serverCalls = 0;
  registerContentRenderers({ renderers: [{ languages: ["voyage"], extensions: [], needsBrowser: true,
    Component: () => null, async toStatic(source, { theme }) { calls.push(`${theme}:${source}`); return `<figure>${source}</figure>`; } },
  { languages: ["server-voyage"], extensions: [], needsBrowser: false, Component: () => null,
    async toStatic() { serverCalls++; throw Error("Server-safe packs belong to the later static step"); } }] });
  const input = "Before.\n\n```voyage\nReturn to Ithaca\n```\n\n```server-voyage\nKeep me\n```\n\n````md\n```voyage\nQuoted\n```\n````\n\n```voyage\nUnfinished";
  const output = await preRenderBrowserFences(input);
  expect(calls, "BROWSER_SHARE_DISPATCHES_NON_MERMAID_PACK").toEqual(["print:Return to Ithaca"]);
  expect(serverCalls, "SERVER_SAFE_PACK_NOT_RUN_IN_BROWSER_PREFLIGHT").toBe(0);
  expect(output).toContain("<figure>Return to Ithaca</figure>");
  expect(output).toContain("```server-voyage\nKeep me\n```");
  expect(output).toContain("```voyage\nQuoted\n```");
  expect(output).toContain("```voyage\nUnfinished");
});

test("a static failure retains exact source and reports a lint finding", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  registerContentRenderers({ renderers: [{ languages: ["voyage"], extensions: [], needsBrowser: true,
    Component: () => null, async toStatic() { throw Error("The raft is incomplete"); } }] });
  const source = "  ~~~voyage\n  The raft\n  ~~~";
  try {
    expect(await preRenderBrowserFences(source), "STATIC_FAILURE_RETAINS_SOURCE").toBe(source);
    expect(warning).toHaveBeenCalledWith("Content renderer share lint", expect.objectContaining({ language: "voyage", reason: "static rendering failed; source retained" }));
  } finally { warning.mockRestore(); }
});

test("the inline limit counts UTF-8 bytes and keeps an oversized rendered fence as code", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  registerContentRenderers({ renderers: [{ languages: ["voyage"], extensions: [], needsBrowser: true,
    Component: () => null, async toStatic() { return `<figure>${"舟".repeat(170_000)}</figure>`; } }] });
  const source = "```voyage\nReturn to Ithaca\n```";
  try {
    expect(await preRenderBrowserFences(source), "INLINE_RENDERER_BUDGET_COUNTS_BYTES").toBe(source);
    expect(warning).toHaveBeenCalledWith("Content renderer share lint", expect.objectContaining({ reason: "inline byte budget exceeded; source retained" }));
  } finally { warning.mockRestore(); }
});
