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
      expect(text).toContain("Corpus");
      expect(text).not.toMatch(/NaN|\$0\.00/);
      expect(sections(container).filter((s) => s === "tiles")).toHaveLength(1);
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
