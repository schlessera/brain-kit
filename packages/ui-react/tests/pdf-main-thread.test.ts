// The main-thread fallback against the real pdf.js (#529). pdf-loader.test.ts
// proves when the fallback is chosen; this proves it works: the bundled
// pdf.js, with its worker code loaded into this thread through the
// `globalThis.pdfjsWorker` hook, opens a multi-page document served over
// HTTP and reads every page.
//
// Runs in a child process. Outside a browser, pdf.js polyfills globals as it
// loads, and it throws if another test file in the same process has left
// `navigator` without a setter.
import { afterAll, beforeAll, expect, test } from "bun:test";

const CHILD_MARKER = "BRAIN_UI_REACT_PDF_MAIN_THREAD_CHILD";

if (!process.env[CHILD_MARKER]) {
  test("the main-thread fallback passes in an isolated process", async () => {
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
    if (exitCode !== 0) throw new Error(`Isolated main-thread PDF test failed (${exitCode})\n${stdout}${stderr}`);
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
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    const pdf = makePdf(LINES);
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(pdf, { headers: { "Content-Type": "application/pdf" } }),
    });
  });

  afterAll(() => server.stop(true));

  // Outside a browser, pdf.js finds its worker code by itself when nothing is
  // registered. Point it at nothing, as a browser without a worker URL would
  // be, so the hook this module registers is the only way the document opens.
  const { GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = "./no-such-pdf-worker.mjs";
  const { closePdf, openPdf } = await import("../src/lib/pdf.js");

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
}
