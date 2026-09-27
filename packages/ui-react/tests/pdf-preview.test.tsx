// The PDF previewer's own behaviour (#529): which pages it draws, at what
// scale, what it gives back, and when it gives up. pdf.js is stood in for, so
// every draw is recorded; the real library is exercised by
// pdf-real-library.test.ts, and real browsers by the PR's manual check.
// Runs in a child process with happy-dom registered.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const CHILD_MARKER = "BRAIN_UI_REACT_PDF_PREVIEW_CHILD";

if (!process.env[CHILD_MARKER]) {
  test("the PDF previewer tests pass in an isolated process", async () => {
    const proc = Bun.spawn(["bun", "test", import.meta.path, "--timeout", "30000"], {
      cwd: import.meta.dir,
      env: { ...process.env, [CHILD_MARKER]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const output = `${stdout}${stderr}`;
    if (exitCode !== 0) throw new Error(`Isolated PDF previewer tests failed (${exitCode})\n${output}`);
    // A child that registered no tests also exits 0.
    expect(output).toMatch(/\b12 pass\b/);
  });
} else {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const PANEL_WIDTH = 390;
  const DPR = 3;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => PANEL_WIDTH });
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: DPR });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;

  /** IntersectionObserver whose entries the test decides. */
  const observed = new Map<Element, (near: boolean) => void>();
  globalThis.IntersectionObserver = class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(el: Element) {
      observed.set(el, (near) => this.callback([{ isIntersecting: near, target: el } as IntersectionObserverEntry], this as never));
    }
    disconnect() {}
    unobserve() {}
  } as unknown as typeof IntersectionObserver;

  interface Draw {
    page: number;
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
    cancelled: boolean;
  }
  let draws: Draw[] = [];
  let closed: unknown[] = [];
  let opening: () => Promise<unknown> = async () => null;
  /** When set, draws stay in flight until the document is closed. */
  let holdDraws = false;

  /** A pdf.js document: pages of the given sizes, in points. */
  function fakeDoc(pages: { width: number; height: number }[], fail: { getPage?: number; render?: number } = {}) {
    const inFlight = new Set<() => void>();
    const doc = {
      numPages: pages.length,
      loadingTask: { destroy: async () => {} },
      /** What pdf.js does to a document's draws when it is destroyed. */
      cancelDraws: () => inFlight.forEach((cancel) => cancel()),
      async getPage(n: number) {
        if (fail.getPage === n) throw new Error("Bad XRef entry");
        const size = pages[n - 1]!;
        return {
          getViewport: ({ scale }: { scale: number }) => ({ width: size.width * scale, height: size.height * scale }),
          render({ canvas }: { canvas: HTMLCanvasElement }) {
            const draw: Draw = { page: n, canvas, width: canvas.width, height: canvas.height, cancelled: false };
            draws.push(draw);
            let reject!: (error: unknown) => void;
            const promise = new Promise<void>((resolve, rej) => {
              reject = rej;
              if (fail.render === n) queueMicrotask(() => rej(new Error("Invalid color space")));
              else if (!holdDraws) queueMicrotask(resolve);
            });
            const cancel = () => {
              inFlight.delete(cancel);
              draw.cancelled = true;
              reject(Object.assign(new Error("Rendering cancelled, page " + n), { name: "RenderingCancelledException" }));
            };
            inFlight.add(cancel);
            return { promise, cancel };
          },
        };
      },
    };
    return doc;
  }

  mock.module("../src/lib/pdf.js", () => ({
    openPdf: () => opening(),
    closePdf: (doc: { cancelDraws?: () => void }) => {
      closed.push(doc);
      doc.cancelDraws?.();
    },
  }));

  const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
  const { BrainUiProvider } = await import("../src/root-context.js");
  const { createBrainUiRoot } = await import("../src/root.js");
  const { FileViewerBinary } = await import("../src/components/files/file-viewer-binary.js");

  const root = createBrainUiRoot({ storage: null });
  const LETTER = { width: 612, height: 792 };
  const view = (mtime = 0, path = "out/report.pdf") => (
    <BrainUiProvider root={root}>
      <FileViewerBinary content={{ path, kind: "binary", size: 4096, mtime, mime: "application/pdf" }} />
    </BrainUiProvider>
  );
  const pageButton = (container: HTMLElement, n: number, total: number) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="Page ${n} of ${total}, open zoomed"]`)!;
  async function setNear(el: Element, near: boolean) {
    await act(async () => {
      observed.get(el)!(near);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  async function opened(doc: unknown, pages: number) {
    opening = async () => doc;
    const utils = render(view());
    await waitFor(() => expect(utils.container.querySelectorAll('button[aria-label$="open zoomed"]').length).toBe(pages));
    return utils;
  }

  beforeEach(() => {
    cleanup();
    draws = [];
    closed = [];
    observed.clear();
    holdDraws = false;
  });

  describe("drawing", () => {
    test("a page near the viewport is drawn at device pixels, and a far one is not drawn at all", async () => {
      const { container } = await opened(fakeDoc([LETTER, LETTER, LETTER]), 3);

      await setNear(pageButton(container, 1, 3), true);

      expect(draws.map((d) => d.page)).toEqual([1]);
      expect(draws[0]!.width).toBe(Math.floor(LETTER.width * (PANEL_WIDTH / LETTER.width) * DPR));
      expect(pageButton(container, 3, 3).querySelector("canvas")).toBeNull();
    });

    test("a page too tall for the canvas budget is drawn smaller, inside it", async () => {
      const receipt = { width: 612, height: 9000 };
      const { container } = await opened(fakeDoc([receipt]), 1);

      await setNear(pageButton(container, 1, 1), true);

      const { width, height } = draws[0]!;
      // At full device pixels this page would be 1170 x 17205 = 20,129,850 pixels.
      expect(width * height).toBeGreaterThan(0);
      expect(width * height).toBeLessThanOrEqual(16_777_216);
    });

    test("leaving the viewport cancels the draw and gives the canvas's pixels back", async () => {
      const { container } = await opened(fakeDoc([LETTER]), 1);
      const page = pageButton(container, 1, 1);

      await setNear(page, true);
      const canvas = draws[0]!.canvas;
      expect(canvas.width).toBeGreaterThan(0);
      await setNear(page, false);

      expect(draws[0]!.cancelled).toBe(true);
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
      expect(page.querySelector("canvas")).toBeNull();
      // A cancelled draw is the cleanup working, not a failure.
      expect(container.textContent).not.toContain("Preview not available");
    });

    test("tapping a page opens it in the zoom viewer, drawn sharper and inside the budget", async () => {
      const { container } = await opened(fakeDoc([LETTER, LETTER]), 2);

      await act(async () => {
        fireEvent.click(pageButton(container, 2, 2));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const dialog = document.querySelector('[role="dialog"][aria-label="report.pdf, page 2 of 2"]');
      expect(dialog).not.toBeNull();
      const zoomed = draws.find((d) => dialog!.contains(d.canvas))!;
      expect(zoomed.page).toBe(2);
      expect(zoomed.width).toBe(Math.floor(LETTER.width * (96 / 72) * 3));
      expect(zoomed.width * zoomed.height).toBeLessThanOrEqual(16_777_216);
    });
  });

  describe("failure", () => {
    test("a document that does not open gets the download card", async () => {
      opening = async () => {
        throw new Error("Invalid PDF structure.");
      };
      const { container } = render(view());

      await waitFor(() => expect(container.textContent).toContain("Preview not available"));
    });

    test("a page that fails to draw gets the download card, not a blank page", async () => {
      const { container } = await opened(fakeDoc([LETTER, LETTER], { render: 2 }), 2);

      await setNear(pageButton(container, 2, 2), true);

      await waitFor(() => expect(container.textContent).toContain("Preview not available"));
    });

    test("a page pdf.js cannot fetch gets the download card", async () => {
      const { container } = await opened(fakeDoc([LETTER, LETTER], { getPage: 2 }), 2);

      await setNear(pageButton(container, 2, 2), true);

      await waitFor(() => expect(container.textContent).toContain("Preview not available"));
    });

    test("the same file regenerated after a failure gets a fresh attempt", async () => {
      opening = async () => {
        throw new Error("Unexpected end of file");
      };
      const { container, rerender } = render(view(1));
      await waitFor(() => expect(container.textContent).toContain("Preview not available"));

      opening = async () => fakeDoc([LETTER]);
      rerender(view(2));

      await waitFor(() => expect(pageButton(container, 1, 1)).not.toBeNull());
      expect(container.textContent).not.toContain("Preview not available");
    });
  });

  describe("cancellation", () => {
    test("a draw pdf.js cancels by itself is not a failure", async () => {
      // pdf.js cancels every draw of a document it destroys. In a browser,
      // closing the old document when another file opens does that before
      // React has unmounted the old pages, so the cancellation reaches a page
      // that has not cleaned up yet. Counting it as a failure would mark the
      // newly opened file as unpreviewable.
      holdDraws = true;
      const doc = fakeDoc([LETTER]);
      const { container } = await opened(doc, 1);
      await setNear(pageButton(container, 1, 1), true);

      await act(async () => {
        doc.cancelDraws();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(draws[0]!.cancelled).toBe(true);
      expect(container.textContent).not.toContain("Preview not available");
      expect(pageButton(container, 1, 1)).not.toBeNull();
    });
  });

  describe("lifetime", () => {
    test("opening another PDF while a page is still drawing shows the new one, not the card", async () => {
      holdDraws = true;
      const first = fakeDoc([LETTER]);
      const { container, rerender } = await opened(first, 1);
      await setNear(pageButton(container, 1, 1), true);
      expect(draws).toHaveLength(1);

      // Closing the first document cancels its draw before the page's own
      // cleanup has run. That cancellation is not the new file failing.
      opening = async () => fakeDoc([LETTER, LETTER]);
      await act(async () => {
        rerender(view(0, "out/notes.pdf"));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(closed).toEqual([first]);
      expect(draws[0]!.cancelled).toBe(true);
      await waitFor(() => expect(pageButton(container, 1, 2)).not.toBeNull());
      expect(container.textContent).not.toContain("Preview not available");
    });

    test("closing the viewer closes the document", async () => {
      const doc = fakeDoc([LETTER]);
      const { unmount } = await opened(doc, 1);

      unmount();

      expect(closed).toEqual([doc]);
    });

    test("a document that finishes opening after the viewer closed is closed at once", async () => {
      const doc = fakeDoc([LETTER]);
      let finish!: (value: unknown) => void;
      opening = () => new Promise((resolve) => (finish = resolve));
      const { unmount } = render(view());

      unmount();
      await act(async () => {
        finish(doc);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(closed).toEqual([doc]);
    });
  });

  afterAll(async () => {
    cleanup();
    root.dispose();
    await GlobalRegistrator.unregister();
  });
}
