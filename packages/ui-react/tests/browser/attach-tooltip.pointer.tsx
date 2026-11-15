/// <reference types="@vitest/browser-playwright" />
/**
 * The paperclip's name under each real pointer (#3045), in Chromium launched
 * as a fine, coarse or mixed device (the `rail-*` projects), so `(hover: none)`
 * is the browser's own answer rather than a mocked media query.
 *
 * A hovering primary pointer gets the tooltip on hover and on keyboard focus
 * (the `ui-react-layout` scene in `conversation-controls.offline.tsx` times it).
 * A touch-only device never renders it — not on focus, not after a tap — and
 * reads the name in the attach sheet instead. Live conversation is no longer
 * in the menu or its name: the mic's hold opens it (#3693,
 * `composer-mic.pointer.tsx`).
 */
import { afterAll, beforeAll, expect, inject, test, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { conversationProfileSchema, serverHelloSchema } from "@schlessera/brain-ui-sdk/schemas";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { installFaultNetwork } from "./offline/fault-network.js";

declare module "vitest" {
  interface ProvidedContext { railPointer: "fine" | "coarse" | "mixed"; }
}

const SESSION = "odysseus-ithaca";
const ATTACH = "Attach — photo, camera, files";
const PROFILE = conversationProfileSchema.parse({
  providerId: "gpt-live",
  capabilities: { nonblockingWork: "supported", manualEndpoint: "supported", finalTranscript: "unproven", remoteOutputCancelAck: "unproven", exactPermissionSpeech: "unproven", echoIsolatedInput: "unproven", outputWordAlignment: "unproven" },
  disclosure: { voiceService: "Odysseus voice fixture", destinations: ["Audio and transcripts: fictional fixture. Retention: unknown."] },
});
const HELLO = serverHelloSchema.parse({ type: "server_hello", protocolRev: 5, principalKey: "odysseus-principal", capabilities: { liveConversation: true, conversationPause: true, toolResolution: true }, conversationProfile: PROFILE });

let styles: HTMLStyleElement;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());

async function scene(ctx: TestContext, width: number, height: number, theme: "light" | "dark") {
  const viewport = { width: innerWidth, height: innerHeight };
  const outer = await commands.formViewport(width, height);
  await page.viewport(width, height);
  const network = installFaultNetwork({ routes: url => url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] }) : undefined,
    onOpen(socket) { socket.deliver(HELLO); socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false }); socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] }); socket.deliver({ type: "status", sessionId: SESSION, status: "idle" }); } });
  const ui = createBrainUiRoot({ storage: null, request: network.request });
  ui.stores.chat.getState().setActiveSession(SESSION);
  ui.stores.ui.getState().setTheme(theme);
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;width:${width}px;height:${height}px`;
  document.body.append(host);
  const renderer = createRoot(host);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><AppShell><ChatPage /></AppShell></BrainUiProvider>));
  const release = ui.connection.connect();
  ctx.onTestFinished(async () => { flushSync(() => renderer.unmount()); release(); ui.dispose(); network.restore(); host.remove(); await page.viewport(viewport.width, viewport.height); await commands.formViewport(outer.width - 100, outer.height - 120); });
  await expect.poll(() => ui.stores.connection.getState().wsStatus).toBe("connected");
  await expect.poll(() => ui.connection.conversation.state.getState().available).toBe(true);
  return { ui, host, network, client: ui.connection.conversation };
}

for (const theme of ["light", "dark"] as const) for (const [width, height] of [[1280, 720], [320, 568]] as const) test(`paperclip tooltip follows the pointer ${theme} ${width}x${height}`, async ctx => {
  const mode = inject("railPointer");
  // The rail launches set pointer types only; the primary hover is whatever
  // Chromium derives from them (headless fine/mixed answer `none` as well).
  // A coarse primary pointer must never hover — that is the touch premise.
  const touch = matchMedia("(hover: none)").matches;
  if (mode === "coarse") expect(touch, "touch premise").toBe(true);
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches, "reduced motion premise").toBe(true);
  const s = await scene(ctx, width, height, theme);
  const trigger = page.getByRole("button", { name: ATTACH, exact: true }).element() as HTMLElement;
  const tip = trigger.querySelector<HTMLElement>("[data-composer-tip]")!;
  const shown = () => getComputedStyle(tip).display !== "none" && getComputedStyle(tip).visibility === "visible";
  expect(tip.textContent).toBe(ATTACH);

  // Keyboard focus: at once with a hovering pointer, never on touch.
  s.host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!.focus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement).toBe(trigger);
  expect(getComputedStyle(tip).display, "touch renders no tooltip").toBe(touch ? "none" : "block");
  expect(shown()).toBe(!touch);
  await userEvent.keyboard("{Escape}");
  expect(shown()).toBe(false);
  trigger.blur();

  if (touch) {
    const box = trigger.getBoundingClientRect();
    await commands.rankTap({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(getComputedStyle(tip).display, "a tap renders no tooltip").toBe("none");
  } else {
    await userEvent.hover(trigger);
    await expect.poll(shown, { timeout: 2000 }).toBe(true);
    await userEvent.click(trigger);
    expect(shown(), "an opened menu hides the tooltip").toBe(false);
  }
  if (width < 900) {
    await expect.poll(() => document.querySelector('[data-overlay-site="attach"]')).not.toBe(null);
    expect(document.querySelector('[data-overlay-site="attach"]')!.textContent, "the sheet names the menu's actions").toContain("Photo, camera, track files, or paste.");
  } else await expect.element(page.getByRole("menu", { name: "Attach" })).toBeInTheDocument();
  expect(document.body.textContent, "live conversation is the mic's hold, not a menu row").not.toContain("Live conversation");
  await page.screenshot({ element: s.host, path: `../../.vitest-attachments/attach-tooltip/${mode}-${theme}-${width}-menu.png` });
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector('[data-overlay-site="attach"],[role="menu"]')).toBe(null);
  expect(s.client.state.getState().disclosureOpen).toBe(false);
});
