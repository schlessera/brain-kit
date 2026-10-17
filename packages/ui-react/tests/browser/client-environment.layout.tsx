import { afterEach, expect, test } from "vitest";
import { commands, page } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { detectClientEnvironment, resetClientEnvironmentCache } from "../../src/lib/client-environment.js";

let renderer: Root | undefined, ui: BrainUiRoot | undefined, host: HTMLDivElement | undefined, style: HTMLStyleElement | undefined;
const replaced: Array<{ owner: object; key: PropertyKey; descriptor?: PropertyDescriptor }> = [];
function replace(owner: object, key: PropertyKey, value: unknown) {
  replaced.push({ owner, key, descriptor: Object.getOwnPropertyDescriptor(owner, key) });
  Object.defineProperty(owner, key, { configurable: true, writable: true, value });
}
let viewport: { width: number; height: number } | undefined;
afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  ui?.dispose(); host?.remove(); style?.remove();
  renderer = undefined; ui = undefined; host = undefined; style = undefined;
  for (const { owner, key, descriptor } of replaced.splice(0).reverse()) {
    if (descriptor) Object.defineProperty(owner, key, descriptor);
    else Reflect.deleteProperty(owner, key);
  }
  resetClientEnvironmentCache();
  if (viewport) await page.viewport(viewport.width, viewport.height);
});

test("welcome and follow-up measure one reading width and a delayed device probe stays unknown", async () => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1200, 800);
  class FixtureSocket {
    readyState = 0; onopen = null; onmessage = null; onclose = null; onerror = null;
    send() {} close() { this.readyState = 3; }
  }
  replace(globalThis, "WebSocket", FixtureSocket);
  replace(globalThis, "fetch", async () => Response.json({ entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [] }));
  resetClientEnvironmentCache();
  let settle!: (devices: unknown[]) => void;
  replace(navigator, "mediaDevices", { enumerateDevices: () => new Promise(resolve => { settle = resolve; }) });
  style = document.createElement("style"); style.textContent = await commands.formConsumerStyles(); document.head.append(style);
  host = document.createElement("div"); host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column;width:1200px;height:800px";
  document.body.append(host);
  ui = createBrainUiRoot({ storage: null }); renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={ui!}><ChatPage /></BrainUiProvider>));
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const welcome = detectClientEnvironment();
  expect(welcome?.viewportWidth, "WELCOME_READING_COLUMN").toBe(750);
  expect(welcome?.camera, "UNFINISHED_CAMERA_UNKNOWN").toBeUndefined();
  expect(welcome?.microphone, "UNFINISHED_MICROPHONE_UNKNOWN").toBeUndefined();
  settle([{ kind: "videoinput" }]); await Promise.resolve();
  flushSync(() => ui!.stores.chat.getState().addUserMessage(null, "Odysseus prepares the raft.", "typed"));
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const followup = detectClientEnvironment();
  expect(followup?.viewportWidth, "WELCOME_FOLLOWUP_WIDTH_STABLE").toBe(welcome?.viewportWidth);
  expect(followup?.camera).toBe(true);
  expect(followup?.microphone).toBe(false);
});
