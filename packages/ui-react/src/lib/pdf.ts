/**
 * pdf.js, loaded on first use, and the choice of where it parses.
 *
 * pdf.js parses documents in a worker script. This package is compiled with
 * tsc and bundled by its consumer, so it cannot name that script's URL itself:
 * a `new URL(…, import.meta.url)` inside a dependency does not survive Vite's
 * dependency pre-bundling (vitejs/vite#10837). The shell imports the worker as
 * an asset and passes its URL in as `pdfWorkerUrl`.
 *
 * Every other case parses on the main thread: no URL, a URL that does not
 * start a worker, and a worker from a different pdf.js version than the one
 * bundled here. pdf.js supports this through its `globalThis.pdfjsWorker`
 * hook. A heavy document is slower that way, but it still opens. pdf.js has
 * a fallback of its own, but it re-imports the same `workerSrc` that just
 * failed, so it is not used: the worker is started here, and handed to
 * pdf.js only once it has said it is ready.
 *
 * The choice is made once per page, by the first document opened, because
 * pdf.js keeps it in module globals.
 */

import type { PDFDocumentProxy } from "pdfjs-dist";

export type PdfDocument = PDFDocumentProxy;

/** The part of pdf.js this module drives, so tests can stand in for it. */
export interface PdfjsModule {
  GlobalWorkerOptions: { workerPort: Worker | null };
  getDocument(params: { url: string }): { promise: Promise<PdfDocument> };
}

export interface PdfLoaderDeps {
  importPdfjs: () => Promise<PdfjsModule>;
  /** Loads pdf.js's worker code into this thread and registers it on `globalThis.pdfjsWorker`. */
  loadMainThreadWorker: () => Promise<void>;
  createWorker: (url: string) => Worker;
  /** How long a worker gets to report ready before the main thread takes over. */
  readyTimeoutMs: number;
}

interface Setup {
  pdfjs: PdfjsModule;
  worker: Worker | null;
}

/** pdf.js's own wording when the worker's version differs from the API's. */
const VERSION_MISMATCH = /does not match the Worker version/;

export function createPdfLoader(deps: PdfLoaderDeps) {
  let setup: Promise<Setup> | null = null;
  // pdf.js refuses a new document on a worker port while a previous one is
  // still being destroyed on it, so opening waits for every close in flight.
  let closing: Promise<unknown> = Promise.resolve();

  async function onMainThread(pdfjs: PdfjsModule): Promise<Setup> {
    pdfjs.GlobalWorkerOptions.workerPort = null;
    await deps.loadMainThreadWorker();
    return { pdfjs, worker: null };
  }

  async function init(workerUrl: string): Promise<Setup> {
    const pdfjs = await deps.importPdfjs();
    const worker = workerUrl ? await startWorker(workerUrl) : null;
    if (!worker) return onMainThread(pdfjs);
    pdfjs.GlobalWorkerOptions.workerPort = worker;
    return { pdfjs, worker };
  }

  /**
   * The worker, once its first message says it is running, or null. A
   * missing script, a non-script response or a syntax error all fire
   * `error`. A worker that says nothing is given up on after the timeout.
   */
  function startWorker(url: string): Promise<Worker | null> {
    let worker: Worker;
    try {
      worker = deps.createWorker(url);
    } catch {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const finish = (ready: boolean) => {
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        if (!ready) worker.terminate();
        resolve(ready ? worker : null);
      };
      const onMessage = (event: MessageEvent) => {
        if ((event.data as { action?: unknown } | null)?.action === "ready") finish(true);
      };
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), deps.readyTimeoutMs);
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
    });
  }

  return {
    /**
     * Open the document at `url`. `workerUrl` is read by the first call only.
     * A worker built from another pdf.js version starts fine and rejects the
     * first document, so that rejection moves everything to the main thread
     * and the document is opened again there.
     */
    async open(url: string, workerUrl: string): Promise<PdfDocument> {
      await closing;
      const current = (setup ??= init(workerUrl));
      let pdfjs: PdfjsModule;
      let worker: Worker | null;
      try {
        ({ pdfjs, worker } = await current);
      } catch (error) {
        // pdf.js's chunk did not load, e.g. offline. The next open tries again.
        if (setup === current) setup = null;
        throw error;
      }
      try {
        return await pdfjs.getDocument({ url }).promise;
      } catch (error) {
        if (!worker || !VERSION_MISMATCH.test(String((error as Error)?.message))) throw error;
        if (setup === current) {
          worker.terminate();
          setup = onMainThread(pdfjs);
        }
        return (await setup).pdfjs.getDocument({ url }).promise;
      }
    },

    /** Release a document opened here. */
    close(doc: PdfDocument): void {
      closing = Promise.all([closing, doc.loadingTask.destroy().catch(() => {})]);
    },
  };
}

const loader = createPdfLoader({
  importPdfjs: () => import("pdfjs-dist/legacy/build/pdf.mjs"),
  async loadMainThreadWorker() {
    const { WorkerMessageHandler } = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = { WorkerMessageHandler };
  },
  createWorker: (url) => new Worker(url, { type: "module" }),
  readyTimeoutMs: 10_000,
});

export const openPdf = loader.open;
export const closePdf = loader.close;
