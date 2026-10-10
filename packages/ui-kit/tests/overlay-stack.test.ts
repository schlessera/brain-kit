import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { registerOverlay, isTopmost } from "../src/internal/overlay-stack.js";

test("only the last open entry receives document Escape; removal restores the previous entry", () => {
  // Mutation: keys calls every entry → first escape count fails.
  const win = new Window();
  const doc = win.document as unknown as Document;
  const first = Symbol(); const second = Symbol();
  let a = 0; let b = 0;
  const removeA = registerOverlay(doc, { id: first, modal: false, escape: () => a++ });
  const removeB = registerOverlay(doc, { id: second, modal: false, escape: () => b++ });
  const escape = () => win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(isTopmost(doc, second)).toBe(true);
  escape();
  expect(a, "first escape count").toBe(0); expect(b).toBe(1);
  removeB(); removeB(); escape();
  expect(a).toBe(1); expect(isTopmost(doc, first)).toBe(true);
  removeA(); escape(); expect(a).toBe(1); expect(isTopmost(doc, first)).toBe(false);
});
test("a modal above a panel and a consumed Escape leave the panel alone", () => {
  // Mutation: remove top.modal check → modal blocks panel assertion.
  const win = new Window(); const doc = win.document as unknown as Document;
  let calls = 0;
  const remove = registerOverlay(doc, { id: Symbol(), modal: false, escape: () => calls++ });
  const removeModal = registerOverlay(doc, { id: Symbol(), modal: true, escape: () => calls++ });
  win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  expect(calls, "modal blocks panel").toBe(0);
  removeModal();
  const consumed = new win.KeyboardEvent("keydown", { key: "Escape", cancelable: true }); consumed.preventDefault();
  win.document.dispatchEvent(consumed); expect(calls, "consumed escape").toBe(0); remove();
});
