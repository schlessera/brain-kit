// What dismisses a SlidePanel drawer (#90). A backdrop click used to close
// every drawer, and closing the sync panel unmounts the stream it is reading,
// so a stray click cancelled the run. Same containment contract as
// render-smoke.test.tsx: the DOM module first, `afterAll(unregisterDom)`,
// queries off `render()` and never `screen`.
import { unregisterSlidePanelDom as unregisterDom } from "./slide-panel-dom.js";

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { SlidePanel } from "../../src/components/layout/slide-panel.js";
import { StreamingPanel } from "../../src/components/quick-actions/streaming-modal.js";
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
  const backdrop = view.baseElement.querySelector(".fixed.inset-0.z-40");
  if (!backdrop) throw new Error("no backdrop rendered");
  return backdrop;
}

const escape = () => fireEvent.keyDown(document, { key: "Escape" });

describe("SlidePanel dismissal (closedBy)", () => {
  test("a drawer light-dismisses by default: the backdrop, Escape and the X all close it", () => {
    const onClose = mock(() => {});
    const view = render(<SlidePanel open onClose={onClose} title="Sessions"><p>list</p></SlidePanel>);
    fireEvent.click(backdropOf(view));
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
    fireEvent.click(backdropOf(view));
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
    fireEvent.click(backdropOf(view));
    escape();
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(view.getByText("log")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Close Sync" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

describe("StreamingPanel dismissal", () => {
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
  const stream = (text: string) => new Response(`data: ${JSON.stringify({ type: "progress", text })}\n\ndata: {"type":"done","success":true}\n\n`);

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
      fireEvent.click(backdropOf(view));
      escape();
      expect(onClose).toHaveBeenCalledTimes(0);
      expect(signal?.aborted).toBe(false);
      expect(view.getByText("Running...")).toBeTruthy();

      await act(async () => { requests[0]!.response.resolve(stream("indexed 3 files")); await flushPromises(); });
      expect(view.getByText("Complete")).toBeTruthy();
      expect(view.getByText("indexed 3 files")).toBeTruthy();

      // Finished: the log stays until it is dismissed deliberately.
      fireEvent.click(backdropOf(view));
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
    fireEvent.click(backdropOf(view));
    escape();
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(view.getByRole("tab", { name: "Security" }).hasAttribute("disabled")).toBe(true);
    expect(view.getByRole("tab", { name: "Devices & agents" }).hasAttribute("disabled")).toBe(false);

    fireEvent.click(view.getByRole("button", { name: "Close Settings" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Acknowledged: the drawer light-dismisses again.
    act(() => usePrincipalStore.setState({ mintPending: false }));
    fireEvent.click(backdropOf(view));
    expect(onClose).toHaveBeenCalledTimes(2);
    view.unmount();
  });
});
