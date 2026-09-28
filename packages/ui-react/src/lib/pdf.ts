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
 * Each worker is wrapped in one `PDFWorker`, passed to every document
 * explicitly. A document pdf.js made its own worker wrapper for destroys that
 * wrapper when it closes, and on a shared port that strands every other
 * document still opening there.
 */

import type { PDFDocumentProxy } from "pdfjs-dist";

export type PdfDocument = PDFDocumentProxy;

/** The part of pdf.js this module drives, so tests can stand in for it. */
export interface PdfjsModule {
  PDFWorker: { create(params: { port?: Worker }): PdfjsWorker };
  getDocument(params: { url: string; worker: PdfjsWorker }): PdfjsLoadingTask;
}

/** One document opening. pdf.js keeps its transport on the worker until it is destroyed. */
export interface PdfjsLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

/** pdf.js's handle on one worker, real or on the main thread. */
export interface PdfjsWorker {
  destroy(): void;
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
  worker: PdfjsWorker;
  /** The Worker behind `worker`, or null on the main thread. */
  port: Worker | null;
  /** Rejects if the worker fails after reporting ready. pdf.js would wait on it forever. */
  died: Promise<never> | null;
  /** Documents still opening here. A retired worker is terminated when none are left. */
  opening: number;
  retired: boolean;
  /** Documents open on this worker, each with what to call if the worker goes away under it. */
  documents: Map<PdfDocument, () => void>;
}

/** pdf.js's own wording when the worker's version differs from the API's. */
const VERSION_MISMATCH = /does not match the Worker version/;

class WorkerDied extends Error {}

/** Memoize a promise, and forget it if it rejects, so the next caller tries again. */
function retrying<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (pending) return pending;
    const attempt = load();
    pending = attempt;
    attempt.catch(() => {
      if (pending === attempt) pending = null;
    });
    return attempt;
  };
}

export function createPdfLoader(deps: PdfLoaderDeps) {
  const loadPdfjs = retrying(deps.importPdfjs);
  const mainThread = retrying(async (): Promise<Setup> => {
    const pdfjs = await loadPdfjs();
    await deps.loadMainThreadWorker();
    return { pdfjs, worker: pdfjs.PDFWorker.create({}), port: null, died: null, opening: 0, retired: false, documents: new Map() };
  });
  /** One setup per worker URL, so each root gets the worker it configured. */
  const setups = new Map<string, () => Promise<Setup>>();

  function setupFor(workerUrl: string): () => Promise<Setup> {
    let setup = setups.get(workerUrl);
    if (!setup) {
      setup = workerUrl ? retrying(() => onWorker(workerUrl)) : mainThread;
      setups.set(workerUrl, setup);
    }
    return setup;
  }

  /** Documents opened on a worker, so closing one can forget it there. */
  const owners = new WeakMap<PdfDocument, Setup>();

  async function onWorker(url: string): Promise<Setup> {
    const pdfjs = await loadPdfjs();
    const port = await startWorker(url);
    if (!port) return mainThread();
    let die!: (error: Error) => void;
    const died = new Promise<never>((_resolve, reject) => (die = reject));
    died.catch(() => {});
    const setup: Setup = {
      pdfjs,
      worker: pdfjs.PDFWorker.create({ port }),
      port,
      died,
      opening: 0,
      retired: false,
      documents: new Map(),
    };
    port.addEventListener(
      "error",
      () => {
        die(new WorkerDied("The PDF worker stopped"));
        retire(setup, url);
      },
      { once: true }
    );
    return setup;
  }

  /**
   * Stop using a worker: its URL goes to the main thread, and each document
   * open on it is told, because pdf.js would leave its next request waiting
   * forever. The worker itself goes once nothing is still opening on it.
   */
  function retire(setup: Setup, workerUrl: string): void {
    if (setup.retired) return;
    setup.retired = true;
    setups.set(workerUrl, mainThread);
    for (const lost of setup.documents.values()) lost();
    setup.documents.clear();
    terminateIfIdle(setup);
  }

  function terminateIfIdle(setup: Setup): void {
    if (!setup.retired || setup.opening > 0) return;
    setup.worker.destroy();
    setup.port?.terminate();
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

  /** One attempt at a document. A failed one is destroyed, or pdf.js keeps its transport on the worker. */
  async function load(setup: Setup, url: string): Promise<PdfDocument> {
    const task = setup.pdfjs.getDocument({ url, worker: setup.worker });
    try {
      return await (setup.died ? Promise.race([task.promise, setup.died]) : task.promise);
    } catch (error) {
      task.destroy().catch(() => {});
      throw error;
    }
  }

  return {
    /**
     * Open the document at `url`, on the worker at `workerUrl` or on the main
     * thread. A worker built from another pdf.js version starts fine and
     * rejects every document, and a worker can die after it started. Either
     * moves that URL to the main thread: a document still opening is opened
     * again there, and one already open gets `onLost`, so its viewer can open
     * it again too.
     */
    async open(url: string, workerUrl: string, onLost?: () => void): Promise<PdfDocument> {
      const setup = await setupFor(workerUrl)();
      setup.opening++;
      try {
        const doc = await load(setup, url);
        if (setup.port) {
          owners.set(doc, setup);
          // A worker that died after answering leaves this document without one.
          if (setup.retired) queueMicrotask(() => onLost?.());
          else if (onLost) setup.documents.set(doc, onLost);
        }
        return doc;
      } catch (error) {
        const workerFailed =
          error instanceof WorkerDied || VERSION_MISMATCH.test(String((error as Error)?.message));
        if (!setup.port || !workerFailed) throw error;
        retire(setup, workerUrl);
      } finally {
        setup.opening--;
        terminateIfIdle(setup);
      }
      return load(await mainThread(), url);
    },

    /** Release a document opened here. Its worker stays up for the next one. */
    close(doc: PdfDocument): void {
      owners.get(doc)?.documents.delete(doc);
      doc.loadingTask.destroy().catch(() => {});
    },
  };
}

const loader = createPdfLoader({
  // `PdfjsModule` names a worker handle by the one method used here, where
  // pdf.js's `getDocument` asks for its full `PDFWorker`. The handle passed is
  // always one `PDFWorker.create` made.
  importPdfjs: async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule,
  async loadMainThreadWorker() {
    const { WorkerMessageHandler } = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = { WorkerMessageHandler };
  },
  createWorker: (url) => new Worker(url, { type: "module" }),
  readyTimeoutMs: 10_000,
});

export const openPdf = loader.open;
export const closePdf = loader.close;
