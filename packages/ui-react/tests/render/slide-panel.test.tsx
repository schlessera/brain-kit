// What dismisses a SlidePanel drawer (#90). A backdrop click used to close
// every drawer, and closing the sync panel unmounts the stream it is reading,
// so a stray click cancelled the run. Same containment contract as
// render-smoke.test.tsx: the DOM module first, `afterAll(unregisterDom)`,
// queries off `render()` and never `screen`.
import { unregisterSlidePanelDom as unregisterDom } from "./slide-panel-dom.js";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { overlayGeometry } from "./overlay-geometry.js";

let restoreGeometry: () => void;
beforeEach(() => { restoreGeometry = overlayGeometry(); });
afterEach(() => restoreGeometry());

import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { SlidePanel } from "../../src/components/layout/slide-panel.js";
import { StreamingPanel } from "../../src/components/quick-actions/streaming-modal.js";
import { WhatsupPanel } from "../../src/components/quick-actions/whatsup-modal.js";
import { SettingsPanel } from "../../src/components/settings/settings-panel.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { usePrincipalStore } from "../../src/stores/principal-store.js";
import { useUIStore } from "../../src/stores/ui-store.js";

afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  unregisterDom();
});

const realFetch = globalThis.fetch;
const realMatchMedia = window.matchMedia;
afterEach(() => {
  globalThis.fetch = realFetch;
  window.matchMedia = realMatchMedia;
  usePrincipalStore.setState({ mintPending: false, mintError: null, oneTimeCredential: null });
  useUIStore.setState({ settingsPanelOpen: false, settingsTab: "models" });
});

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The drawer's backdrop: the only fixed full-viewport layer a SlidePanel draws. */
function backdropOf(view: ReturnType<typeof render>): Element {
  const backdrop = view.baseElement.querySelector(".bk-overlay-scrim");
  if (!backdrop) throw new Error("no backdrop rendered");
  return backdrop;
}

const escape = () => fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });

describe("SlidePanel dismissal (closedBy)", () => {
  test("a drawer light-dismisses by default: the backdrop, Escape and the X all close it", () => {
    const onClose = mock(() => {});
    const view = render(<SlidePanel open onClose={onClose} title="Sessions"><p>list</p></SlidePanel>);
    fireEvent.pointerDown(backdropOf(view));
    expect(onClose).toHaveBeenCalledTimes(1);
    escape();
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(view.getByRole("button", { name: "Close Sessions" }));
    expect(onClose).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  test("closerequest: the backdrop is inert, Escape and the X still close it", () => {
    const onClose = mock(() => {});
    const view = render(<SlidePanel open onClose={onClose} title="Sync" closedBy="closerequest"><p>log</p></SlidePanel>);
    fireEvent.pointerDown(backdropOf(view));
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(view.getByText("log")).toBeTruthy();
    escape();
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: "Close Sync" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  test("none: only the X closes it, and the X is never inert", () => {
    const onClose = mock(() => {});
    const view = render(<SlidePanel open onClose={onClose} title="Sync" closedBy="none"><p>log</p></SlidePanel>);
    fireEvent.pointerDown(backdropOf(view));
    escape();
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(view.getByText("log")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Close Sync" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

/** A root whose every request is held open until the test resolves it. */
function transport() {
  const requests: Array<{ url: string; init?: RequestInit; response: ReturnType<typeof deferred<Response>> }> = [];
  const root = createBrainUiRoot({ storage: null, config: { backendUrl: "https://sync.example" },
    request: (url, init) => {
      const response = deferred<Response>();
      requests.push({ url, init, response });
      return response.promise;
    },
  });
  return { root, requests };
}

/** One progress event and a successful done, the shape both streamed panels read. */
const stream = (text: string) => new Response(`data: ${JSON.stringify({ type: "progress", text })}\n\ndata: {"type":"done","success":true}\n\n`);

describe("StreamingPanel dismissal", () => {
  test("a backdrop click during and after a sync leaves the panel open and the stream untouched", async () => {
    const { root, requests } = transport();
    const onClose = mock(() => {});
    const view = render(
      <BrainUiProvider root={root}>
        <StreamingPanel open title="Brain Sync" endpoint="/api/brain/sync" onClose={onClose} />
      </BrainUiProvider>
    );
    try {
      expect(view.getByText("Running...")).toBeTruthy();
      const signal = requests[0]!.init?.signal;
      expect(signal?.aborted).toBe(false);

      // Mid-run: neither a stray click nor a reflexive Escape may cancel the job.
      fireEvent.pointerDown(backdropOf(view));
      escape();
      expect(onClose).toHaveBeenCalledTimes(0);
      expect(signal?.aborted).toBe(false);
      expect(view.getByText("Running...")).toBeTruthy();

      await act(async () => { requests[0]!.response.resolve(stream("indexed 3 files")); await flushPromises(); });
      expect(view.getByText("Complete")).toBeTruthy();
      expect(view.getByText("indexed 3 files")).toBeTruthy();

      // Finished: the log stays until it is dismissed deliberately.
      fireEvent.pointerDown(backdropOf(view));
      expect(onClose).toHaveBeenCalledTimes(0);
      expect(view.getByText("indexed 3 files")).toBeTruthy();
      escape();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); root.dispose(); }
  });

  test("the header's X closes the panel while the job is still running", () => {
    const { root, requests } = transport();
    const onClose = mock(() => {});
    const view = render(
      <BrainUiProvider root={root}>
        <StreamingPanel open title="Brain Sync" endpoint="/api/brain/sync" onClose={onClose} />
      </BrainUiProvider>
    );
    try {
      expect(view.getByText("Running...")).toBeTruthy();
      fireEvent.click(view.getByRole("button", { name: "Close Brain Sync" }));
      expect(onClose).toHaveBeenCalledTimes(1);
      // Closing is the caller's; the X itself does not abort the request.
      expect(requests[0]!.init?.signal?.aborted).toBe(false);
    } finally { view.unmount(); root.dispose(); }
  });
});

// What dismisses the briefing drawer (#105). Closing `WhatsupPanel` unmounts
// it, and the unmount aborts the briefing request, so a stray backdrop click
// would cancel the read mid-flight or throw away the briefing it fetched.
describe("WhatsupPanel dismissal", () => {
  const briefing = "Three things need you today.";

  const mount = (onClose: () => void, root: ReturnType<typeof transport>["root"]) =>
    render(
      <BrainUiProvider root={root}>
        <WhatsupPanel open onClose={onClose} />
      </BrainUiProvider>
    );

  test("the backdrop and Escape are inert while the briefing loads, and the request survives both", async () => {
    const { root, requests } = transport();
    const onClose = mock(() => {});
    const view = mount(onClose, root);
    try {
      expect(requests[0]!.url).toBe("https://sync.example/api/brain/briefing");
      expect(view.getByText("Reading the briefing...")).toBeTruthy();
      const signal = requests[0]!.init?.signal;
      expect(signal?.aborted).toBe(false);

      fireEvent.pointerDown(backdropOf(view));
      expect(onClose).toHaveBeenCalledTimes(0);
      escape();
      expect(onClose).toHaveBeenCalledTimes(0);

      // Closing unmounts the panel and the unmount aborts the briefing, so the
      // proof is the request, not just the callback.
      expect(signal?.aborted).toBe(false);
      expect(view.getByText("Reading the briefing...")).toBeTruthy();
    } finally { view.unmount(); root.dispose(); }
  });

  test("the backdrop is inert once the briefing has arrived, and Escape dismisses it", async () => {
    const { root, requests } = transport();
    const onClose = mock(() => {});
    const view = mount(onClose, root);
    try {
      await act(async () => { requests[0]!.response.resolve(Response.json({ content: briefing })); await flushPromises(); });
      expect(view.queryByText("Reading the briefing...")).toBeNull();
      expect(view.getByText(briefing)).toBeTruthy();

      // The briefing goes only when it is dismissed deliberately — Escape is
      // deliberate, a click beside the drawer is not.
      fireEvent.pointerDown(backdropOf(view));
      expect(onClose).toHaveBeenCalledTimes(0);
      expect(view.getByText(briefing)).toBeTruthy();

      escape();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); root.dispose(); }
  });

  // The X is never inert: `closedBy` governs the backdrop and Escape, and the
  // header's control stays the way out of every state the briefing reaches.
  const arrivals = {
    loading: null,
    done: () => Response.json({ content: briefing }),
    error: () => Response.json({ error: "brain briefing failed" }, { status: 500 }),
  } as const;

  for (const state of ["loading", "done", "error"] as const) {
    test(`the header's X closes the panel in the ${state} state`, async () => {
      const { root, requests } = transport();
      const onClose = mock(() => {});
      const view = mount(onClose, root);
      try {
        const arrive = arrivals[state];
        if (arrive) await act(async () => { requests[0]!.response.resolve(arrive()); await flushPromises(); });
        expect(view.queryByText("Reading the briefing...") !== null).toBe(state === "loading");

        fireEvent.click(view.getByRole("button", { name: "Close Whatsup" }));
        expect(onClose).toHaveBeenCalledTimes(1);
        // Closing is the caller's; the X itself does not abort the request.
        expect(requests[0]!.init?.signal?.aborted).toBe(false);
      } finally { view.unmount(); root.dispose(); }
    });
  }

  test("the footer's Cancel still aborts the briefing, and the X closes the cancelled panel", () => {
    const { root, requests } = transport();
    const onClose = mock(() => {});
    const view = mount(onClose, root);
    try {
      expect(view.getByText("Reading the briefing...")).toBeTruthy();
      fireEvent.click(view.getByRole("button", { name: "Cancel" }));
      expect(requests[0]!.init?.signal?.aborted).toBe(true);
      expect(view.getAllByText("Cancelled.").length).toBe(1);
      expect(onClose).toHaveBeenCalledTimes(0);

      fireEvent.click(view.getByRole("button", { name: "Close Whatsup" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); root.dispose(); }
  });
});

describe("Settings drawer while a credential is protected", () => {
  test("refuses the backdrop and Escape, keeps the other tabs disabled, and still closes on the X", async () => {
    // Below `laptop:` the panel is the drawer with its backdrop and tab strip.
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
    globalThis.fetch = (async () => Response.json({ principals: [] })) as unknown as typeof fetch;
    useUIStore.setState({ settingsTab: "devices" });
    usePrincipalStore.setState({ mintPending: true });

    const onClose = mock(() => {});
    const view = render(<SettingsPanel open onClose={onClose} />);
    await act(flushPromises);
    fireEvent.pointerDown(backdropOf(view));
    escape();
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(view.getByRole("tab", { name: "Security" }).hasAttribute("disabled")).toBe(true);
    expect(view.getByRole("tab", { name: "Devices & agents" }).hasAttribute("disabled")).toBe(false);

    fireEvent.click(view.getByRole("button", { name: "Close Settings" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Acknowledged: the drawer light-dismisses again.
    act(() => usePrincipalStore.setState({ mintPending: false }));
    fireEvent.pointerDown(backdropOf(view));
    expect(onClose).toHaveBeenCalledTimes(2);
    view.unmount();
  });
});

// A stream that closes without a `done` frame (#131): a dropped connection, or a
// route that unwound past its last send. The panel must still reach a terminal
// state, keep what arrived, and swap Cancel for Close.
describe("a stream that ends without a done frame", () => {
  const cut = (text: string) => new Response(`data: ${JSON.stringify({ type: "progress", text })}\n\n`);

  test("StreamingPanel renders what arrived and offers Close", async () => {
    const { root, requests } = transport();
    const view = render(
      <BrainUiProvider root={root}>
        <StreamingPanel open title="Brain Sync" endpoint="/api/brain/sync" onClose={() => {}} />
      </BrainUiProvider>
    );
    try {
      await act(async () => { requests[0]!.response.resolve(cut("Pulled 3 files")); await flushPromises(); });
      expect(view.getByText("Pulled 3 files")).toBeTruthy();
      expect(view.queryByText("Running...")).toBeNull();
      expect(view.getByText("Failed")).toBeTruthy();
      expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();
      expect(view.getByRole("button", { name: "Close" })).toBeTruthy();
    } finally { view.unmount(); root.dispose(); }
  });
});

// The daily briefing reads the selected root's `GET /api/brain/briefing`, the
// keyless `brain briefing` output (#1391). Each state is driven through the
// panel's own request, not through the view's props.
describe("WhatsupPanel reads the briefing endpoint", () => {
  const mount = (root: ReturnType<typeof transport>["root"]) =>
    render(
      <BrainUiProvider root={root}>
        <WhatsupPanel open onClose={() => {}} />
      </BrainUiProvider>
    );

  test("a GET to the briefing route, rendered as markdown once it arrives", async () => {
    const { root, requests } = transport();
    const view = mount(root);
    try {
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe("https://sync.example/api/brain/briefing");
      expect(requests[0]!.init?.method ?? "GET").toBe("GET");
      expect(view.getByText("Reading the briefing...")).toBeTruthy();
      await act(async () => {
        requests[0]!.response.resolve(Response.json({ content: "## Deadlines\n\nIthaca by Thursday." }));
        await flushPromises();
      });
      expect(view.queryByText("Reading the briefing...")).toBeNull();
      expect(view.getByRole("heading", { name: "Deadlines" })).toBeTruthy();
      expect(view.getByText("Ithaca by Thursday.")).toBeTruthy();
      expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    } finally { view.unmount(); root.dispose(); }
  });

  test("an empty briefing says so instead of drawing a blank", async () => {
    const { root, requests } = transport();
    const view = mount(root);
    try {
      await act(async () => { requests[0]!.response.resolve(Response.json({ content: "  \n" })); await flushPromises(); });
      expect(view.getByText("Nothing in today's briefing.")).toBeTruthy();
      expect(view.getByRole("button", { name: "Close" })).toBeTruthy();
    } finally { view.unmount(); root.dispose(); }
  });

  test("a failed read names the server's reason, and Retry reads the briefing again", async () => {
    const { root, requests } = transport();
    const view = mount(root);
    try {
      await act(async () => {
        requests[0]!.response.resolve(Response.json({ error: "brain briefing failed: index missing" }, { status: 500 }));
        await flushPromises();
      });
      expect(view.getByText("Briefing unavailable")).toBeTruthy();
      expect(view.getByText("brain briefing failed: index missing")).toBeTruthy();

      fireEvent.click(view.getByRole("button", { name: "Retry" }));
      expect(requests).toHaveLength(2);
      expect(requests[1]!.url).toBe("https://sync.example/api/brain/briefing");
      expect(view.getByText("Reading the briefing...")).toBeTruthy();
      await act(async () => { requests[1]!.response.resolve(Response.json({ content: "All clear." })); await flushPromises(); });
      expect(view.getByText("All clear.")).toBeTruthy();
      expect(view.queryByText("Briefing unavailable")).toBeNull();
    } finally { view.unmount(); root.dispose(); }
  });

  test("a transport failure is an error with Retry, and Cancel offers Retry too", async () => {
    const { root, requests } = transport();
    const view = mount(root);
    try {
      await act(async () => { requests[0]!.response.resolve(Promise.reject(new TypeError("Failed to fetch")) as never); await flushPromises(); });
      expect(view.getByText("Failed to fetch")).toBeTruthy();
      fireEvent.click(view.getByRole("button", { name: "Retry" }));
      fireEvent.click(view.getByRole("button", { name: "Cancel" }));
      expect(requests[1]!.init?.signal?.aborted).toBe(true);
      expect(view.getByText("Cancelled.")).toBeTruthy();
      fireEvent.click(view.getByRole("button", { name: "Retry" }));
      expect(requests).toHaveLength(3);
    } finally { view.unmount(); root.dispose(); }
  });
});
