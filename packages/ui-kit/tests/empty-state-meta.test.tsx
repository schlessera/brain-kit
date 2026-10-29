/** Prop-to-markup truth table; native actions/theme/axe remain in EmptyState stories. */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { EmptyState, type EmptyStateProps } from "../src/conversation/EmptyState.js";
import type { EmptyVariant } from "../src/types.js";

function mount(props: EmptyStateProps) {
  const window = new Window();
  const host = window.document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<EmptyState {...props} />);
  const state = host.firstElementChild!;
  expect(state.querySelector("svg"), "the state glyph is still rendered").not.toBeNull();
  expect(state.querySelector('[role="heading"]'), "the actual state heading exists").not.toBeNull();
  return state;
}

const activity = "last escalation 4m ago · 41 resolved this week";
const variants: [EmptyVariant, string][] = [
  ["caught_up", "Nothing is waiting on you"],
  ["no-results", "Nothing in the corpus about that"],
  ["offline", "No reach to the host"],
  ["first-run", "Nothing indexed yet"],
  ["quiet", "Quiet hours"],
];


for (const [variant, title] of variants) {
  test(`${variant}: omitted metadata uses only this variant's default`, () => {
    const state = mount({ variant });
    expect(state.querySelector('[role="heading"]')!.textContent).toBe(title);
    expect(state.children[2]!.textContent!.length, "the state body is not empty").toBeGreaterThan(20);
    if (variant === "caught_up") expect(state.children[3]!.textContent).toBe(activity);
    else expect(state.textContent).not.toContain(activity);
    expect(state.children).toHaveLength(variant === "caught_up" ? 4 : 3);
  });
  test(`${variant}: explicit evidence is retained verbatim`, () => {
    const meta = "3 omens indexed · no work queued";
    const state = mount({ variant, meta });
    expect(state.children).toHaveLength(4);
    expect(state.children[3]!.textContent).toBe(meta);
    expect(state.querySelector('[role="heading"]')!.textContent).toBe(title);
  });
  test(`${variant}: explicit empty metadata suppresses the footer`, () => {
    const state = mount({ variant, meta: "" });
    expect(state.children).toHaveLength(3);
    expect(state.querySelector('[role="heading"]')!.textContent).toBe(title);
  });
}
test(`default: omitting variant keeps the caught-up presentation`, () => {
  const state = mount({});
  expect(state.querySelector('[role="heading"]')!.textContent).toBe("Nothing is waiting on you");
  expect(state.children[3]!.textContent).toBe(activity);
});
