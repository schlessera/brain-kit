/**
 * The PDF extractor child (#3154, docs/plans/chat-attachments.md §7.3). One
 * short-lived process per read: the parent passes the verified original on
 * stdin and the bounded request as its one argument, and this writes one JSON
 * line to stdout. It reads no file, takes no environment beyond `PATH`, and
 * runs pdf.js with no worker fetch and no font loading; the installed 6.3.289
 * build has no eval path at all, so the design's `isEvalSupported` option no
 * longer exists. Nothing of the document is executed or fetched. The parent owns the time, CPU and
 * memory bounds and kills this process when one is hit.
 */
import { ATTACHMENT_MAX_FILE_BYTES } from "@schlessera/brain-ui-sdk/protocol";
import { cutUtf8, pageHeader, type ExtractRequest, type ExtractResponse } from "./extract-protocol.js";

async function readStdin(): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of Bun.stdin.stream()) {
    size += chunk.byteLength;
    if (size > ATTACHMENT_MAX_FILE_BYTES) throw new Error("input exceeds the attachment bound");
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** One page's text: items joined, a newline where pdf.js marks the end of a line. */
function pageText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let text = "";
  for (const item of items) if (typeof item.str === "string") text += item.str + (item.hasEOL ? "\n" : "");
  return text.trimEnd();
}

export async function extract(data: Uint8Array, request: ExtractRequest): Promise<ExtractResponse> {
  const { getDocument, PasswordException, InvalidPDFException } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let doc;
  try {
    doc = await getDocument({ data, useWorkerFetch: false, disableFontFace: true, stopAtErrors: false, verbosity: 0 }).promise;
  } catch (error) {
    if (error instanceof PasswordException) return { outcome: "encrypted" };
    if (error instanceof InvalidPDFException) return { outcome: "malformed" };
    return { outcome: "failed", reason: "error" };
  }
  const pageCount = doc.numPages;
  if (request.startPage > pageCount) return { outcome: "out_of_range", pageCount };
  const end = Math.min(request.endPage, pageCount);
  const parts: Uint8Array[] = [];
  let used = 0;
  const pagesWithoutText: number[] = [];
  for (let number = request.startPage; number <= end; number++) {
    const page = await doc.getPage(number);
    const text = Buffer.from(pageText((await page.getTextContent()).items as Array<{ str?: string; hasEOL?: boolean }>));
    if (text.length === 0) { pagesWithoutText.push(number); continue; }
    const from = number === request.startPage ? Math.min(request.offset, text.length) : 0;
    const header = Buffer.from(`${parts.length ? "\n" : ""}${pageHeader(number, from > 0)}`);
    const body = text.subarray(from);
    if (used + header.length + body.length > request.maxBytes) {
      // Cut on a code-point boundary; the cursor resumes inside this page.
      const room = Math.max(0, request.maxBytes - used - header.length);
      const taken = cutUtf8(body, room);
      if (taken.length > 0) { parts.push(header, taken); used += header.length + taken.length; }
      return { outcome: "text", pageCount, pages: [request.startPage, number], text: Buffer.concat(parts).toString(), pagesWithoutText,
        next: { page: number, offset: from + taken.length } };
    }
    parts.push(header, body);
    used += header.length + body.length;
  }
  return { outcome: "text", pageCount, pages: [request.startPage, end], text: Buffer.concat(parts).toString(), pagesWithoutText };
}

if (import.meta.main) {
  let response: ExtractResponse;
  try {
    const request = JSON.parse(process.argv[2] ?? "") as ExtractRequest;
    response = await extract(await readStdin(), request);
  } catch {
    response = { outcome: "failed", reason: "error" };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exit(0);
}
