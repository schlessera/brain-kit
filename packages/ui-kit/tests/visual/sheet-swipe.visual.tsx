/// <reference types="@vitest/browser-playwright" />
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { Overlay, type OverlayProps } from "../../src/chrome/Overlay.js";
import { IconButton } from "../../src/primitives/IconButton.js";
import "../../src/styles.css";
let root: Root | undefined, host: HTMLElement | undefined;
let outer: { width: number; height: number } | undefined;
const viewport = { width: innerWidth, height: innerHeight };
const reasons: string[] = [];
let policy: (value: "any" | "none") => void;
let stack: () => void;
const tick = () => new Promise<void>(r => requestAnimationFrame(() => r()));
afterEach(async () => {
  await commands.sheetInput("touch", [{ type: "cancel", x: 0, y: 0, t: 500 }]);
  await commands.sheetInput("pen", [{ type: "up", x: 0, y: 0, t: 500 }]);
  await commands.sheetInput("mouse", [{ type: "up", x: 0, y: 0, t: 500 }]);
  if (root) flushSync(() => root!.unmount()); host?.remove(); root = undefined; host = undefined;
  await commands.dictationMotion("no-preference"); await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120); outer = undefined;
});
function Scene({ refusal, bodyHeight = 400, untitled = false, ...p }: Partial<Pick<OverlayProps, "variant" | "closedBy" | "placement">> & { refusal?: boolean; bodyHeight?: number; untitled?: boolean }) {
  const [open, setOpen] = useState(false), [closedBy, setPolicy] = useState(p.closedBy ?? "any"), [upper, setUpper] = useState(false);
  policy = value => flushSync(() => setPolicy(value)); stack = () => flushSync(() => setUpper(true));
  return <><IconButton name="More" data-opener="" glyph="+" onClick={() => setOpen(true)} />
    <Overlay variant="sheet" {...(untitled ? {label:"More"} : {title:"More"})} {...p} closedBy={closedBy} open={open} returnFocus={() => host?.querySelector<HTMLElement>('[data-opener]') ?? null}
      onAfterClose={() => reasons.push(document.activeElement === host!.querySelector('[data-opener]') ? "after-focus" : "bad-focus")}
      onClose={reason => { reasons.push(reason); if (!refusal) setOpen(false); }}>
      <div style={{ height: bodyHeight }}><IconButton name="Read raft plan" glyph="+" onClick={() => {}} /><p>Odysseus reviews the mast.</p></div>
    </Overlay>
    <Overlay variant="dialog" label="Credential" open={upper} closedBy="none" onClose={() => reasons.push("upper")}><IconButton name="Copy" glyph="+" onClick={() => {}} /></Overlay>
  </>;
}
async function mount(p: Partial<Pick<OverlayProps, "variant" | "closedBy" | "placement">> & { refusal?: boolean; bodyHeight?: number; untitled?: boolean } = {}, width = 320) {
  reasons.length = 0; outer = await commands.formViewport(width, 800); await page.viewport(width, 800); await commands.dictationMotion("reduce");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); flushSync(() => root!.render(<Scene {...p} />));
  await userEvent.click(host.querySelector('[data-opener]')!); await tick();
}
const surface = () => host!.querySelector<HTMLElement>('.bk-overlay-surface')!;
const offset = () => new DOMMatrix(getComputedStyle(surface()).transform).m42;
function point(body = false) { const r = surface().getBoundingClientRect(); return { x: r.left + 80, y: r.top + (body ? 150 : 20) }; }
async function start(pointer: "touch" | "pen" | "mouse" = "touch", body = false) {
  const p = point(body); await commands.sheetInput(pointer, [{ type: "down", ...p, t: 0 }]); return p;
}
async function move(p: {x: number;y: number}, dy: number, t = 200, pointer: "touch" | "pen" | "mouse" = "touch", dx = 0) {
  await commands.sheetInput(pointer, [{ type: "move", x: p.x + dx, y: p.y + dy, t }]); await tick();
}
async function end(p: {x: number;y: number}, dy: number, t = 400, pointer: "touch" | "pen" | "mouse" = "touch") {
  await commands.sheetInput(pointer, [{ type: "up", x: p.x, y: p.y + dy, t }]); await tick();
}
for (const pointer of ["touch", "pen"] as const) {
  test(`${pointer} distance commits once and restores focus before after-close`, async () => {
    await mount(); const dy = Math.min(surface().getBoundingClientRect().height * .25, 120) + 1;
    const p = await start(pointer); await move(p, dy, 200, pointer);
    expect(offset(), "direct downward tracking").toBeCloseTo(dy, 0);
    await end(p, dy, 400, pointer);
    expect(reasons, "exact swipe callback and closing focus order").toEqual(["swipe", "after-focus"]);
  });
  test(`${pointer} below distance snaps back`, async () => {
    await mount(); const dy = Math.min(surface().getBoundingClientRect().height * .25, 120) - 2;
    const p = await start(pointer); await move(p, dy, 200, pointer); await end(p, dy, 400, pointer);
    expect(reasons, "below-distance callback count").toEqual([]); expect(offset(), "reduced snap is immediate").toBe(0);
  });
  for (const dy of [30, 24, 23, 20]) test(`${pointer} velocity ${dy}px`, async () => {
    await mount(); const p = point(); await commands.sheetInput(pointer, [{ type:"down", ...p,t:0 }, {type:"move",x:p.x,y:p.y+dy,t:20},{type:"up",x:p.x,y:p.y+dy,t:30}]); await tick();
    expect(reasons.filter(r => r === "swipe"), "velocity commit with 24px floor").toEqual(dy >= 24 ? ["swipe"] : []);
  });
}
test("last 80ms rejects an early flick followed by a hold", async () => {
  await mount(); const p = await start(); await move(p, 30, 20); await end(p, 30, 200);
  expect(reasons, "held flick does not commit").toEqual([]);
});
for (const scroll of [0, 80]) test(`body at scroll ${scroll} never moves`, async () => {
  await mount({bodyHeight:1200});
  const body = host!.querySelector<HTMLElement>('.bk-overlay-body')!;
  expect(body.scrollHeight,"body really overflows").toBeGreaterThan(body.clientHeight);
  for (const pointer of ["pen", "touch"] as const) {
    body.scrollTop = scroll;
    expect(body.scrollTop,"actual initial body scroll position").toBe(scroll);
    const p = await start(pointer, true); await move(p, 130, 200, pointer);
    expect(offset(), "body cannot track").toBe(0); await end(p,130,400,pointer); expect(reasons, "body cannot dismiss").toEqual([]);
  }
});
test("mouse never moves", async () => {
  await mount(); const p = await start("mouse"); await move(p, 130, 200, "mouse");
  expect(offset(), "mouse cannot track").toBe(0); await end(p,130,400,"mouse"); expect(reasons, "mouse cannot dismiss").toEqual([]);
});
for (const closedBy of ["none", "closerequest"] as const) test(`${closedBy} rubber-bands without callbacks or focus change`, async () => {
  await mount({closedBy}); const focus = document.activeElement; const p = await start(); await move(p,200);
  expect(offset(), "locked rubber-band bound").toBe(12); expect(document.activeElement,"drag preserves focus").toBe(focus);
  await end(p,200); expect(reasons,"locked callbacks").toEqual([]); expect(offset()).toBe(0);
});
test("upward tracking resists and scrim follows downward progress", async () => {
  await mount(); const h = surface().getBoundingClientRect().height; const p = await start(); await move(p,60);
  expect(Number(getComputedStyle(host!.querySelector('.bk-overlay-scrim')!).opacity),"scrim progress").toBeCloseTo(1-.6*60/h,3);
  await move(p,-100,250); expect(offset(),"upward cap").toBe(-12);
  await move(p,-20,300); expect(offset(),"upward resistance coefficient").toBe(-4); await end(p,-20);
});
test("horizontal-first disqualifies and 8px is required", async () => {
  await mount(); const p = await start(); await move(p,7,20); expect(offset(),"8px start threshold").toBe(0);
  await move(p,9,40,"touch",30); await move(p,130,200); expect(offset(),"horizontal-first stays disqualified").toBe(0); await end(p,130);
});
for (const interruption of ["cancel", "second", "lost", "policy", "topmost", "escape"] as const) test(`${interruption} cancels an active drag`, async () => {
  await mount({refusal:interruption === "escape"}); let pointerId = 0; surface().addEventListener("pointerdown", e => { pointerId = e.pointerId; }, {once:true});
  const p = await start(); await move(p,80);
  expect(offset(),"gesture started").toBe(80);
  if (interruption === "cancel") await commands.sheetInput("touch",[{type:"cancel",...p,t:250}]);
  if (interruption === "second") await commands.sheetInput("touch",[{type:"down",x:p.x,y:p.y+80,t:250,second:true}]);
  if (interruption === "lost") {
    expect(surface().hasPointerCapture(pointerId), "initiating pointer captured").toBe(true);
    surface().releasePointerCapture(pointerId);
    await move(p,90,250);
  }
  if (interruption === "policy") policy("none");
  if (interruption === "topmost") stack();
  if (interruption === "escape") await userEvent.keyboard("{Escape}");
  await tick();
  if (interruption !== "escape") { expect(offset(),"cancelled transform").toBe(0); await end(p,130); expect(reasons,"cancelled callback count").toEqual([]); }
  else { expect(offset(),"Escape cancels before refused close").toBe(0); expect(reasons,"Escape retains its close meaning").toEqual(["escape"]); }
});
test("caller refusal keeps modal and restores surface", async () => {
  await mount({refusal:true}); const p = await start(); await move(p,130); await end(p,130);
  expect(reasons,"one refused request").toEqual(["swipe"]); expect(offset(),"refused request resets").toBe(0); expect(host!.querySelector('dialog')!.matches(':modal')).toBe(true);
});
test("reduced motion leaves no release animations", async () => {
  await mount(); const p = await start(); await move(p,30); expect(offset()).toBe(30); await end(p,30);
  expect(surface().getAnimations({subtree:true}),"reduced release animations").toEqual([]); expect(offset()).toBe(0);
  expect(host!.querySelector<HTMLElement>('.bk-overlay-scrim')!.getAnimations(), "reduced scrim release animations").toEqual([]);
});
test("ordinary snap-back is 200ms ease-out", async () => {
  await mount(); await commands.dictationMotion("no-preference");
  await expect.poll(() => surface().getAnimations().every(a => a.playState === "finished")).toBe(true);
  const p = await start(); await move(p,30); await end(p,30);
  const animation = surface().getAnimations().find(a => !(a instanceof CSSAnimation)); expect(animation,"snap-back animation").toBeDefined();
  expect(animation!.effect!.getTiming().duration).toBe(200); expect(animation!.effect!.getTiming().easing).toBe("ease-out");
  await expect.poll(offset).toBe(0);
});
test("header close button remains operable", async () => {
  await mount(); await userEvent.click(host!.querySelector('[aria-label="Close More"]')!); expect(reasons).toEqual(["close-button","after-focus"]);
});
for (const [variant,width,placement] of [["dialog",1280,"center"],["dialog",320,"top"],["panel",320,"center"],["fullscreen",320,"center"]] as const) test(`${variant} ${width} ${placement} does not track`, async () => {
  await mount({variant,placement},width); const baseline = getComputedStyle(surface()).transform; const p = await start("pen"); await move(p,130,200,"pen");
  expect(getComputedStyle(surface()).transform,"non-sheet resting transform").toBe(baseline); await end(p,130,400,"pen"); expect(reasons).toEqual([]);
});

test("short sheet commits at one quarter of its height", async () => {
  await mount({bodyHeight:160});
  const height = surface().getBoundingClientRect().height;
  expect(height,"short surface exercises fractional threshold").toBeLessThan(480);
  const p = await start(); await move(p,height*.25+1); await end(p,height*.25+1);
  expect(reasons,"quarter-height dismissal").toEqual(["swipe","after-focus"]);
});

test("interactive header press never starts a swipe", async () => {
  await mount();
  const r = host!.querySelector('[aria-label="Close More"]')!.getBoundingClientRect();
  const p = {x:r.left+r.width/2,y:r.top+4};
  await commands.sheetInput("pen",[{type:"down",...p,t:0},{type:"move",x:p.x,y:p.y+130,t:200}]);
  await tick(); expect(offset(),"header control never tracks").toBe(0);
  await commands.sheetInput("pen",[{type:"up",x:p.x,y:p.y+130,t:400}]);
  expect(reasons,"header control never requests swipe").toEqual([]);
});

test("untitled header controls retain pointer handling", async () => {
  await mount({untitled:true});
  const button = host!.querySelector('[aria-label="Read raft plan"]')!;
  const r = button.getBoundingClientRect(); const p = {x:r.left+4,y:r.top+4};
  await commands.sheetInput("pen",[{type:"down",...p,t:0},{type:"move",x:p.x,y:p.y+130,t:200}]);
  await tick(); expect(offset(),"untitled header control never tracks").toBe(0);
  await commands.sheetInput("pen",[{type:"up",x:p.x,y:p.y+130,t:400}]);
  expect(reasons,"untitled header control does not dismiss").toEqual([]);
});
