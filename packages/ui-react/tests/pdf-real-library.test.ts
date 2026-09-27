// The PDF loader against the real pdf.js (#529). pdf-loader.test.ts proves
// which way the loader goes; this proves each way works with the library
// itself: the main-thread fallback opens and reads a multi-page document, and
// documents sharing one worker do not strand each other when one closes.
//
// Runs in a child process. Outside a browser, pdf.js polyfills globals as it
// loads, and it throws if another test file in the same process has left
// `navigator` without a setter.
import { afterAll, beforeAll, expect, test } from "bun:test";

const CHILD_MARKER = "BRAIN_UI_REACT_PDF_REAL_LIBRARY_CHILD";

if (!process.env[CHILD_MARKER]) {
  test("the real-library PDF tests pass in an isolated process", async () => {
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
    if (exitCode !== 0) throw new Error(`Isolated real-library PDF tests failed (${exitCode})\n${output}`);
    // A child that registered no tests also exits 0.
    expect(output).toMatch(/\b2 pass\b/);
  });
} else {
  /** A minimal, well-formed PDF with one line of Helvetica text per page. */
  function makePdf(lines: string[]): Uint8Array<ArrayBuffer> {
    const objects: string[] = [];
    const pageIds = lines.map((_, i) => 4 + i * 2);
    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${lines.length} >>`;
    objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
    lines.forEach((line, i) => {
      const stream = `BT /F1 24 Tf 72 720 Td (${line}) Tj ET`;
      objects[4 + i * 2] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
      objects[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });

    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let id = 1; id < objects.length; id++) {
      offsets[id] = out.length;
      out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(out);
  }

  const LINES = ["First page", "Second page", "Third page"];
  const SHORT = ["Only page", "Last page"];
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    const pdfs: Record<string, Uint8Array<ArrayBuffer>> = { "/report.pdf": makePdf(LINES), "/notes.pdf": makePdf(SHORT) };
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => new Response(pdfs[new URL(req.url).pathname]!, { headers: { "Content-Type": "application/pdf" } }),
    });
  });

  afterAll(() => server.stop(true));

  // Outside a browser, pdf.js finds its worker code by itself when nothing is
  // registered. Point it at nothing, as a browser without a worker URL would
  // be, so the hook this module registers is the only way the document opens.
  const { GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = "./no-such-pdf-worker.mjs";
  const { closePdf, createPdfLoader, openPdf } = await import("../src/lib/pdf.js");

  test("with no worker URL, the bundled pdf.js opens a multi-page document on the main thread", async () => {
    const doc = await openPdf(`http://127.0.0.1:${server.port}/report.pdf`, "");
    try {
      expect(doc.numPages).toBe(LINES.length);
      for (let n = 1; n <= LINES.length; n++) {
        const page = await doc.getPage(n);
        const text = await page.getTextContent();
        const strings = text.items.map((item) => ("str" in item ? item.str : "")).join("");
        expect(strings).toBe(LINES[n - 1]!);
      }
    } finally {
      closePdf(doc);
    }
  });

  /**
   * One end of an in-memory channel, standing in for a Worker and the worker's
   * own scope. `hold` keeps back the messages it matches until `release()`.
   */
  class MemoryPort extends EventTarget {
    other!: MemoryPort;
    terminated = false;
    hold: ((data: { targetName?: string }) => boolean) | null = null;
    held: unknown[] = [];
    postMessage(data: unknown, transfer?: Transferable[]) {
      const copy = structuredClone(data, { transfer: transfer ?? [] });
      if (this.hold?.(copy as { targetName?: string })) {
        this.held.push(copy);
        return;
      }
      this.deliver(copy);
    }
    release() {
      this.hold = null;
      for (const data of this.held.splice(0)) this.deliver(data);
    }
    private deliver(data: unknown) {
      setTimeout(() => {
        if (!this.terminated && !this.other.terminated) this.other.dispatchEvent(new MessageEvent("message", { data }));
      }, 0);
    }
    terminate() {
      this.terminated = true;
    }
  }
  // pdf.js accepts only a Worker as a port, and this one is standing in for one.
  Object.setPrototypeOf(MemoryPort.prototype, Worker.prototype);

  test("closing one document while another opens on the same worker leaves the other to finish", async () => {
    const { WorkerMessageHandler } = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
    let scope!: MemoryPort;
    const loader = createPdfLoader({
      importPdfjs: async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as never,
      loadMainThreadWorker: async () => {
        throw new Error("the worker is up; nothing should fall back");
      },
      // pdf.js's real worker code, answering over an in-memory port.
      createWorker: () => {
        const main = new MemoryPort();
        scope = new MemoryPort();
        main.other = scope;
        scope.other = main;
        (WorkerMessageHandler as { initializeFromPort(port: unknown): void }).initializeFromPort(scope);
        return main as unknown as Worker;
      },
      readyTimeoutMs: 5000,
    });
    const base = `http://127.0.0.1:${server.port}`;

    const first = await loader.open(`${base}/report.pdf`, "memory://pdf-worker");
    // The worker is slow to answer the second document: its reply to the
    // request that opens a document (addressed to the worker's handle, not to
    // a document) waits until the first document has finished closing.
    scope.hold = (data) => data.targetName === "main";
    const second = loader.open(`${base}/notes.pdf`, "memory://pdf-worker");
    await new Promise((resolve) => setTimeout(resolve, 20));
    loader.close(first);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scope.held.length).toBeGreaterThan(0);
    scope.release();

    const stranded = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("the second document never finished opening")), 10_000)
    );
    const doc = await Promise.race([second, stranded]);
    expect(doc.numPages).toBe(SHORT.length);
    const text = await (await doc.getPage(2)).getTextContent();
    expect(text.items.map((item) => ("str" in item ? item.str : "")).join("")).toBe("Last page");
  });
}
