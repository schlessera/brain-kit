// The /stats command end to end in happy-dom (#97): both channels asked, the
// answer attached to the assistant message as kit blocks, and the message
// bubble drawing them — no markdown bullet list anywhere. Queries come from
// `render()`, never `screen` — see tests/render/dom.ts for why.
import { unregisterStatsAnswerDom } from "./stats-answer-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { BrainApi } from "../../src/lib/api-client.js";
import { runStats } from "../../src/components/chat/use-chat-commands.js";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { StatsAnswer } from "../../src/components/chat/stats/stats-answer.js";
import { composeStatsAnswer } from "../../src/components/chat/stats/compose-stats.js";
import { corpusStats, runtimeStats } from "../stats-fixtures.js";

afterEach(cleanup);
afterAll(unregisterStatsAnswerDom);

function rootWith(api: Partial<BrainApi>): BrainUiRoot {
  const root = createBrainUiRoot({ storage: null });
  Object.assign(root.api, api);
  return root;
}

async function answer(root: BrainUiRoot) {
  await runStats(root, null);
  const messages = root.stores.chat.getState().draft?.messages ?? [];
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") throw new Error("no assistant message");
  const drawn = render(
    <BrainUiProvider root={root}>
      <MessageBubble message={last} onToolApproval={() => {}} onAskUserSubmit={() => {}} onAskUserCancel={() => {}} />
    </BrainUiProvider>
  );
  return { message: last, container: drawn.container };
}

const sections = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-stats-section]")].map((el) => el.getAttribute("data-stats-section"));

describe("/stats", () => {
  test("answers with tiles, bars and receipts, and no markdown bullets", async () => {
    const root = rootWith({
      brainStats: async () => corpusStats(),
      activityStats: async () => runtimeStats(),
    });
    try {
      const { message, container } = await answer(root);
      expect(message.content).toBe("");
      expect(message.isStreaming).toBe(false);
      expect(sections(container)).toEqual([
        "callout",
        "tiles",
        "tiles",
        "bars",
        "bars",
        "bars",
        "receipt",
        "receipt",
        "receipt",
        "receipt",
      ]);
      const text = container.textContent ?? "";
      // The four figures the bullet list dropped.
      for (const figure of ["3,118", "2,557", "54 · 5.4%", "medium"]) expect(text).toContain(figure);
      expect(text).not.toContain("Brain Statistics");
      expect(container.querySelector("li")).toBeNull();
    } finally {
      root.dispose();
    }
  });

  test("a failed runtime call leaves the corpus whole and says the runtime is unavailable", async () => {
    const root = rootWith({
      brainStats: async () => corpusStats(),
      activityStats: async () => {
        throw new Error("timeout");
      },
    });
    try {
      const { container } = await answer(root);
      const text = container.textContent ?? "";
      expect(text).toContain("Runtime figures unavailable.");
      expect(text).toContain("timeout");
      // The corpus half in full: its receipt keeps all nine rows.
      const corpus = [...container.querySelectorAll('[data-stats-section="receipt"]')].find((el) =>
        el.textContent?.startsWith("Corpus")
      )!;
      expect(corpus.querySelectorAll("[data-tone]")).toHaveLength(9);
      expect(sections(container).filter((s) => s === "bars")).toHaveLength(3);
      expect(text).not.toMatch(/NaN|\$0\.00/);
      expect(sections(container).filter((s) => s === "tiles")).toHaveLength(1);
    } finally {
      root.dispose();
    }
  });

  test("a runtime that answers with nothing is unavailable, not silently absent", async () => {
    const root = rootWith({
      brainStats: async () => corpusStats(),
      activityStats: async () => null as never,
    });
    try {
      const { container } = await answer(root);
      expect(container.textContent).toContain("Runtime figures unavailable.");
      expect(container.textContent).toContain("the server returned no figures");
    } finally {
      root.dispose();
    }
  });

  test("a figure the composer cannot read ends in an error line, not a blank answer", async () => {
    const root = rootWith({
      brainStats: async () => ({ ...corpusStats(), byType: undefined as never }),
      activityStats: async () => runtimeStats(),
    });
    try {
      const { message } = await answer(root);
      expect(message.isStreaming).toBe(false);
      expect(message.content).toStartWith("**Error:** ");
      expect(message.statsAnswer).toBeUndefined();
    } finally {
      root.dispose();
    }
  });

  test("both calls failing falls back to one error line", async () => {
    const root = rootWith({
      brainStats: async () => {
        throw new Error("no brain.db");
      },
      activityStats: async () => {
        throw new Error("timeout");
      },
    });
    try {
      const { message, container } = await answer(root);
      expect(message.content).toBe("**Error:** no brain.db");
      expect(message.statsAnswer).toBeUndefined();
      expect(sections(container)).toEqual([]);
    } finally {
      root.dispose();
    }
  });
});

describe("the bar track follows the width", () => {
  /** Every bar list's track width, read from what was drawn. */
  function trackWidths(wide: boolean): string[] {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: wide && query === "(min-width: 640px)",
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    try {
      const sections = composeStatsAnswer({
        corpus: { ok: true, value: corpusStats() },
        runtime: { ok: true, value: runtimeStats() },
      });
      const { container } = render(<StatsAnswer sections={sections} />);
      const bars = [...container.querySelectorAll('[data-stats-section="bars"]')];
      // The track is the one fixed-width span beside each label.
      return bars.map((b) => {
        const track = [...b.querySelectorAll<HTMLElement>("span")].find((el) => el.style.height === "5px");
        return track?.style.width ?? "none";
      });
    } finally {
      window.matchMedia = original;
      cleanup();
    }
  }

  test("a phone gets the 56px track, a desktop column the 120px one", () => {
    expect(trackWidths(false)).toEqual(["56px", "56px", "56px"]);
    expect(trackWidths(true)).toEqual(["120px", "120px", "120px"]);
  });
});
