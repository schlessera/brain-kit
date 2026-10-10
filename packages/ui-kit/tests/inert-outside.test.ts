import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { inertOutside } from "../src/internal/inert-outside.js";
function fixture() {
  const win = new Window();
  win.document.body.innerHTML = '<main><button>Content</button><aside><nav data-bk-keep-live><button>Chat</button></nav><div id="other">Other content</div></aside><section id="panel"></section><div id="owned"></div></main>';
  const get = (selector: string) => win.document.querySelector(selector) as unknown as HTMLElement;
  get('#owned').inert = true;
  return { get };
}
test("nested walkers retain outer marks and preserve page-owned inert", () => {
  // Mutation: always release inert instead of counting → outer mark assertion.
  const { get } = fixture();
  const outer = inertOutside(get('#panel')); const inner = inertOutside(get('#panel'));
  expect(get('button').inert).toBe(true);
  inner(); expect(get('button').inert, "outer mark remains").toBe(true);
  outer(); outer(); expect(get('button').inert).toBe(false); expect(get('#owned').inert, "page-owned mark").toBe(true);
});
test("keepLive descendants stay operable while their siblings become inert", () => {
  // Mutation: mark branches containing keepLive → live branch assertion.
  const { get } = fixture(); const restore = inertOutside(get('#panel'));
  expect(get('aside').inert, "live branch").not.toBe(true);
  expect(get('nav').inert).not.toBe(true); expect(get('#other').inert).toBe(true);
  restore(); expect(get('#other').inert).toBe(false);
});
test("a custom keepLive selector is honoured", () => {
  // Mutation: ignore supplied selector → custom live assertion.
  const { get } = fixture(); const restore = inertOutside(get('#panel'), '#other');
  expect(get('#other').inert, "custom live").not.toBe(true); expect(get('nav').inert).toBe(true); restore();
});
