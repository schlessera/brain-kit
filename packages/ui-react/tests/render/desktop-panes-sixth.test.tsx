// The sixth pass's rulings on the desktop panes (design README, "Sixth pass —
// rulings" §3, §4, §7, §8), rendered in happy-dom. Same containment contract
// as render-smoke.test.tsx: the DOM module first, `afterAll(unregisterDom)`, queries
// off `render()` and never `screen`. The test window is 1024px wide, so the
// `laptop:` shapes render; the `wide:` evidence rails are in the tree behind
// a CSS class, which is exactly what §3a asks to be true.
import { unregisterDesktopPanesDom as unregisterDom } from "./desktop-panes-sixth-dom.js";

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, forwardRef, type ReactNode } from "react";
import type { GraphNodePayload } from "@schlessera/brain-ui-sdk/protocol";

import { FilePanel } from "../../src/components/files/file-panel.js";
import { STALE_AFTER_DAYS, ageInDays, formatAge, isStale } from "../../src/components/files/staleness.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { GraphPage } from "../../src/components/graph/graph-page.js";
import { entityKind, entityLegend } from "../../src/components/graph/lib/graph-helpers.js";
import { useFileStore } from "../../src/stores/file-store.js";
import { useActivityStore } from "../../src/stores/activity-store.js";
import { useGraphStore } from "../../src/stores/graph-store.js";
import { useUIStore } from "../../src/stores/ui-store.js";

function createMotionElement(tag: string) {
  return forwardRef<HTMLElement, Record<string, unknown>>(
    ({ initial: _i, animate: _a, exit: _e, transition: _t, ...props }, ref) => createElement(tag, { ...props, ref })
  );
}
const motionElements = new Map<string, ReturnType<typeof createMotionElement>>();
mock.module("framer-motion", () => ({
  useReducedMotion: () => true,
  AnimatePresence: ({ children }: { children?: ReactNode }) => children,
  motion: new Proxy({}, {
    get: (_target, tag: string) => {
      const existing = motionElements.get(tag);
      if (existing) return existing;
      const element = createMotionElement(tag);
      motionElements.set(tag, element);
      return element;
    },
  }),
}));
// happy-dom has no WebGL; the canvas is runtime-tested in a real browser.
mock.module("../../src/components/graph/graph-canvas.js", () => ({
  default: () => <div data-testid="graph-canvas" />,
}));

afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  unregisterDom();
});

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const DAY = 24 * 60 * 60 * 1000;

/* ── §3 · the Files rail ─────────────────────────────────────────────────── */

describe("staleness from mtime", () => {
  test("the threshold is named, the age is whole days, and the line reads as the rail prints it", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    expect(STALE_AFTER_DAYS).toBe(30);
    expect(ageInDays(now - 24 * DAY - 1000, now)).toBe(24);
    expect(isStale(now - 29 * DAY, now)).toBe(false);
    expect(isStale(now - 30 * DAY, now)).toBe(true);
    expect(formatAge(0)).toBe("today");
    expect(formatAge(1)).toBe("1 day ago");
    expect(formatAge(24)).toBe("24 days ago");
  });
});

describe("Files rail (sixth pass §3)", () => {
  function openFile(opts: { path: string; content: string; kind?: "markdown" | "text"; mtime: number }) {
    useFileStore.setState({
      dirCache: {
        "": [
          { name: "notes", path: "notes", type: "dir", mtime: Date.now() },
          { name: "old.md", path: "old.md", type: "file", mtime: Date.now() - 38 * DAY },
          { name: "fresh.md", path: "fresh.md", type: "file", mtime: Date.now() - 2 * DAY },
          { name: "unknown.md", path: "unknown.md", type: "file" },
        ],
        notes: [{ name: "a.md", path: "notes/a.md", type: "file", mtime: Date.now() }],
      },
      expandedDirs: new Set([""]),
      currentPath: opts.path,
      currentContent: { path: opts.path, kind: opts.kind ?? "markdown", size: 12, mtime: opts.mtime, content: opts.content },
      contentLoading: false,
      contentError: null,
      loadDir: async () => {},
    });
  }

  test("the rail stays mounted with a file open that has no frontmatter; only the blocks with data are drawn", async () => {
    openFile({ path: "fresh.md", content: "# Fresh\n\nno frontmatter here", mtime: Date.now() - 2 * DAY });
    const view = render(<FilePanel open onClose={() => {}} />);
    await act(flushPromises);
    const rail = view.getByRole("complementary", { name: "Evidence" });
    expect(rail.querySelector('[data-rail-block="frontmatter"]')).toBeNull();
    const modified = rail.querySelector('[data-rail-block="modified"]')!;
    expect(modified).toBeTruthy();
    expect(modified.hasAttribute("data-stale")).toBe(false);
    expect(modified.textContent).toContain("modified 2 days ago · stale after 30");
    expect(rail.textContent).not.toContain("Linked from");
    expect(rail.textContent).not.toContain("Provenance");
    view.unmount();
  });

  test("past the threshold the Modified block turns gold and says so; frontmatter draws beside it when present", async () => {
    openFile({ path: "old.md", content: "---\ntitle: Old\nstatus: hold\n---\n\nbody", mtime: Date.now() - 38 * DAY });
    const view = render(<FilePanel open onClose={() => {}} />);
    await act(flushPromises);
    const rail = view.getByRole("complementary", { name: "Evidence" });
    expect(rail.querySelector('[data-rail-block="frontmatter"]')!.textContent).toContain("2 keys");
    const modified = rail.querySelector('[data-rail-block="modified"]')!;
    expect(modified.hasAttribute("data-stale")).toBe(true);
    expect(modified.textContent).toContain("modified 38 days ago · stale past 30");
    view.unmount();
  });

  test("the tree marks a stale file from its own mtime — gold dot and mono meta — and leaves folders and files without mtime alone", async () => {
    openFile({ path: "fresh.md", content: "x", kind: "text", mtime: Date.now() });
    const view = render(<FilePanel open onClose={() => {}} />);
    // The real lazy tree can settle after a microtask drain. Observe its row.
    const stale = await view.findByRole("treeitem", { name: /old\.md/ }, { timeout: 5000 });
    expect(stale.textContent).toContain("stale 38d");
    expect(view.getByRole("treeitem", { name: /fresh\.md/ }).textContent).not.toContain("stale");
    expect(view.getByRole("treeitem", { name: /unknown\.md/ }).textContent).not.toContain("stale");
    expect(view.getByRole("treeitem", { name: /notes/ }).textContent).not.toContain("stale");
    view.unmount();
  });

  test("Untrusted only is drawn, disabled, with its reason in mono — never omitted", async () => {
    openFile({ path: "fresh.md", content: "x", kind: "text", mtime: Date.now() });
    const view = render(<FilePanel open onClose={() => {}} />);
    await act(flushPromises);
    const toggle = view.getByRole("switch", { name: "Untrusted only" });
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("tabindex")).toBe("-1");
    expect(toggle.closest("[data-disabled-row]")!.textContent).toContain("needs provenance");
    view.unmount();
  });
});

describe("Files tree keys (sixth pass §8)", () => {
  test("→ opens a closed folder and ← closes it through the store; the footer prints ← → and ⏎ even with single-key shortcuts off", async () => {
    const toggled: string[] = [];
    useFileStore.setState({
      dirCache: { "": [{ name: "notes", path: "notes", type: "dir" }], notes: [] },
      expandedDirs: new Set([""]),
      currentPath: null,
      currentContent: null,
      loadDir: async () => {},
      toggleDir: async (path) => {
        toggled.push(path);
        const next = new Set(useFileStore.getState().expandedDirs);
        if (next.has(path)) next.delete(path); else next.add(path);
        useFileStore.setState({ expandedDirs: next });
      },
    });
    useUIStore.getState().setSingleKeyShortcuts(false);
    try {
      const view = render(<FilePanel open onClose={() => {}} />);
      const folder = await view.findByRole("treeitem", { name: /notes/ }, { timeout: 5000 });
      const pane = view.getByRole("dialog", { name: "Files" });
      expect(pane.textContent).toContain("← → fold · ⏎ open");
      expect(pane.textContent).not.toContain("j / k");

      expect(folder.getAttribute("aria-expanded")).toBe("false");
      fireEvent.keyDown(folder, { key: "ArrowLeft" });
      expect(toggled).toEqual([]);
      fireEvent.keyDown(folder, { key: "ArrowRight" });
      expect(toggled).toEqual(["notes"]);
      expect(view.getByRole("treeitem", { name: /notes/ }).getAttribute("aria-expanded")).toBe("true");
      fireEvent.keyDown(view.getByRole("treeitem", { name: /notes/ }), { key: "ArrowRight" });
      expect(toggled).toEqual(["notes"]);
      fireEvent.keyDown(view.getByRole("treeitem", { name: /notes/ }), { key: "ArrowLeft" });
      expect(toggled).toEqual(["notes", "notes"]);
      view.unmount();
    } finally {
      useUIStore.getState().setSingleKeyShortcuts(true);
    }
  });
});

/* ── §4 · dismissal is silent ─────────────────────────────────────────────── */

describe("Actions dismissal (sixth pass §4)", () => {
  test("Dismiss all leaves no receipt; the drained section is the empty state with its heading focused", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/activity/inbox") && !url.includes("/ack")) {
        return Response.json({
          intents: [1, 2].map((n) => ({
            id: n, runId: `run-${n}`, spanId: null, kind: "failure", tag: "t",
            title: `Intent ${n}`, body: "", status: "pending", acknowledged: false, createdAt: Date.now(),
          })),
        });
      }
      if (url.includes("/activity/runs?")) return Response.json({ live: [], history: [] });
      if (url.includes("/activity/rollups")) return Response.json({ timeZone: "UTC", days: [] });
      if (url.includes("/models/pricing")) return Response.json({ stale: false, error: null });
      if (url.includes("/ack")) return Response.json({ ok: true });
      return Response.json({ error: "not_found" }, { status: 404 });
    }) as typeof fetch;
    const page = render(<ActivityPage />);
    const intents = await page.findAllByRole("button", { name: /Intent \d/ }, { timeout: 5000 });
    expect(intents).toHaveLength(2);
    fireEvent.click(page.getByRole("button", { name: "Dismiss all" }));
    const empty = await page.findByRole("heading", { name: "Nothing is waiting on you" }, { timeout: 5000 });
    expect(useActivityStore.getState().inbox).toEqual([]);
    expect(page.queryByText("Dismissed")).toBeNull();
    expect(page.queryByText("2 items")).toBeNull();
    expect(empty).toBeTruthy();
    page.unmount();
  });
});

/* ── §7 · colour by entity, the caption names the active rule ─────────────── */

const NODES: GraphNodePayload[] = [
  { id: 1, path: "people/penelope.md", title: "Penelope", type: "person", inDegree: 1, outDegree: 1, distance: 0, community: 0 },
  { id: 2, path: "companies/phaeacian-yard.md", title: "Phaeacian yard", type: "company", inDegree: 1, outDegree: 0, distance: 1, community: 0 },
  { id: 3, path: "projects/pricing.md", title: "Pricing", type: "project", inDegree: 1, outDegree: 0, distance: 1, community: 1 },
  { id: 4, path: "notes/ithaca.md", title: "Ithaca", type: "note", inDegree: 0, outDegree: 1, distance: 2, community: 1 },
  { id: 5, path: "notes/ogygia.md", title: "Ogygia", type: "note", inDegree: 0, outDegree: 1, distance: 2 },
];

describe("entity colouring helpers", () => {
  test("the three entity kinds map; every other type is listed by name under neutral", () => {
    expect(entityKind("person")).toBe("person");
    expect(entityKind("journal")).toBeNull();
    const legend = entityLegend(NODES);
    expect(legend.map((r) => [r.type, r.kind, r.count])).toEqual([
      ["person", "person", 1],
      ["company", "company", 1],
      ["project", "project", 1],
      ["note", null, 2],
    ]);
  });
});

describe("Graph colour rule (sixth pass §7)", () => {
  function localScene() {
    useGraphStore.setState({
      mode: "local",
      local: { center: "people/penelope.md", depth: 2, direction: "both" },
      meta: {
        available: true, schemaVersion: 8, computedAt: "2026-09-09T00:00:00Z", stale: false,
        nodeCount: 4812, edgeCount: 0, communities: [{ community: 0, size: 2, label: "Ithaca", topTerms: [] }, { community: 1, size: 2, label: null, topTerms: [] }], defaultRoot: null,
      },
      metaState: "done",
      subgraph: { nodes: NODES, edges: [{ source: 1, target: 2 }, { source: 1, target: 3 }, { source: 4, target: 1 }, { source: 5, target: 1 }], truncated: false },
      dataState: "done",
      discoveryColorBy: "distance",
      fetchMeta: async () => {},
      fetchScene: async () => {},
    });
  }

  test("the Colour row offers topic · distance · folder · entity, and the caption and legend follow the ACTIVE rule", async () => {
    localScene();
    const page = render(<GraphPage />);
    await act(flushPromises);
    const column = page.getByRole("complementary", { name: "Graph controls" });
    const colour = [...column.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(colour).toEqual(expect.arrayContaining(["Topic", "Distance", "Folder", "Entity"]));

    expect(page.getByText(/colour = distance/)).toBeTruthy();
    expect(document.querySelector('[data-legend="distance"]')).toBeTruthy();

    fireEvent.click(page.getByRole("tab", { name: "Entity" }));
    expect(useGraphStore.getState().discoveryColorBy).toBe("entity");
    expect(page.getByText(/colour = entity type/)).toBeTruthy();
    const legend = document.querySelector('[data-legend="entity"]')!;
    expect(legend.textContent).toContain("focus");
    // The centre is the only person, and it is painted amber as the focus,
    // not teal as a person — so the legend does not count it as one.
    expect(legend.textContent).not.toContain("person");
    expect(legend.textContent).toContain("company");
    expect(legend.textContent).toContain("project");
    expect(legend.textContent).toContain("note");
    expect(document.querySelector('[data-legend="distance"]')).toBeNull();

    fireEvent.click(page.getByRole("tab", { name: "Topic" }));
    expect(page.getByText(/colour = topic/)).toBeTruthy();
    const topics = document.querySelector('[data-legend="topic"]')!.textContent!;
    expect(topics).toContain("Ithaca");
    // Community 0 holds the focus and one company; only the company is counted.
    expect(topics).toContain("Ithaca1");

    fireEvent.click(page.getByRole("tab", { name: "Folder" }));
    expect(page.getByText(/colour = folder/)).toBeTruthy();
    page.unmount();
  });

  test("Mark stale and Untrusted only are drawn disabled with their reasons, and the footer prints both in gold — nodes carry neither", async () => {
    localScene();
    const page = render(<GraphPage />);
    await act(flushPromises);
    const column = page.getByRole("complementary", { name: "Graph controls" });
    const stale = page.getByRole("switch", { name: "Mark stale" });
    expect(stale.getAttribute("aria-disabled")).toBe("true");
    expect(stale.closest("[data-disabled-row]")!.textContent).toContain("needs mtime");
    const untrusted = page.getByRole("switch", { name: "Untrusted only" });
    expect(untrusted.getAttribute("aria-disabled")).toBe("true");
    expect(untrusted.closest("[data-disabled-row]")!.textContent).toContain("needs provenance");
    expect(column.textContent).toContain("5 of 4,812 nodes drawn");
    expect(column.textContent).toContain("stale needs mtime · untrusted needs provenance");
    page.unmount();
  });
});
