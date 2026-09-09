// Render smoke tests: mount the highest-traffic components in happy-dom and
// assert the DOM they produce, not just their pure helpers. Fixtures are
// minimal and keyless; nothing here touches the network.
//
// The dom.js import MUST stay first — it registers the happy-dom globals
// before the component module bodies run, and its header documents why every
// render test lives in this one file and why `screen` must not be used.
import { unregisterDom } from "./dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";

import { MarkdownContent } from "../../src/components/chat/markdown-content.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { AskUserCard } from "../../src/components/chat/ask-user-card.js";
import { ZoomViewer } from "../../src/components/viewer/zoom-viewer.js";
import type { ToolCall } from "../../src/stores/chat-store.js";
import type { AskUserQuestion } from "@schlessera/brain-ui-sdk/protocol";
import { useHashRoutes } from "../../src/hooks/use-hash-routes.js";
import {
  hasUnsentText,
  useServiceWorkerUpdates,
} from "../../src/hooks/use-service-worker-updates.js";
import { useFileStore } from "../../src/stores/file-store.js";
import { useUIStore } from "../../src/stores/ui-store.js";

afterEach(cleanup);
afterAll(unregisterDom);

function setHash(hash: string): void {
  history.replaceState(null, "", hash || "/");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

describe("useHashRoutes", () => {
  const originalOpenFile = useFileStore.getState().openFile;
  const originalOpenDir = useFileStore.getState().openDir;

  afterEach(() => {
    history.replaceState(null, "", "/");
    act(() => {
      useUIStore.setState({ activeView: "chat", filePanelOpen: false });
      useFileStore.setState({
        openFile: originalOpenFile,
        openDir: originalOpenDir,
      });
    });
  });

  test("opens file and directory hash routes", async () => {
    const openedFiles: string[] = [];
    const openedDirs: string[] = [];
    useFileStore.setState({
      openFile: async (path) => {
        openedFiles.push(path);
      },
      openDir: async (path) => {
        openedDirs.push(path);
      },
    });
    history.replaceState(null, "", "#/files/notes/example.md");
    renderHook(() => useHashRoutes());

    expect(useUIStore.getState().filePanelOpen).toBe(true);
    expect(openedFiles).toEqual(["notes/example.md"]);

    act(() => setHash("#/files/projects/current/"));
    expect(openedDirs).toEqual(["projects/current"]);
  });

  test("selects graph and activity routes while preserving activity deep links", () => {
    history.replaceState(null, "", "#/graph");
    renderHook(() => useHashRoutes());
    expect(useUIStore.getState().activeView).toBe("graph");

    act(() => setHash("#/activity/run-42"));
    expect(useUIStore.getState().activeView).toBe("activity");
    expect(window.location.hash).toBe("#/activity/run-42");
  });

  test("store-driven replaceState sync is silent and does not loop", () => {
    history.replaceState(null, "", "/");
    const originalReplaceState = history.replaceState.bind(history);
    const replacements: string[] = [];
    history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
      replacements.push(String(url));
      originalReplaceState(data, unused, url);
    }) as typeof history.replaceState;

    const { rerender } = renderHook(() => useHashRoutes());
    act(() => useUIStore.getState().setActiveView("graph"));
    expect(window.location.hash).toBe("#/graph");
    expect(replacements).toEqual(["#/graph"]);

    rerender();
    expect(replacements).toEqual(["#/graph"]);

    const chatRoute = window.location.pathname;
    act(() => useUIStore.getState().setActiveView("chat"));
    expect(window.location.hash).toBe("");
    expect(replacements).toEqual(["#/graph", chatRoute]);

    history.replaceState = originalReplaceState;
  });

  test("an activity deep-link change does not swallow the next view switch", () => {
    // `#/activity/one` -> `#/activity/two` keeps the SAME active view, so
    // setActiveView is a no-op and the store-sync effect never runs. If the
    // hash effect armed its suppression flag anyway, the flag would still be
    // set when the user later switches to Chat, and the URL would be left
    // pointing at Activity while the app shows Chat — a refresh would jump
    // back to Activity.
    history.replaceState(null, "", "#/activity/one");
    renderHook(() => useHashRoutes());
    expect(useUIStore.getState().activeView).toBe("activity");

    act(() => {
      history.replaceState(null, "", "#/activity/two");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(useUIStore.getState().activeView).toBe("activity");
    expect(window.location.hash).toBe("#/activity/two");

    act(() => useUIStore.getState().setActiveView("chat"));
    expect(useUIStore.getState().activeView).toBe("chat");
    expect(window.location.hash).toBe("");
  });
});

class FakeServiceWorker extends EventTarget {
  state: ServiceWorkerState = "installing";

  install(): void {
    this.state = "installed";
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeServiceWorkerRegistration extends EventTarget {
  constructor(readonly installing: ServiceWorker) {
    super();
  }
}

class FakeServiceWorkerContainer extends EventTarget {
  controller: ServiceWorker | null = null;
  readonly worker = new FakeServiceWorker();
  readonly registration = new FakeServiceWorkerRegistration(
    this.worker as unknown as ServiceWorker
  );
  registerCalls: string[] = [];

  async register(path: string): Promise<ServiceWorkerRegistration> {
    this.registerCalls.push(path);
    return this.registration as unknown as ServiceWorkerRegistration;
  }

  takeControl(): void {
    this.controller = this.worker as unknown as ServiceWorker;
    this.dispatchEvent(new Event("controllerchange"));
  }
}

describe("useServiceWorkerUpdates", () => {
  test("the default DOM probe finds non-empty text fields", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    expect(hasUnsentText()).toBe(false);
    textarea.value = "draft";
    expect(hasUnsentText()).toBe(true);
    textarea.remove();
  });

  test("does not reload on first install", async () => {
    const serviceWorker = new FakeServiceWorkerContainer();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorker,
    });
    let reloads = 0;
    renderHook(() =>
      useServiceWorkerUpdates({
        isBusy: false,
        hasUnsentText: () => false,
        reload: () => reloads++,
      })
    );
    await act(async () => Promise.resolve());

    act(() => {
      serviceWorker.worker.install();
      serviceWorker.takeControl();
    });

    expect(serviceWorker.registerCalls).toEqual(["/service-worker.js"]);
    expect(reloads).toBe(0);
  });

  test("defers an update takeover until idle and reloads at most once", async () => {
    const serviceWorker = new FakeServiceWorkerContainer();
    serviceWorker.controller = {} as ServiceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: serviceWorker,
    });
    let reloads = 0;
    const { rerender } = renderHook(
      ({ isBusy }) =>
        useServiceWorkerUpdates({
          isBusy,
          hasUnsentText: () => false,
          reload: () => reloads++,
        }),
      { initialProps: { isBusy: true } }
    );
    await act(async () => Promise.resolve());

    act(() => {
      serviceWorker.worker.install();
      serviceWorker.takeControl();
    });
    expect(reloads).toBe(0);

    rerender({ isBusy: false });
    expect(reloads).toBe(1);

    act(() => serviceWorker.takeControl());
    rerender({ isBusy: false });
    expect(reloads).toBe(1);
  });
});

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
    const { queryByText } = render(
      <AskUserCard
        requestId="req-2"
        questions={questions}
        cancelled
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(queryByText("Beta")).toBeNull();
  });
});

describe("ZoomViewer", () => {
  test("mounts its content in a portal and closes from the toolbar", () => {
    let closed = 0;
    const { getByText, getByTitle } = render(
      <ZoomViewer onClose={() => closed++}>
        <div>zoomed content</div>
      </ZoomViewer>
    );
    expect(getByText("zoomed content")).toBeTruthy();
    fireEvent.click(getByTitle("Close"));
    expect(closed).toBe(1);
  });
});
