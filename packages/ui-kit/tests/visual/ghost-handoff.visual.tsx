/** Runtime regression for the handoff clock, with the real populated card. */
import { expect, test, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Handoff, playHandoff } from "../../stories/_ghost.js";
import { ActionCard } from "../../src/decisions/ActionCard.js";
import { actions } from "../../fixtures/actions.js";
import "../../src/tokens.css";
import "../../src/theme.css";

async function withCard(theme: string, run: (host: HTMLElement) => Promise<void>) {
  const previous = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = theme;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const { thread: _thread, ...card } = actions[0]!;
  try {
    flushSync(() => root.render(<Handoff render={loading => <ActionCard state={loading ? "loading" : "ready"} {...card} />} />));
    await run(host);
  } finally {
    flushSync(() => root.unmount()); host.remove();
    if (previous === undefined) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = previous;
  }
}

const drive = (host: HTMLElement, beforeLand = 0) => playHandoff({
  canvasElement: host,
  canvas: {findByRole: async (_role, {name}) => [...host.querySelectorAll("button")].find(b => b.textContent === name)!},
  userEvent: {click: async element => {
    if (element.textContent === "Land" && beforeLand) await new Promise(resolve => setTimeout(resolve, beforeLand));
    (element as HTMLElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
  }},
});

for (const theme of ["dark", "light"]) {
  test(`${theme}: input orchestration before Land is outside the arrival budget`, async () => {
    await withCard(theme, async host => {
      await drive(host, 180);
      expect(host.querySelectorAll("[data-width]")).toHaveLength(2);
      expect(host.querySelectorAll(".bk-ghost, .bk-ghost-out")).toHaveLength(0);
    });
  });

  test(`${theme}: an 800ms handoff at only 720px still fails the 700ms cap`, async () => {
    await withCard(theme, async host => {
      const nativeTimeout = globalThis.setTimeout;
      let handoffTimers = 0;
      const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: unknown[]) => {
        // Native timers and React execute normally. Hold only the second
        // frame's outgoing layer beyond budget; the first frame stays valid.
        if (args[1] === 600 && ++handoffTimers === 2) args[1] = 800;
        return Reflect.apply(nativeTimeout, globalThis, args);
      }) as typeof nativeTimeout);
      try {
        await expect(drive(host)).rejects.toThrow(/less than 700/);
        expect(handoffTimers).toBe(2);
      } finally {
        timer.mockRestore();
      }
    });
  });
}
