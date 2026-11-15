/** Runtime regression for the handoff clock, with the real populated card (#1179, #3417, #3425). */
import { expect, test } from "vitest";
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

/** A long task in the arrival's own task, after React has committed it and
 * before the browser can render the frame that starts its fades (#3425). */
function stallNow(ms: number) {
  const start = performance.now();
  while (performance.now() - start < ms) { /* a long task */ }
}

const drive = (host: HTMLElement, beforeLand = 0, stall?: { at: number; ms: number }, commitStall = 0) => playHandoff({
  canvasElement: host,
  canvas: {findByRole: async (_role, {name}) => [...host.querySelectorAll("button")].find(b => b.textContent === name)!},
  userEvent: {click: async element => {
    if (element.textContent === "Land" && beforeLand) await new Promise(resolve => setTimeout(resolve, beforeLand));
    (element as HTMLElement).click();
    if (element.textContent === "Land" && commitStall) stallNow(commitStall);
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

  // #3425: the fades start on the first frame after the commit. A long task
  // right after the commit makes that frame late; the ghost must still fade
  // to its end before it goes, rather than be cut at 600ms from the commit.
  test(`${theme}: a long task right after arrival delays the fades, and each ghost still fades to its end`, async () => {
    await withCard(theme, async host => {
      await drive(host, 0, undefined, 300);
      expect(host.querySelectorAll(".bk-ghost, .bk-ghost-out")).toHaveLength(0);
    });
  });

  test(`${theme}: a handoff held 200ms past its fade at only 720px still fails`, async () => {
    await withCard(theme, async host => {
      // The handoff ends when both of its fades have. Hold only the second
      // frame's incoming fade 200ms longer; its outgoing fade, and the first
      // frame, stay valid, so the 720px ghost outlives its own fade.
      const hold = document.createElement("style");
      hold.textContent = '[data-width="720"] .bk-ghost-in { animation-duration: 800ms !important; }';
      document.head.append(hold);
      try {
        await expect(drive(host)).rejects.toThrow(/720px: frames rendered with the ghost after its fade ended/);
      } finally {
        hold.remove();
      }
    });
  });
}
