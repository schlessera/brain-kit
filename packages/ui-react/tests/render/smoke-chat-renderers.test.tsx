// Render smoke tests for chat renderers, tool timelines, capture recovery and the session drawer: mount the components in happy-dom and
// assert the DOM they produce. Fixtures are minimal and keyless; nothing here
// touches the network. Shared setup: ./smoke-harness.tsx.
//
// The DOM module import MUST stay first: it registers the happy-dom globals
// before the component module bodies run (./dom.ts explains why, and why
// `screen` must not be used).
import { registerSmokeChatRenderersDom, unregisterSmokeChatRenderersDom } from "./smoke-chat-renderers-dom.js";
registerSmokeChatRenderersDom();

import { installSmokeHarness, changeControlledInput, flushPromises, render } from "./smoke-harness.js";
import { trackKey, tracksFor } from "../../src/lib/draft-tracks.js";
import { describe, expect, test } from "bun:test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { MarkdownContent } from "../../src/components/chat/markdown-content.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { AskUserCard } from "../../src/components/chat/ask-user-card.js";
import { ZoomViewer } from "../../src/components/viewer/zoom-viewer.js";
import type { ToolCall } from "../../src/stores/chat-store.js";
import type { AskUserQuestion } from "@schlessera/brain-ui-sdk/protocol";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { StreamingPanel } from "../../src/components/quick-actions/streaming-modal.js";
import { SessionDrawer } from "../../src/components/chat/session-drawer.js";
import { AddPanel } from "../../src/components/quick-actions/add-modal.js";
import { trackView } from "../track-fixtures.js";

installSmokeHarness(unregisterSmokeChatRenderersDom);

describe("MarkdownContent", () => {
  test("renders heading, list, and code from markdown source", () => {
    const { getByRole, getAllByRole, baseElement } = render(
      <MarkdownContent
        content={"# Field Notes\n\n- first item\n- second item\n\n`inline code`"}
      />
    );
    expect(getByRole("heading", { level: 1 }).textContent).toBe("Field Notes");
    expect(getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "first item",
      "second item",
    ]);
    expect(baseElement.querySelector("code")?.textContent).toBe("inline code");
  });
});

describe("ToolCallTimeline", () => {
  const completedRead: ToolCall = {
    id: "tool-1",
    name: "Read",
    input: { file_path: "/data/brain/notes/example.md" },
    inputJson: JSON.stringify({ file_path: "/data/brain/notes/example.md" }, null, 2),
    status: "complete",
    output: "file contents here",
  };

  test("non-live completed run mounts as the collapsed summary row only", () => {
    const { getByRole, queryByText, baseElement } = render(
      <ToolCallTimeline toolCalls={[completedRead]} onApproval={() => {}} />
    );
    // Summary row present…
    expect(getByRole("button").textContent).toContain("1 step");
    // …and the per-entry detail subtree is NOT mounted: no tool label, no
    // input JSON, no output.
    expect(queryByText("Read")).toBeNull();
    expect(baseElement.textContent).not.toContain("file_path");
    expect(baseElement.textContent).not.toContain("file contents here");
  });

  test("expanding the summary row mounts the per-tool entries", () => {
    const { getByRole, getByText } = render(
      <ToolCallTimeline toolCalls={[completedRead]} onApproval={() => {}} />
    );
    fireEvent.click(getByRole("button"));
    expect(getByText("Read")).toBeTruthy();
  });
});

describe("contract-bound tool renderers", () => {
  // The whole D3 path, through the real timeline: a tool result whose output
  // is a JSON payload resolves to the renderer bound to its contract, and the
  // component is handed the PARSED payload rather than the raw string.
  const fix = {
    latitude: 38.3653,
    longitude: 20.7169,
    accuracyMeters: 42,
    place: "Vathy",
    address: "Vathy, Ithaca, Greece",
    retrievedAt: "2026-07-12T09:15:00.000Z",
  };

  function locationCall(output: string, isError = false): ToolCall {
    return {
      id: "tool-loc",
      name: "mcp__brain-ui__get_current_location",
      input: {},
      inputJson: "{}",
      status: "complete",
      output,
      ...(isError ? { isError: true } : {}),
    } as ToolCall;
  }

  function expandAll(result: ReturnType<typeof render>) {
    fireEvent.click(result.getByRole("button"));
    const header = result
      .getAllByRole("button")
      .find((button) => button.textContent?.includes("Location"))!;
    fireEvent.click(header);
  }

  const geometry = {
    coastline: [[[20.70, 38.36], [20.72, 38.37], [20.73, 38.36]]],
    roads: [[[20.71, 38.365], [20.72, 38.366]]],
    streets: [],
    land: [[[20.70, 38.36], [20.72, 38.37], [20.73, 38.36], [20.70, 38.36]]],
    detail: "roads",
    partial: false,
    toleranceM: 8,
    attribution: "\u00a9 OpenStreetMap contributors",
  };

  test("a JSON payload renders as a map with the pin, and the shoreline arrives from the server", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json(geometry);
    }) as typeof fetch;
    const result = render(
      <ToolCallTimeline toolCalls={[locationCall(JSON.stringify(fix))]} onApproval={() => {}} />
    );
    expandAll(result);
    const text = result.baseElement.textContent ?? "";
    expect(text).toContain("Vathy");
    expect(text).toContain("38.3653, 20.7169");
    expect(text).toContain("\u00b142 m");
    // The raw JSON is gone: the reader sees the card, not the wire format.
    expect(text).not.toContain('"accuracyMeters"');
    // The pin is drawn by the kit's MapView from the payload's coordinates.
    expect(result.baseElement.querySelector("svg")).toBeTruthy();

    // One request, for the envelope of every box the map can draw, with the
    // width scaled by the same 1.5 the box is (the server's tolerance and tier
    // come from the box's width over that many pixels); the fix is inside it.
    await waitFor(() => expect(requests).toHaveLength(1));
    const url = new URL(requests[0]!, "http://localhost");
    expect(url.pathname.endsWith("/geo/coastline")).toBe(true);
    const [w, s, e, n] = url.searchParams.get("bbox")!.split(",").map(Number) as [number, number, number, number];
    expect(w).toBeLessThan(fix.longitude);
    expect(e).toBeGreaterThan(fix.longitude);
    expect(s).toBeLessThan(fix.latitude);
    expect(n).toBeGreaterThan(fix.latitude);
    expect(url.searchParams.get("width")).toBe("495");

    // The geometry lands as paths and land, and the credit comes with it.
    await waitFor(() => expect(result.baseElement.textContent).toContain("OpenStreetMap contributors"));
    // Count the geographic marks themselves; toolbar/pin icons also contain paths.
    expect(result.baseElement.querySelectorAll('svg polyline[stroke-width="1"], svg polyline[stroke-width="0.6"]')).toHaveLength(2);
    expect(result.baseElement.querySelectorAll('svg path[fill-rule="evenodd"]')).toHaveLength(1);
  });

  test("without a server the map still draws the pin, and carries no credit for geometry it has not got", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const result = render(
      <ToolCallTimeline toolCalls={[locationCall(JSON.stringify(fix))]} onApproval={() => {}} />
    );
    expandAll(result);
    await act(flushPromises);
    expect(result.baseElement.textContent).toContain("Vathy");
    expect(result.baseElement.querySelector("svg")).toBeTruthy();
    expect(result.baseElement.textContent).not.toContain("OpenStreetMap");
  });

  test("a denial keeps its message instead of blanking the row", () => {
    const result = render(
      <ToolCallTimeline
        toolCalls={[locationCall("User denied the geolocation request.", true)]}
        onApproval={() => {}}
      />
    );
    expandAll(result);
    expect(result.baseElement.textContent).toContain(
      "User denied the geolocation request."
    );
  });

  test("a payload the schema rejects falls back to the raw output", () => {
    // A server that changed the payload shape must not blank the row — the
    // call still happened, and its output is the only thing left to show.
    const result = render(
      <ToolCallTimeline
        toolCalls={[locationCall(JSON.stringify({ ...fix, latitude: "38.3653" }))]}
        onApproval={() => {}}
      />
    );
    expandAll(result);
    expect(result.baseElement.textContent).toContain('"latitude"');
  });
});

describe("AskUserCard", () => {
  const questions: AskUserQuestion[] = [
    {
      question: "Which draft should I keep?",
      header: "Draft",
      multiSelect: false,
      options: [
        { label: "Alpha", description: "the longer draft" },
        { label: "Beta", description: "the shorter draft" },
      ],
    },
  ];

  test("renders every option and submits the clicked one", () => {
    const submitted: unknown[] = [];
    const { getByText } = render(
      <AskUserCard
        requestId="req-1"
        questions={questions}
        onSubmit={(requestId, answers) => submitted.push([requestId, answers])}
        onCancel={() => {}}
      />
    );
    expect(getByText("Alpha")).toBeTruthy();
    expect(getByText("Beta")).toBeTruthy();

    fireEvent.click(getByText("Alpha"));
    fireEvent.click(getByText("Submit"));
    expect(submitted).toEqual([
      ["req-1", { "Which draft should I keep?": "Alpha" }],
    ]);
  });

  test("cancelled card collapses to a summary row without options", () => {
    const { getByText, queryByText } = render(
      <AskUserCard
        requestId="req-2"
        questions={questions}
        cancelled
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(getByText("Which draft should I keep?")).toBeTruthy();
    expect(getByText("dismissed · the agent got no answer")).toBeTruthy();
    expect(queryByText("Beta")).toBeNull();
  });
});

describe("ZoomViewer", () => {
  test("mounts its content in a portal and closes from the toolbar", () => {
    let closed = 0;
    const { container, getByText, getByRole } = render(
      <ZoomViewer onClose={() => closed++}>
        <div>zoomed content</div>
      </ZoomViewer>
    );
    expect(getByText("zoomed content")).toBeTruthy();
    expect(container.contains(getByText("zoomed content")), "zoom content is portalled outside its inline caller").toBe(false);
    fireEvent.click(getByRole("button", { name: "Close" }));
    expect(closed).toBe(1);
  });
});

test("capture recovery preserves the saved note and retries indexing without resubmitting", async () => {
  const calls: string[] = [];
  let retries = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/brain/stats")) return Response.json({ byType: {} });
    calls.push(url);
    if (url.endsWith("/brain/add")) return Response.json({ success: true, path: "notes/topic.md", indexed: false, indexError: "database is locked" });
    if (url.endsWith("/brain/index")) {
      retries++;
      return retries === 1 ? Response.json({ error: "still locked" }, { status: 500 }) : Response.json({ success: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  const view = render(<AddPanel open onClose={() => {}} />);
  changeControlledInput(view.getByPlaceholderText("What do you want to remember?") as HTMLTextAreaElement, "Topic");
  await act(async () => { fireEvent.click(view.getByRole("button", { name: /^Add$/ })); });
  expect(view.getByText(/Saved, but not indexed/)).toBeTruthy();
  expect(view.getByText("notes/topic.md")).toBeTruthy();
  // The old keyboard shortcut could submit the already-saved note again.
  await act(async () => { fireEvent.keyDown(view.getByText("Added to your brain."), { key: "Enter", ctrlKey: true }); });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Retry indexing" })); });
  expect(view.getByText("still locked")).toBeTruthy();
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Retry indexing" })); });
  expect(view.getByText(/Saved and indexed/)).toBeTruthy();
  expect(calls.filter(url => url.endsWith("/brain/add"))).toHaveLength(1);
  expect(calls.filter(url => url.endsWith("/brain/index"))).toHaveLength(2);
});

describe("SessionDrawer recovery", () => {
  test("shows partial histories with a warning and clears it after retry", async () => {
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      calls++;
      return Response.json({
        sessions: [{ id: "saved", title: "Saved conversation", createdAt: 1, lastActiveAt: 2 }],
        ...(calls === 1 ? { unavailableBackends: ["offline"] } : {}),
      });
    }) as typeof fetch;
    const view = render(<SessionDrawer open onClose={() => {}} onResume={() => {}} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(view.getByText("Saved conversation")).toBeTruthy();
    expect(view.getByRole("status").textContent).toContain("Some session histories are unavailable");
    await act(async () => { fireEvent.click(view.getByText("Retry")); });
    expect(calls).toBe(2);
    expect(view.queryByRole("status")).toBeNull();
    expect(view.getByText("Saved conversation")).toBeTruthy();
  });

  test("reports a failed refresh without hiding previously loaded sessions", async () => {
    let fail = false;
    globalThis.fetch = (async (_input: RequestInfo | URL) => {
      if (fail) throw new Error("offline");
      return Response.json({ sessions: [{ id: "saved", title: "Saved conversation", createdAt: 1, lastActiveAt: 2 }] });
    }) as typeof fetch;
    const props = { onClose: () => {}, onResume: () => {} };
    const view = render(<SessionDrawer open {...props} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    view.rerender(<SessionDrawer open={false} {...props} />);
    fail = true;
    view.rerender(<SessionDrawer open {...props} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(view.getByText("Saved conversation")).toBeTruthy();
    expect(view.getByRole("status").textContent).toContain("Could not refresh sessions");
  });

  test("staged tracks join a new chat's Draft entry or are one, failed before uploading before this tab (#1112)", async () => {
    const uploads: Array<(response: Response) => void> = [];
    const root = createBrainUiRoot({ storage: null, request: async (url) => {
      if (url.endsWith("/track-upload")) return new Promise<Response>((resolve) => uploads.push(resolve));
      return Response.json({ sessions: [] });
    } });
    const gpx = (name: string) => new File(["{}"], name, { type: "application/octet-stream" });
    const drafts = root.stores.drafts.getState();
    // A mixed draft: words, one track the host refused, one still uploading.
    const routes = drafts.fresh;
    drafts.edit(routes, null, { text: "Compare day 3 and day 4 routes" });
    tracksFor(root, trackKey(null, routes)).uploads.add([gpx("day-3.gpx"), gpx("day-4.gpx")]);
    // Later, a new chat holding only a track, still uploading: listed first.
    await Bun.sleep(5);
    drafts.newChat();
    const pylos = root.stores.drafts.getState().fresh;
    tracksFor(root, trackKey(null, pylos)).uploads.add([gpx("pylos.gpx")]);
    const view = render(<BrainUiProvider root={root}><SessionDrawer open onClose={() => {}} onResume={() => {}} /></BrainUiProvider>);
    try {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const rows = () => [...view.baseElement.querySelectorAll<HTMLElement>("[data-draft-row] [role=\"button\"]")].map((el) => el.getAttribute("aria-label"));
      expect(rows()).toEqual([
        "Draft: Draft with 1 track file, uploading 1 track. Open draft.",
        "Draft: Compare day 3 and day 4 routes, not saved yet, uploading 2 tracks. Open draft.",
      ]);
      await act(async () => { uploads[0]!(Response.json({ error: "unsupported_track" }, { status: 422 })); await new Promise((resolve) => setTimeout(resolve, 0)); });
      const row = (title: string) => rows().find((name) => name?.startsWith(`Draft: ${title},`));
      expect(rows()[0], "the newest change first").toMatch(/^Draft: Compare/);
      expect(row("Compare day 3 and day 4 routes"), "a failed upload wins").toBe("Draft: Compare day 3 and day 4 routes, not saved yet, 1 track failed. Open draft.");
      expect(view.baseElement.textContent).toContain("draft · not saved yet · 1 track failed");
      await act(async () => { uploads[2]!(Response.json({ files: [trackView().file] })); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(row("Draft with 1 track file"), "ready: where it lives").toBe("Draft: Draft with 1 track file, tracks in this tab only. Open draft.");
      expect(view.baseElement.textContent).toContain("draft · tracks in this tab only");
      expect(view.baseElement.textContent).not.toMatch(/track[^·]*saved|saved[^·]*track/);
    } finally { view.unmount(); root.dispose(); }
  });
});

test("sync busy response explains why another sync cannot start", async () => {
  globalThis.fetch = (async (_input: RequestInfo | URL) => Response.json(
    { error: "A sync is already running. Wait for it to finish before retrying." }, { status: 409 }
  )) as typeof fetch;
  const view = render(<StreamingPanel open title="Sync" endpoint="/api/brain/sync" onClose={() => {}} />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(view.getByText("A sync is already running. Wait for it to finish before retrying.")).toBeTruthy();
});
