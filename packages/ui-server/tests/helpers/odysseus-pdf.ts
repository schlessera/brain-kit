/**
 * Deterministic Odysseus PDFs for the attachment reader (#3154), written byte
 * by byte so no generator, network or binary fixture is needed. Each page is
 * either text in the standard Helvetica font or drawing operators only (a
 * stand-in for a scanned page). `encrypted` adds a standard security handler
 * whose user password is not empty, so a reader without a password must
 * refuse it.
 */

export interface OdysseusPage {
  /** Lines of text; omit for a page with drawing operators only. */
  lines?: string[];
}

function escapePdf(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

function content(page: OdysseusPage): string {
  if (!page.lines) return "0.2 w 40 40 m 500 700 l S 60 80 300 200 re S";
  // Small type and leading: pdf.js drops text set below the page, so a dense page holds about 110 lines.
  const ops = ["BT", "/F1 6 Tf", "7 TL", "20 800 Td"];
  for (const line of page.lines) ops.push(`(${escapePdf(line)}) Tj T*`);
  ops.push("ET");
  return ops.join("\n");
}

export function odysseusPdf(pages: OdysseusPage[], options: { encrypted?: boolean } = {}): Uint8Array {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  pages.forEach((page, i) => {
    const stream = content(page);
    objects[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });
  const encryptId = objects.length;
  if (options.encrypted) {
    // R2/V1 with arbitrary O and U: the empty user password cannot match U.
    objects[encryptId] = `<< /Filter /Standard /V 1 /R 2 /O <${"4f".repeat(32)}> /U <${"55".repeat(32)}> /P -44 >>`;
  }
  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, "latin1");
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  const id = "<6f647973736575732d6974686163612d>";
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /ID [${id} ${id}]${options.encrypted ? ` /Encrypt ${encryptId} 0 R` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

/** The fact only the permit's second page states; never in a name or metadata. */
export const PERMIT_FACT = "Berth seven is reserved for the raft of Odysseus until the new moon.";

/** A three-page harbour permit; page 2 alone carries the fact. */
export function ithacaPermitPdf(): Uint8Array {
  return odysseusPdf([
    { lines: ["Ithaca harbour authority", "Mooring permit 2026-07-12", "Issued to: Odysseus, son of Laertes"] },
    { lines: ["Conditions of mooring", PERMIT_FACT, "Penelope countersigns for the household."] },
    { lines: ["Telemachus keeps the duplicate.", "End of permit."] },
  ]);
}

/** `count` text pages, each naming its number, with `fill` (at most 100) extra filler lines. */
export function logbookPdf(count: number, fill = 0): Uint8Array {
  return odysseusPdf(Array.from({ length: count }, (_, i) => ({
    lines: [`Logbook of the voyage, day ${i + 1}`, ...Array.from({ length: fill }, (_, j) => `Day ${i + 1} line ${j + 1}: the crew rows past the island of Aeolus under a steady wind.`)],
  })));
}
