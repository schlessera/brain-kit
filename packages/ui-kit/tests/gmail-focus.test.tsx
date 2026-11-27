/**
 * Where focus goes when a Gmail component expands in place (#4209): to the
 * first thing it revealed, or nowhere, because the control that was pressed
 * is still there. A pure React consequence of props and clicks, so it is
 * asserted here against happy-dom; the stories under `stories/google/`
 * assert the same in real Chromium, from the keyboard, with geometry.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { contentThreads, L, loomMessages, structuredThreads } from "../fixtures/gmail.js";
import { GmailLabels } from "../src/google/GmailLabels.js";
import { GmailMessage } from "../src/google/GmailMessage.js";
import { GmailResultList } from "../src/google/GmailResultList.js";
import { GmailThread } from "../src/google/GmailThread.js";

const saved = new Map<string, PropertyDescriptor | undefined>();
let win: Window;
let root: Root | undefined;
let host: HTMLElement;

beforeAll(() => {
  win = new Window();
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  win.document.body.innerHTML = "";
});
afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function mount(element: ReactElement) {
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  root = createRoot(host);
  act(() => root!.render(element));
}

const active = () => win.document.activeElement as unknown as HTMLElement | null;
const button = (name: string) => [...host.querySelectorAll<HTMLElement>("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent) === name)!;
const press = (el: HTMLElement) => act(() => { el.focus(); el.click(); });

test("+N moves focus to the first label it revealed", () => {
  mount(<GmailLabels labels={[L.inbox, L.important, L.family, L.ithaca, L.voyage]} />);
  press(button("Show 2 more labels"));
  expect(active()?.getAttribute("data-gmail-label")).toBe("Label_2");
  expect(active()?.textContent).toBe("Ithaca");
  expect(active()?.tabIndex).toBe(-1);
  expect(host.querySelector("button")).toBeNull();
});

test("Show n earlier messages moves focus to the first message it revealed", () => {
  mount(<GmailThread view="content" messages={loomMessages} />);
  press(button("Show 2 earlier messages"));
  expect(active()?.getAttribute("aria-label")).toBe("Penelope, Tuesday 7 July 2026, 20:11");
  expect(host.querySelector("[data-gmail-fold]")).toBeNull();
});

test("opening an earlier message keeps focus on its row", () => {
  mount(<GmailThread view="content" messages={loomMessages.slice(2)} />);
  const row = button("Penelope, Thursday 9 July 2026, 22:30");
  press(row);
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(active()).toBe(row);
  expect(host.querySelector(`#${CSS.escape(row.getAttribute("aria-controls")!)}`)?.textContent).toContain("Melantho talks to Eurymachus");
});

test("Show quoted text keeps focus on itself and reveals the quote", () => {
  mount(<GmailMessage view="content" message={loomMessages[4]!} />);
  const toggle = host.querySelector<HTMLElement>("[data-gmail-quoted-toggle]")!;
  press(toggle);
  expect(active()).toBe(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.textContent).toBe("···Hide quoted text");
  expect(host.querySelector("[data-gmail-quoted]")!.textContent).toContain("Tell them it's for Laertes");
});

test("Show more moves focus to the first new row: a structured row itself, never a label's +N", () => {
  mount(<GmailResultList view="structured" threads={structuredThreads} />);
  press(host.querySelector<HTMLElement>("[data-bk-button]")!);
  const rows = host.querySelectorAll<HTMLElement>("[data-gmail-row]");
  expect(rows).toHaveLength(25);
  expect(active()).toBe(rows[8]!);
  expect(rows[8]!.tabIndex).toBe(-1);
});

test("Show more moves focus to the first new content row's toggle", () => {
  const threads = [...contentThreads, ...contentThreads, ...contentThreads].map((t, i) => ({ ...t, threadId: `${t.threadId.slice(0, 12)}${i.toString(16).padStart(4, "0")}` }));
  mount(<GmailResultList view="content" threads={threads} />);
  press(host.querySelector<HTMLElement>("[data-bk-button]")!);
  expect(active()).toBe(host.querySelectorAll("[data-gmail-row]")[8]!.querySelector(":scope > button") as HTMLElement);
});

// happy-dom's CSS.escape, for the panel id React's useId makes.
const CSS = { escape: (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
