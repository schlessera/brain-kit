// Where pdf.js parses (#529): in the shell's worker when `pdfWorkerUrl` starts
// one, on the main thread in every other case. pdf.js and the Worker are
// stood in for here; pdf-main-thread.test.ts opens a real document through
// the real library.
import { describe, expect, test } from "bun:test";

import { createPdfLoader, type PdfDocument, type PdfjsModule } from "../src/lib/pdf.js";

type Behaviour = "ready" | "error" | "silent" | "other-message";

/** A Worker that reports ready, fails to load, or says nothing, the way a browser dispatches it. */
class FakeWorker extends EventTarget {
  terminated = false;
  constructor(readonly url: string, behaviour: Behaviour) {
    super();
    queueMicrotask(() => {
      if (behaviour === "ready") {
        this.dispatchEvent(new MessageEvent("message", { data: { sourceName: "worker", targetName: "main", action: "ready", data: null } }));
      } else if (behaviour === "error") {
        this.dispatchEvent(new Event("error"));
      } else if (behaviour === "other-message") {
        this.dispatchEvent(new MessageEvent("message", { data: { action: "progress" } }));
      }
    });
  }
  terminate() {
    this.terminated = true;
  }
}

interface Harness {
  loader: ReturnType<typeof createPdfLoader>;
  pdfjs: PdfjsModule & { opened: string[]; portAtOpen: (Worker | null)[] };
  workers: FakeWorker[];
  mainThreadLoads: () => number;
}

function harness(opts: {
  behaviour?: Behaviour;
  createThrows?: boolean;
  /** Called per getDocument; return an Error to reject that open. */
  fail?: (port: Worker | null, call: number) => Error | null;
  readyTimeoutMs?: number;
} = {}): Harness {
  const workers: FakeWorker[] = [];
  let loads = 0;
  const opened: string[] = [];
  const portAtOpen: (Worker | null)[] = [];
  const pdfjs = {
    GlobalWorkerOptions: { workerPort: null as Worker | null },
    opened,
    portAtOpen,
    getDocument({ url }: { url: string }) {
      const port = pdfjs.GlobalWorkerOptions.workerPort;
      opened.push(url);
      portAtOpen.push(port);
      const error = opts.fail?.(port, opened.length) ?? null;
      const doc = { numPages: 1, loadingTask: { destroy: async () => {} } } as unknown as PdfDocument;
      return { promise: error ? Promise.reject(error) : Promise.resolve(doc) };
    },
  };
  const loader = createPdfLoader({
    importPdfjs: async () => pdfjs,
    loadMainThreadWorker: async () => {
      loads++;
    },
    createWorker: (url) => {
      if (opts.createThrows) throw new SyntaxError("invalid worker URL");
      const worker = new FakeWorker(url, opts.behaviour ?? "ready");
      workers.push(worker);
      return worker as unknown as Worker;
    },
    readyTimeoutMs: opts.readyTimeoutMs ?? 20,
  });
  return { loader, pdfjs, workers, mainThreadLoads: () => loads };
}

describe("with no pdfWorkerUrl", () => {
  test("parses on the main thread and never starts a worker", async () => {
    const h = harness();
    await h.loader.open("/a.pdf", "");

    expect(h.workers).toHaveLength(0);
    expect(h.mainThreadLoads()).toBe(1);
    expect(h.pdfjs.portAtOpen).toEqual([null]);
  });
});

describe("with a pdfWorkerUrl", () => {
  test("a worker that reports ready is the one pdf.js uses", async () => {
    const h = harness({ behaviour: "ready" });
    await h.loader.open("/a.pdf", "/pdf.worker.js");

    expect(h.workers).toHaveLength(1);
    expect(h.workers[0]!.url).toBe("/pdf.worker.js");
    expect(h.pdfjs.portAtOpen).toEqual([h.workers[0] as unknown as Worker]);
    expect(h.workers[0]!.terminated).toBe(false);
    expect(h.mainThreadLoads()).toBe(0);
  });

  test("the choice is made once: a second document reuses the worker", async () => {
    const h = harness({ behaviour: "ready" });
    await h.loader.open("/a.pdf", "/pdf.worker.js");
    await h.loader.open("/b.pdf", "/pdf.worker.js");

    expect(h.workers).toHaveLength(1);
    expect(h.pdfjs.opened).toEqual(["/a.pdf", "/b.pdf"]);
  });

  test("a worker that fails to load is terminated and the main thread takes over at once", async () => {
    // The timeout is out of reach, so only the error event can end the wait.
    const h = harness({ behaviour: "error", readyTimeoutMs: 60_000 });
    await h.loader.open("/a.pdf", "/missing.js");

    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.mainThreadLoads()).toBe(1);
    expect(h.pdfjs.portAtOpen).toEqual([null]);
  });

  test("a worker that never reports ready is given up on", async () => {
    const h = harness({ behaviour: "silent" });
    await h.loader.open("/a.pdf", "/hangs.js");

    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.mainThreadLoads()).toBe(1);
    expect(h.pdfjs.portAtOpen).toEqual([null]);
  });

  test("a message other than ready does not count as ready", async () => {
    const h = harness({ behaviour: "other-message" });
    await h.loader.open("/a.pdf", "/some-other-worker.js");

    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.pdfjs.portAtOpen).toEqual([null]);
  });

  test("a URL the Worker constructor rejects falls back too", async () => {
    const h = harness({ createThrows: true });
    await h.loader.open("/a.pdf", "not a url");

    expect(h.mainThreadLoads()).toBe(1);
    expect(h.pdfjs.portAtOpen).toEqual([null]);
  });

  test("a worker from another pdf.js version moves everything to the main thread", async () => {
    const mismatch = new Error('The API version "6.3.289" does not match the Worker version "5.0.0".');
    const h = harness({ behaviour: "ready", fail: (port) => (port ? mismatch : null) });

    await h.loader.open("/a.pdf", "/old-worker.js");
    await h.loader.open("/b.pdf", "/old-worker.js");

    const worker = h.workers[0] as unknown as Worker;
    // The first document is tried on the worker, then again on the main
    // thread. The second one goes straight to the main thread.
    expect(h.pdfjs.opened).toEqual(["/a.pdf", "/a.pdf", "/b.pdf"]);
    expect(h.pdfjs.portAtOpen).toEqual([worker, null, null]);
    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.mainThreadLoads()).toBe(1);
  });

  test("any other failure is the document's, and the worker stays", async () => {
    const broken = new Error("Invalid PDF structure.");
    const h = harness({ behaviour: "ready", fail: (_port, call) => (call === 1 ? broken : null) });

    await expect(h.loader.open("/broken.pdf", "/pdf.worker.js")).rejects.toThrow("Invalid PDF structure.");
    await h.loader.open("/good.pdf", "/pdf.worker.js");

    expect(h.pdfjs.opened).toEqual(["/broken.pdf", "/good.pdf"]);
    expect(h.workers[0]!.terminated).toBe(false);
    expect(h.mainThreadLoads()).toBe(0);
  });
});

test("a pdf.js that failed to load is loaded again on the next open", async () => {
  let attempts = 0;
  const pdfjs: PdfjsModule = {
    GlobalWorkerOptions: { workerPort: null },
    getDocument: () => ({ promise: Promise.resolve({ numPages: 1 } as unknown as PdfDocument) }),
  };
  const loader = createPdfLoader({
    importPdfjs: async () => {
      if (++attempts === 1) throw new TypeError("Failed to fetch dynamically imported module");
      return pdfjs;
    },
    loadMainThreadWorker: async () => {},
    createWorker: () => {
      throw new Error("unused");
    },
    readyTimeoutMs: 20,
  });

  await expect(loader.open("/a.pdf", "")).rejects.toThrow("Failed to fetch");
  const doc = await loader.open("/a.pdf", "");

  expect(attempts).toBe(2);
  expect(doc.numPages).toBe(1);
});

test("opening waits for a close in flight", async () => {
  const h = harness({ behaviour: "ready" });
  const first = await h.loader.open("/a.pdf", "/pdf.worker.js");

  let finishDestroy!: () => void;
  const destroyed = new Promise<void>((resolve) => (finishDestroy = resolve));
  (first as unknown as { loadingTask: { destroy: () => Promise<void> } }).loadingTask.destroy = () => destroyed;
  h.loader.close(first);

  const second = h.loader.open("/b.pdf", "/pdf.worker.js");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(h.pdfjs.opened).toEqual(["/a.pdf"]);

  finishDestroy();
  await second;
  expect(h.pdfjs.opened).toEqual(["/a.pdf", "/b.pdf"]);
});
