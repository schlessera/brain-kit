/** Empty-state metadata belongs to the chosen state or an explicit caller. */
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";

import "../../src/styles.css";
import { EmptyState, type EmptyStateProps } from "../../src/conversation/EmptyState.js";
import type { EmptyVariant } from "../../src/types.js";

let host: HTMLDivElement | undefined;
let renderer: Root | undefined;
const activity = "last escalation 4m ago · 41 resolved this week";
const variants: [EmptyVariant, string][] = [
  ["caught_up", "Nothing is waiting on you"],
  ["no-results", "Nothing in the corpus about that"],
  ["offline", "No reach to the host"],
  ["first-run", "Nothing indexed yet"],
  ["quiet", "Quiet hours"],
];

afterEach(() => {
  if (renderer) flushSync(() => renderer!.unmount());
  host?.remove();
  renderer = undefined;
  host = undefined;
});

function mount(theme: string, props: EmptyStateProps) {
  host = document.createElement("div");
  host.style.width = "360px";
  host.dataset.theme = theme;
  document.body.append(host);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<EmptyState {...props} />));
  const state = host.firstElementChild as HTMLElement;
  expect(state.querySelector("svg"), "the state glyph is still rendered").not.toBeNull();
  expect(state.querySelector('[role="heading"]'), "the actual state heading exists").not.toBeNull();
  return state;
}

for (const theme of ["dark", "light"]) {
  for (const [variant, title] of variants) {
    test(`${variant} ${theme}: omitted metadata uses only this variant's default`, () => {
      const state = mount(theme, { variant });
      expect(state.querySelector('[role="heading"]')!.textContent).toBe(title);
      expect(state.children[2]!.textContent!.length, "the state body is not empty").toBeGreaterThan(20);
      if (variant === "caught_up") expect(state.children[3]!.textContent).toBe(activity);
      else expect(state.textContent).not.toContain(activity);
      expect(state.children).toHaveLength(variant === "caught_up" ? 4 : 3);
    });
    test(`${variant} ${theme}: explicit evidence is retained verbatim`, () => {
      const meta = "3 omens indexed · no work queued";
      const state = mount(theme, { variant, meta });
      expect(state.children).toHaveLength(4);
      expect(state.children[3]!.textContent).toBe(meta);
      expect(state.querySelector('[role="heading"]')!.textContent).toBe(title);
    });
    test(`${variant} ${theme}: explicit empty metadata suppresses the footer`, () => {
      const state = mount(theme, { variant, meta: "" });
      expect(state.children).toHaveLength(3);
      expect(state.querySelector('[role="heading"]')!.textContent).toBe(title);
    });
  }
  test(`default ${theme}: omitting variant keeps the caught-up presentation`, () => {
    const state = mount(theme, {});
    expect(state.querySelector('[role="heading"]')!.textContent).toBe("Nothing is waiting on you");
    expect(state.children[3]!.textContent).toBe(activity);
  });
}
