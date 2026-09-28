// The /stats command end to end in happy-dom (#97): both channels asked, the
// answer attached to the assistant message as kit blocks, and the message
// bubble drawing them — no markdown bullet list anywhere. Queries come from
// `render()`, never `screen` — see tests/render/dom.ts for why.
import { unregisterStatsAnswerDom } from "./stats-answer-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, fireEvent } from "@testing-library/react";

import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { BrainApi } from "../../src/lib/api-client.js";
import { runStats, useChatCommands } from "../../src/components/chat/use-chat-commands.js";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { StatsAnswer } from "../../src/components/chat/stats/stats-answer.js";
import { composeStatsAnswer } from "../../src/components/chat/stats/compose-stats.js";
import { CLIENT_RELEASE } from "../../src/components/chat/stats/software.js";
import { corpusStats, runtimeStats } from "../stats-fixtures.js";

afterEach(cleanup);
afterAll(unregisterStatsAnswerDom);

function rootWith(api: Partial<BrainApi>): BrainUiRoot {
  const root = createBrainUiRoot({ storage: null });
  Object.assign(root.api, { status: async () => { throw new Error("offline"); } }, api);
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
        "software",
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

  test("a newer server never replaces the loaded client identity", async () => {
    const root = createBrainUiRoot({ storage: null, config: { sourceCommit: "a".repeat(40) },
      request: async (url, init) => {
        if (url.endsWith("/status")) {
          expect(init?.cache).toBe("no-store");
          return Response.json({ software: { release: "99.0.0", sourceCommit: "b".repeat(40) } });
        }
        if (url.includes("/activity/")) return Response.json(runtimeStats());
        return Response.json(corpusStats());
      },
    });
    try {
      const { container } = await answer(root);
      const software = container.querySelector('[aria-label="Software versions"]')!;
      expect(software).not.toBeNull();
      expect(software.textContent).toContain(`Client release${CLIENT_RELEASE}`);
      expect(software.textContent).toContain(`Client build${"a".repeat(40)}`);
      expect(software.textContent).toContain("Server release99.0.0");
      expect(software.textContent).toContain("Client and server differ");
    } finally { root.dispose(); }
  });

  test("stats opens offline and shows local identity before requests settle", async () => {
    let finishStatus!: (value: Awaited<ReturnType<BrainApi["status"]>>) => void;
    const root = rootWith({
      brainStats: async () => corpusStats({ documents: 0 }),
      activityStats: async () => runtimeStats(),
      status: () => new Promise((resolve) => { finishStatus = resolve; }),
    });
    function Shortcut() {
      const command = useChatCommands();
      return <button onClick={() => command("stats")}>Stats</button>;
    }
    try {
      expect(root.stores.connection.getState().wsStatus).not.toBe("connected");
      const drawn = render(<BrainUiProvider root={root}><Shortcut /></BrainUiProvider>);
      fireEvent.click(drawn.getByText("Stats"));
      const local = root.stores.chat.getState().draft!.messages.at(-1)!;
      expect(local.statsAnswer?.[0]).toMatchObject({ kind: "software", details: {
        client: { release: CLIENT_RELEASE }, state: "Checking server",
      } });
      finishStatus({ healthy: true, uptime: 0, cronJobs: [], activeSession: false });
      // Let all three settled requests update the transcript.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const complete = root.stores.chat.getState().draft!.messages.at(-1)!;
      expect(complete.isStreaming).toBe(false);
      expect(complete.statsAnswer?.at(-1)).toMatchObject({ kind: "software", details: {
        state: "Build match unverified", server: { release: null, sourceCommit: null },
      } });
    } finally { root.dispose(); }
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
      expect(message.statsAnswer?.some((s) => s.kind === "software")).toBe(true);
    } finally {
      root.dispose();
    }
  });

  test("all requests failing preserves the loaded client identity", async () => {
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
      expect(message.content).toBe("");
      expect(container.textContent).toContain(CLIENT_RELEASE);
      expect(container.textContent).toContain("Server unavailable: offline");
      expect(message.statsAnswer?.some((s) => s.kind === "software")).toBe(true);
      expect(sections(container)).toEqual(["callout", "callout", "software"]);
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
