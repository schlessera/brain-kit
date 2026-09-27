// Where pdf.js parses (#529): in the shell's worker when `pdfWorkerUrl` starts
// one, on the main thread in every other case. pdf.js and the Worker are
// stood in for here; pdf-real-library.test.ts runs the real library.
import { describe, expect, test } from "bun:test";

import { createPdfLoader, type PdfDocument, type PdfjsModule, type PdfjsWorker } from "../src/lib/pdf.js";

type Behaviour = "ready" | "error" | "silent" | "other-message";

/** A Worker that reports ready, fails to load, or says something else, the way a browser dispatches it. */
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

/** pdf.js's worker wrapper: which port it drives, and whether it was destroyed. */
class FakePdfWorker implements PdfjsWorker {
  destroyed = false;
  constructor(readonly port: FakeWorker | null) {}
  destroy() {
    this.destroyed = true;
  }
}

interface Open {
  url: string;
  worker: FakePdfWorker | undefined;
  destroyed: boolean;
}

function harness(opts: {
  behaviour?: Behaviour;
  createThrows?: boolean;
  readyTimeoutMs?: number;
  /** Per getDocument call: an Error rejects that open, if its worker is still up; "hang" never settles. */
  fail?: (open: Open, call: number) => Error | "hang" | null;
} = {}) {
  const workers: FakeWorker[] = [];
  const wrappers: FakePdfWorker[] = [];
  const opens: Open[] = [];
  let mainThreadLoads = 0;
  const pdfjs: PdfjsModule = {
    PDFWorker: {
      create({ port }) {
        const wrapper = new FakePdfWorker((port as unknown as FakeWorker | undefined) ?? null);
        wrappers.push(wrapper);
        return wrapper;
      },
    },
    getDocument({ url, worker }) {
      const open: Open = { url, worker: worker as FakePdfWorker | undefined, destroyed: false };
      opens.push(open);
      const error = opts.fail?.(open, opens.length) ?? null;
      const doc = { numPages: 1, loadingTask: { destroy: async () => {} } } as unknown as PdfDocument;
      const destroy = async () => {
        open.destroyed = true;
      };
      if (!error) return { promise: Promise.resolve(doc), destroy };
      if (error === "hang") return { promise: new Promise<PdfDocument>(() => {}), destroy };
      // A terminated worker never answers, like a real one.
      return {
        promise: new Promise<PdfDocument>((_resolve, reject) =>
          setTimeout(() => {
            if (!open.worker?.port?.terminated) reject(error);
          }, 5)
        ),
        destroy,
      };
    },
  };
  const loader = createPdfLoader({
    importPdfjs: async () => pdfjs,
    loadMainThreadWorker: async () => {
      mainThreadLoads++;
    },
    createWorker: (url) => {
      if (opts.createThrows) throw new SyntaxError("invalid worker URL");
      const worker = new FakeWorker(url, opts.behaviour ?? "ready");
      workers.push(worker);
      return worker as unknown as Worker;
    },
    readyTimeoutMs: opts.readyTimeoutMs ?? 20,
  });
  /** The port each document was opened on: a worker, null for the main thread. */
  const ports = () => opens.map((o) => (o.worker ? o.worker.port : "no worker passed"));
  return { loader, workers, wrappers, opens, ports, mainThreadLoads: () => mainThreadLoads };
}

const MISMATCH = new Error('The API version "6.3.289" does not match the Worker version "5.0.0".');

describe("with no pdfWorkerUrl", () => {
  test("parses on the main thread and never starts a worker", async () => {
    const h = harness();
    await h.loader.open("/a.pdf", "");

    expect(h.workers).toHaveLength(0);
    expect(h.mainThreadLoads()).toBe(1);
    expect(h.ports()).toEqual([null]);
  });
});

describe("with a pdfWorkerUrl", () => {
  test("a worker that reports ready is the one pdf.js uses", async () => {
    const h = harness({ behaviour: "ready" });
    await h.loader.open("/a.pdf", "/pdf.worker.js");

    expect(h.workers).toHaveLength(1);
    expect(h.workers[0]!.url).toBe("/pdf.worker.js");
    expect(h.ports()).toEqual([h.workers[0]!]);
    expect(h.workers[0]!.terminated).toBe(false);
    expect(h.mainThreadLoads()).toBe(0);
  });

  test("every document gets the one wrapper made for the worker, never one of its own", async () => {
    const h = harness({ behaviour: "ready" });
    await h.loader.open("/a.pdf", "/pdf.worker.js");
    await h.loader.open("/b.pdf", "/pdf.worker.js");

    expect(h.workers).toHaveLength(1);
    expect(h.wrappers).toHaveLength(1);
    expect(h.opens.map((o) => o.worker)).toEqual([h.wrappers[0], h.wrappers[0]]);
  });

  test("a worker that fails to load is terminated and the main thread takes over at once", async () => {
    // The timeout is out of reach, so only the error event can end the wait.
    const h = harness({ behaviour: "error", readyTimeoutMs: 60_000 });
    await h.loader.open("/a.pdf", "/missing.js");

    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.mainThreadLoads()).toBe(1);
    expect(h.ports()).toEqual([null]);
  });

  test("a worker that never reports ready is given up on", async () => {
    const h = harness({ behaviour: "silent" });
    await h.loader.open("/a.pdf", "/hangs.js");

    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.mainThreadLoads()).toBe(1);
    expect(h.ports()).toEqual([null]);
  });

  test("a message other than ready does not count as ready", async () => {
    const h = harness({ behaviour: "other-message" });
    await h.loader.open("/a.pdf", "/some-other-worker.js");

    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.ports()).toEqual([null]);
  });

  test("a URL the Worker constructor rejects falls back too", async () => {
    const h = harness({ createThrows: true });
    await h.loader.open("/a.pdf", "not a url");

    expect(h.mainThreadLoads()).toBe(1);
    expect(h.ports()).toEqual([null]);
  });

  test("each worker URL gets its own worker, so a second root is not bound by the first", async () => {
    const h = harness({ behaviour: "ready" });
    await h.loader.open("/a.pdf", "");
    await h.loader.open("/b.pdf", "/pdf.worker.js");

    expect(h.workers.map((w) => w.url)).toEqual(["/pdf.worker.js"]);
    expect(h.ports()).toEqual([null, h.workers[0]!]);
  });

  test("a worker from another pdf.js version moves that URL to the main thread", async () => {
    const h = harness({ behaviour: "ready", fail: (open) => (open.worker?.port ? MISMATCH : null) });

    await h.loader.open("/a.pdf", "/old-worker.js");
    await h.loader.open("/b.pdf", "/old-worker.js");

    // The first document is tried on the worker, then again on the main
    // thread. The second one goes straight to the main thread.
    expect(h.opens.map((o) => o.url)).toEqual(["/a.pdf", "/a.pdf", "/b.pdf"]);
    expect(h.ports()).toEqual([h.workers[0]!, null, null]);
    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.wrappers[0]!.destroyed).toBe(true);
    expect(h.mainThreadLoads()).toBe(1);
  });

  test("documents opening together on a mismatched worker all reach the main thread", async () => {
    const h = harness({ behaviour: "ready", fail: (open) => (open.worker?.port ? MISMATCH : null) });
    // The worker must outlive the first rejection: a terminated worker never
    // delivers the second one, and that document would wait forever.
    const [a, b] = await Promise.all([h.loader.open("/a.pdf", "/old-worker.js"), h.loader.open("/b.pdf", "/old-worker.js")]);

    expect(a.numPages).toBe(1);
    expect(b.numPages).toBe(1);
    expect(h.ports()).toEqual([h.workers[0]!, h.workers[0]!, null, null]);
    expect(h.workers[0]!.terminated).toBe(true);
  });

  test("any other failure is the document's: its loading task is released, and the worker stays", async () => {
    const broken = new Error("Invalid PDF structure.");
    const h = harness({ behaviour: "ready", fail: (_open, call) => (call === 1 ? broken : null) });

    await expect(h.loader.open("/broken.pdf", "/pdf.worker.js")).rejects.toThrow("Invalid PDF structure.");
    await h.loader.open("/good.pdf", "/pdf.worker.js");

    expect(h.ports()).toEqual([h.workers[0]!, h.workers[0]!]);
    // pdf.js keeps a transport and a message handler on the worker for every
    // loading task until it is destroyed, failed or not.
    expect(h.opens.map((o) => o.destroyed)).toEqual([true, false]);
    expect(h.workers[0]!.terminated).toBe(false);
    expect(h.mainThreadLoads()).toBe(0);
  });

  test("a worker that dies after reporting ready moves the documents waiting on it to the main thread", async () => {
    const h = harness({ behaviour: "ready", fail: (open) => (open.worker?.port ? "hang" : null) });
    const opening = h.loader.open("/a.pdf", "/pdf.worker.js");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.ports()).toEqual([h.workers[0]!]);

    h.workers[0]!.dispatchEvent(new Event("error"));
    const doc = await opening;

    expect(doc.numPages).toBe(1);
    expect(h.ports()).toEqual([h.workers[0]!, null]);
    expect(h.opens[0]!.destroyed).toBe(true);
    expect(h.workers[0]!.terminated).toBe(true);
    // And the next document goes straight to the main thread.
    await h.loader.open("/b.pdf", "/pdf.worker.js");
    expect(h.ports()).toEqual([h.workers[0]!, null, null]);
  });
});

test("a pdf.js that failed to load is loaded again on the next open", async () => {
  let attempts = 0;
  const pdfjs: PdfjsModule = {
    PDFWorker: { create: () => new FakePdfWorker(null) },
    getDocument: () => ({ promise: Promise.resolve({ numPages: 1 } as unknown as PdfDocument), destroy: async () => {} }),
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

test("closing a document destroys its loading task and leaves the worker up", async () => {
  const h = harness({ behaviour: "ready" });
  const doc = await h.loader.open("/a.pdf", "/pdf.worker.js");
  let destroyed = 0;
  (doc as unknown as { loadingTask: { destroy: () => Promise<void> } }).loadingTask.destroy = async () => {
    destroyed++;
  };

  h.loader.close(doc);

  expect(destroyed).toBe(1);
  expect(h.wrappers[0]!.destroyed).toBe(false);
  expect(h.workers[0]!.terminated).toBe(false);
});
