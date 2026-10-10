import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LAYERS, z } from "../src/tokens.js";
import { DECLARED, theme, tailwindTheme } from "./_theme.js";

// Mutation: swap panel/banner numbers in LAYERS → strict ordering assertion.
test("layers strictly increase in the documented order", () => {
  const values = [LAYERS.raised, LAYERS.popover, LAYERS.nav, LAYERS.panel, LAYERS.banner, LAYERS.modal];
  for (let i = 1; i < values.length; i++) expect(values[i]!, "strictly increasing").toBeGreaterThan(values[i - 1]!);
});
// Mutation: change --bk-z-panel in the fence → exact fenced scale assertion.
test("the fenced scale and exports match both ways, outside the colour pipeline", () => {
  const fence = theme.match(/\/\* @layers:start \*\/([\s\S]*?)\/\* @layers:end \*\//)?.[1];
  expect(fence).toBeDefined();
  const entries = [...fence!.matchAll(/--bk-z-([\w-]+):\s*(\d+);/g)];
  expect(Object.fromEntries(entries.map(m => [m[1], Number(m[2])])), "exact fenced scale").toEqual(LAYERS);
  expect(Object.keys(z)).toEqual(Object.keys(LAYERS));
  for (const key of Object.keys(LAYERS) as (keyof typeof LAYERS)[]) expect(z[key]).toBe(`var(--bk-z-${key})`);
  expect([...DECLARED.keys()].filter(key => key.startsWith("--bk-z-"))).toEqual([]);
});
// Mutation: remove panel theme mapping → consumer map assertion.
test("both Tailwind themes map all named layers", () => {
  const app = readFileSync(new URL("../../ui-react/src/theme.css", import.meta.url), "utf8");
  for (const key of Object.keys(LAYERS)) for (const css of [app, tailwindTheme]) expect(css, "consumer map").toContain(`--z-index-${key}: var(--bk-z-${key});`);
});
