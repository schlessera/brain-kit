/** Real Chromium gestures: synthetic pointer dispatch cannot prove native capture. */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import "../../src/styles.css";
import { AskUserRankCard } from "../../src/decisions/AskUserRankCard.js";
import { rankingJourneys } from "../../fixtures/ranking.js";

declare module "vitest/browser" {
  interface BrowserCommands { rankTouch: (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", points: { x: number; y: number; id?: number }[]) => Promise<void>; }
}
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function mount(count = 5, cutoff?: number) {
  await page.viewport(320, 844);
  host = document.createElement("div");
  host.style.cssText = "width:288px;height:500px;overflow-y:auto;margin:16px";
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(createElement("div", null,
    createElement("div", { style: { height: 80 } }),
    createElement(AskUserRankCard, { question: "Which crossing first?", items: rankingJourneys.slice(0, count), cutoff }),
    createElement("div", { style: { height: 80 } }))));
  await document.fonts.ready;
  return host;
}
afterEach(async () => { await commands.rankTouch("touchCancel", []); root?.unmount(); host?.remove(); root = undefined; host = undefined; });
const order = () => [...host!.querySelectorAll<HTMLElement>("[data-rank-row]")].map((node) => node.dataset.rankRow);
const ids = (count = 5) => rankingJourneys.slice(0, count).map((item) => item.id);
function point(index: number) {
  const handle = host!.querySelectorAll<HTMLElement>("[data-rank-handle]")[index]!;
  handle.scrollIntoView({ block: "nearest" });
  const bounds = handle.getBoundingClientRect();
  return { x: bounds.x + 8, y: bounds.y + bounds.height / 2 };
}
test("a handle drag crosses rows and a native pointercancel restores the exact previous order", async () => {
  const el = await mount();
  const from = point(2);
  const first = el.querySelector<HTMLElement>("[data-rank-row]")!.getBoundingClientRect();
  await commands.rankTouch("touchStart", [from]);
  await commands.rankTouch("touchMove", [{ x: from.x, y: first.y + 8 }]);
  await pause(200);
  expect(order()[0]).toBe(ids()[2]);
  await commands.rankTouch("touchCancel", []);
  await pause(100);
  expect(order()).toEqual(ids());
  expect(el.querySelector("[aria-live]")!.textContent).toContain("Move cancelled");
  expect(el.querySelector("[data-picked]")).toBeNull();

  const again = point(2);
  await commands.rankTouch("touchStart", [again]);
  await commands.rankTouch("touchMove", [{ x: again.x, y: first.y + 8 }]);
  await pause(200);
  await commands.rankTouch("touchEnd", []);
  expect(order()).toEqual([ids()[2], ids()[0], ids()[1], ids()[3], ids()[4]]);
  expect(document.activeElement?.getAttribute("data-rank-pick")).toBe("");
});
test("edge scrolling stops at the card and row bodies still pan the transcript", async () => {
  const el = await mount(15, 3);
  const from = point(14);
  const before = el.scrollTop;
  const edge = el.getBoundingClientRect().top + 8;
  await commands.rankTouch("touchStart", [from]);
  await commands.rankTouch("touchMove", [{ x: from.x, y: edge }]);
  await pause(1800);
  const stopped = el.scrollTop;
  await pause(300);
  expect(el.scrollTop).toBe(stopped);
  expect(stopped).toBeLessThan(before);
  await commands.rankTouch("touchEnd", []);
  expect(order()[0]).toBe(ids(15)[14]);
  expect(el.querySelectorAll("[data-rank-row]")).toHaveLength(15);
  expect(document.querySelector(".bk-askrank")).not.toBeNull();

  el.scrollTop = 0;
  const body = el.querySelector<HTMLElement>("[data-rank-pick]")!.getBoundingClientRect();
  const previous = order();
  await commands.rankTouch("touchStart", [{ x: body.x + 30, y: body.y + 20 }]);
  for (let delta = 20; delta <= 120; delta += 20) {
    await commands.rankTouch("touchMove", [{ x: body.x + 30, y: body.y + 20 - delta }]);
    await pause(30);
  }
  await commands.rankTouch("touchEnd", []);
  await pause(100);
  expect(el.scrollTop).toBeGreaterThan(0);
  expect(order()).toEqual(previous);
});
