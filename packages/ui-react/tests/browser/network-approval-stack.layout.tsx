import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ClientMessage, NetworkApprovalOffer } from "@schlessera/brain-ui-sdk/protocol";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ChatApprovalStack } from "../../src/components/chat/approval-stack.js";

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement;
let viewport: { width: number; height: number }, outer: { width: number; height: number }, themeBefore: string | undefined;

beforeEach(() => {
  viewport = { width: innerWidth, height: innerHeight };
  themeBefore = document.documentElement.dataset.theme;
});
beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(() => styles.remove());
afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  root?.dispose();
  host?.remove();
  renderer = undefined;
  root = undefined;
  host = undefined;
  if (themeBefore === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = themeBefore;
  await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
});

function offer(hostName: string, overrides: Partial<NetworkApprovalOffer> = {}): NetworkApprovalOffer {
  return {
    transport: "http",
    scheme: "https",
    host: hostName,
    port: 443,
    scopes: ["once", "origin", "session"],
    ...overrides,
  };
}

for (const width of [320, 1280]) {
  for (const theme of ["dark", "light"] as const) {
    test(`${theme} ${width}: ChatApprovalStack sits above Composer with >=44px targets, zero overflow, and zero layout shift across arming`, async () => {
      outer = await commands.formViewport(width, 900);
      await page.viewport(width, 900);
      document.documentElement.dataset.theme = theme;

      root = createBrainUiRoot({ storage: null });
      root.stores.ui.getState().setSingleKeyShortcuts(true);
      const chat = root.stores.chat.getState();
      chat.setActiveSession("ithaca");
      chat.requestToolApproval(
        "ithaca",
        "net-1",
        "Network",
        { host: "harbor-dispatch.odysseus.example", port: 443, method: "GET", protocol: "https:" },
        "Allow GET to harbor-dispatch.odysseus.example after web_fetch?",
        "command",
        false,
        "turn-1",
        undefined,
        {
          origin: "https://harbor-dispatch.odysseus.example:443",
          revision: "rev-1",
          network: offer("harbor-dispatch.odysseus.example"),
        }
      );
      chat.requestToolApproval(
        "ithaca",
        "net-2",
        "Network",
        { host: "pylos.example", port: 443, method: "GET", protocol: "https:" },
        "Allow GET to pylos.example after web_fetch?",
        "command",
        false,
        "turn-1",
        undefined,
        {
          origin: "https://pylos.example:443",
          revision: "rev-2",
          network: offer("pylos.example"),
        }
      );

      const sent: ClientMessage[] = [];
      const send = (msg: ClientMessage) => { sent.push(msg); return true; };

      host = document.createElement("div");
      host.style.cssText = `width:${width}px;height:900px;display:flex;flex-direction:column;justify-content:flex-end;background:var(--bk-color-canvas);color:var(--bk-color-ink);overflow:hidden;box-sizing:border-box;`;
      document.body.append(host);
      renderer = createRoot(host);
      flushSync(() => {
        renderer!.render(
          <BrainUiProvider root={root!}>
            <ChatApprovalStack send={send} armingMs={120} />
            <div data-test-composer="" style={{ padding: "8px 16px", borderTop: "1px solid var(--bk-color-edge)" }}>
              <textarea aria-label="Message composer" style={{ width: "100%", height: "44px" }} />
            </div>
          </BrainUiProvider>
        );
      });

      const stackEl = host.querySelector<HTMLElement>("[data-chat-approval-stack]")!;
      const composerEl = host.querySelector<HTMLElement>("[data-test-composer]")!;
      expect(stackEl).not.toBeNull();
      expect(composerEl).not.toBeNull();

      // Stack sits cleanly above the composer without overlapping it.
      const stackRect = stackEl.getBoundingClientRect();
      const composerRect = composerEl.getBoundingClientRect();
      expect(stackRect.bottom, "STACK_ABOVE_COMPOSER").toBeLessThanOrEqual(composerRect.top + 1);

      // Every card fits horizontally with no clipping and every decision target is >=44px tall.
      const cards = [...host.querySelectorAll<HTMLElement>("[data-kit-network-approval-card]")];
      expect(cards).toHaveLength(2);
      for (const card of cards) {
        expect(card.scrollWidth, "NO_HORIZONTAL_OVERFLOW").toBeLessThanOrEqual(card.clientWidth + 1);
        const buttons = [...card.querySelectorAll<HTMLElement>('[role="button"]')];
        expect(buttons.length).toBeGreaterThanOrEqual(2);
        for (const btn of buttons) {
          expect(btn.getBoundingClientRect().height, "TOUCH_TARGET_44PX").toBeGreaterThanOrEqual(44);
        }
      }

      // Trigger an in-place revision update so updateNotice mounts while armed, then verify
      // zero button layout shift when arming transitions from `armed` -> `updated`.
      flushSync(() => {
        root!.stores.chat.getState().requestToolApproval(
          "ithaca",
          "net-1",
          "Network",
          { host: "harbor-dispatch.odysseus.example", port: 443, method: "GET", protocol: "https:" },
          "Allow GET to harbor-dispatch.odysseus.example after web_fetch and inbox_content?",
          "command",
          false,
          "turn-1",
          undefined,
          {
            origin: "https://harbor-dispatch.odysseus.example:443",
            revision: "rev-1b",
            network: offer("harbor-dispatch.odysseus.example"),
          }
        );
      });

      const firstCard = host.querySelector<HTMLElement>('[data-network-approval-group="https://harbor-dispatch.odysseus.example:443"] [data-kit-network-approval-card]')!;
      expect(firstCard.dataset.networkState, "UPDATED_CARD_STARTS_ARMED").toBe("armed");
      expect(firstCard.querySelector("[data-kit-update-notice]"), "UPDATE_NOTICE_PRESENT_WHILE_ARMED").not.toBeNull();
      const armedBoxes = [...firstCard.querySelectorAll<HTMLElement>('[role="button"]')].map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, height: r.height };
      });

      // Wait for the 120ms arming window to finish (`armed` -> `updated`).
      await expect.poll(() => firstCard.dataset.networkState, { timeout: 2000 }).toBe("updated");
      const updatedBoxes = [...firstCard.querySelectorAll<HTMLElement>('[role="button"]')].map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, height: r.height };
      });
      expect(updatedBoxes).toHaveLength(armedBoxes.length);
      for (let i = 0; i < armedBoxes.length; i++) {
        expect(Math.abs(updatedBoxes[i]!.top - armedBoxes[i]!.top), "ZERO_VERTICAL_LAYOUT_SHIFT_ON_ARM_END").toBeLessThanOrEqual(0.5);
        expect(Math.abs(updatedBoxes[i]!.height - armedBoxes[i]!.height), "ZERO_HEIGHT_SHIFT_ON_ARM_END").toBeLessThanOrEqual(0.5);
      }

      // Keyboard shortcut `a` on the focused group sends narrowest choice (`once`).
      const groupEl = host.querySelector<HTMLElement>('[data-network-approval-group="https://harbor-dispatch.odysseus.example:443"]')!;
      groupEl.focus();
      await userEvent.keyboard("a");
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0]).toEqual({
        type: "tool_approval",
        toolUseId: "net-1",
        turnId: "turn-1",
        revision: "rev-1b",
        networkScope: "once",
        channel: "card",
      });
    });
  }
}

test("320px phone soft-keyboard shrink collapses stack and keeps Composer uncovered", async () => {
  outer = await commands.formViewport(320, 640);
  await page.viewport(320, 640);
  document.documentElement.dataset.theme = "dark";

  root = createBrainUiRoot({ storage: null });
  const chat = root.stores.chat.getState();
  chat.setActiveSession("ithaca");
  chat.requestToolApproval(
    "ithaca",
    "net-kb-1",
    "Network",
    { host: "ithaca.example", port: 443, method: "GET", protocol: "https:" },
    "Allow GET to ithaca.example?",
    "command",
    false,
    "turn-1",
    undefined,
    { origin: "https://ithaca.example:443", revision: "rev-kb", network: offer("ithaca.example") }
  );

  const realVV = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const listeners = new Set<() => void>();
  let vvHeight = 640;
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: {
      get height() { return vvHeight; },
      addEventListener: (_e: string, cb: () => void) => { listeners.add(cb); },
      removeEventListener: (_e: string, cb: () => void) => { listeners.delete(cb); },
    },
  });

  try {
    host = document.createElement("div");
    host.style.cssText = "width:320px;height:360px;display:flex;flex-direction:column;justify-content:flex-end;background:var(--bk-color-canvas);color:var(--bk-color-ink);";
    document.body.append(host);
    renderer = createRoot(host);
    flushSync(() => {
      renderer!.render(
        <BrainUiProvider root={root!}>
          <ChatApprovalStack send={() => true} armingMs={0} />
          <div data-test-composer="" style={{ padding: "8px 16px", borderTop: "1px solid var(--bk-color-edge)" }}>
            <textarea aria-label="Message composer" style={{ width: "100%", height: "44px" }} />
          </div>
        </BrainUiProvider>
      );
    });

    // Shrink visualViewport to simulate soft keyboard opening (<78% of innerHeight).
    vvHeight = 360;
    flushSync(() => {
      for (const cb of listeners) cb();
    });

    const stack = host.querySelector<HTMLElement>("[data-kit-approval-stack]")!;
    expect(stack.dataset.collapsed, "STACK_COLLAPSED_ON_MOBILE_KEYBOARD").toBe("true");
    const stackRect = stack.getBoundingClientRect();
    const composerRect = host.querySelector<HTMLElement>("[data-test-composer]")!.getBoundingClientRect();
    expect(stackRect.bottom, "COLLAPSED_BAR_DOES_NOT_COVER_COMPOSER").toBeLessThanOrEqual(composerRect.top + 1);
    expect(composerRect.bottom, "COMPOSER_VISIBLE_ABOVE_KEYBOARD").toBeLessThanOrEqual(360 + 1);
  } finally {
    if (realVV) Object.defineProperty(window, "visualViewport", realVV);
    else Reflect.deleteProperty(window, "visualViewport");
  }
});
