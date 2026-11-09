/** Runtime regression for the handoff clock, with the real populated card (#1179, #3417). */
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

/**
 * Block the main thread, as a loaded runner does, without touching the
 * component. Kept real time: the stall is the stimulus. It must also delay the
 * browser's own animation ends and frames, which a fake clock cannot hold back.
 */
function stallAfter(delay: number, ms: number) {
  setTimeout(() => {
    const start = performance.now();
    while (performance.now() - start < ms) { /* a long task */ }
  }, delay);
}

const drive = (host: HTMLElement, beforeLand = 0, stall?: { at: number; ms: number }) => playHandoff({
  canvasElement: host,
  canvas: {findByRole: async (_role, {name}) => [...host.querySelectorAll("button")].find(b => b.textContent === name)!},
  userEvent: {click: async element => {
    if (element.textContent === "Land" && beforeLand) await new Promise(resolve => setTimeout(resolve, beforeLand));
    (element as HTMLElement).click();
    if (element.textContent === "Land" && stall) stallAfter(stall.at, stall.ms);
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

  // #3417: a long task spanning the fade's end delays the removal timers, the
  // fades' own ends and every frame alike; it is not component handoff time.
  test(`${theme}: a main-thread stall across the fade's end is outside the handoff budget`, async () => {
    await withCard(theme, async host => {
      await drive(host, 0, { at: 590, ms: 150 });
      expect(host.querySelectorAll(".bk-ghost, .bk-ghost-out")).toHaveLength(0);
    });
  });

  test(`${theme}: a handoff held 200ms past its fade at only 720px still fails`, async () => {
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
        await expect(drive(host)).rejects.toThrow(/720px: frames rendered with the ghost after its fade ended/);
        expect(handoffTimers).toBe(2);
      } finally {
        timer.mockRestore();
      }
    });
  });
}
