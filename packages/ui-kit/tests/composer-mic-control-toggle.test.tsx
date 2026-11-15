/**
 * A caller's mic comes and goes (#3693): the app draws `MicButton` at rest and
 * the kit's own mic while dictating, so one mounted composer switches
 * `micControl` on and off. Every style it touches must update without React's
 * shorthand warning ("Removing marginBottom … margin"), which the capture
 * gate treats as a browser fault, and must end where a fresh render would.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { Composer, type ComposerProps } from "../src/chrome/Composer.js";
import { MicButton } from "../src/voice/MicButton.js";

const saved = new Map<string, PropertyDescriptor | undefined>();
let win: Window;
let root: Root | undefined;
let host: HTMLDivElement;
let errors: unknown[][] = [];
let realError: typeof console.error;
beforeAll(() => {
  win = new Window();
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; win.document.body.innerHTML = ""; errors = []; });
afterAll(() => {
  console.error = realError;
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const noop = () => {};
const mic = <MicButton name="Dictate" onClick={noop} onTalkLive={noop} />;
const margins = (el: HTMLElement) => ["marginTop", "marginRight", "marginBottom", "marginLeft"].map((key) => el.style[key as "marginTop"] || "unset").join(" ");
const textarea = () => margins(host.querySelector("textarea")!);

function render(props: ComposerProps) {
  if (!root) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
  act(() => root!.render(<Composer onAttach={noop} onMic={noop} onSend={noop} onChange={noop} value={"two\nlines"} {...props} />));
}
const fresh = (props: ComposerProps) => {
  const div = document.createElement("div");
  div.innerHTML = renderToStaticMarkup(<Composer onAttach={noop} onMic={noop} onSend={noop} onChange={noop} value={"two\nlines"} {...props} />);
  return margins(div.querySelector("textarea")!);
};

test("switching the caller's mic on and off warns about no style and ends where a fresh render does", () => {
  for (const state of ["ready", "streaming"] as const) {
    render({ state, micControl: mic });
    render({ state, micControl: undefined });
    expect(textarea(), `${state}: without the caller's mic`).toBe(fresh({ state }));
    render({ state, micControl: mic });
    expect(textarea(), `${state}: with it again`).toBe(fresh({ state, micControl: mic }));
    render({ state: "dictating", micControl: undefined });
    render({ state, micControl: mic });
  }
  expect(errors.map((args) => String(args[0])), "no React style warnings").toEqual([]);
});
