// Which previewer a binary file gets (#529). The table in file-viewer-binary
// decides; these tests read it through the same lookup the viewer uses, then
// render the viewer to check each MIME type reaches the right element.
// renderToStaticMarkup runs the render pass only, so the PDF previewer shows
// its frame without loading pdf.js.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileContentResponse } from "@schlessera/brain-ui-sdk/protocol";

import { BrainUiProvider } from "../src/root-context.js";
import { createBrainUiRoot } from "../src/root.js";
import { BINARY_PREVIEWERS, FileViewerBinary, binaryPreviewerFor } from "../src/components/files/file-viewer-binary.js";
import { PdfPreview } from "../src/components/files/pdf-preview.js";

function binary(path: string, mime: string | undefined): FileContentResponse {
  return { path, kind: "binary", size: 2048, mtime: 0, mime };
}

function render(content: FileContentResponse): string {
  const root = createBrainUiRoot({ storage: null });
  try {
    return renderToStaticMarkup(
      <BrainUiProvider root={root}>
        <FileViewerBinary content={content} />
      </BrainUiProvider>
    );
  } finally {
    root.dispose();
  }
}

const rawUrl = (path: string) => `/api/files/content?path=${encodeURIComponent(path)}&amp;raw=1`;

describe("the MIME table", () => {
  test("every entry is what the lookup returns for a type it covers", () => {
    const entries = Object.entries(BINARY_PREVIEWERS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, previewer] of entries) {
      const sample = key.endsWith("/*") ? key.replace("*", "x-sample") : key;
      expect(binaryPreviewerFor(sample)).toBe(previewer);
    }
  });

  test("a PDF gets the PDF previewer", () => {
    expect(binaryPreviewerFor("application/pdf")).toBe(PdfPreview);
    expect(binaryPreviewerFor("Application/PDF")).toBe(PdfPreview);
  });

  test("the audio and video types the server maps get the media previewers", () => {
    expect(binaryPreviewerFor("audio/mpeg")).toBe(BINARY_PREVIEWERS["audio/*"]!);
    expect(binaryPreviewerFor("audio/wav")).toBe(BINARY_PREVIEWERS["audio/*"]!);
    expect(binaryPreviewerFor("video/mp4")).toBe(BINARY_PREVIEWERS["video/*"]!);
    expect(binaryPreviewerFor("video/webm")).toBe(BINARY_PREVIEWERS["video/*"]!);
    expect(BINARY_PREVIEWERS["audio/*"]).not.toBe(BINARY_PREVIEWERS["video/*"]);
  });

  test("an unknown or missing type gets no previewer", () => {
    expect(binaryPreviewerFor("application/octet-stream")).toBeNull();
    expect(binaryPreviewerFor("application/zip")).toBeNull();
    expect(binaryPreviewerFor(undefined)).toBeNull();
  });
});

describe("the binary viewer", () => {
  test("shows a PDF in the PDF previewer, with its download link", () => {
    const html = render(binary("out/report.pdf", "application/pdf"));

    expect(html).toContain('aria-label="PDF preview: report.pdf"');
    expect(html).toContain(`href="${rawUrl("out/report.pdf")}"`);
    expect(html).toContain('download="report.pdf"');
    expect(html).not.toContain("Preview not available");
  });

  test("plays audio in a native audio element", () => {
    for (const [path, mime] of [["memo.mp3", "audio/mpeg"], ["memo.wav", "audio/wav"]] as const) {
      const html = render(binary(path, mime));

      expect(html).toContain(`<audio controls="" preload="metadata" src="${rawUrl(path)}"`);
      expect(html).not.toContain("<video");
      expect(html).not.toContain("Preview not available");
    }
  });

  test("plays video inline in a native video element", () => {
    for (const [path, mime] of [["clip.mp4", "video/mp4"], ["clip.webm", "video/webm"]] as const) {
      const html = render(binary(path, mime));

      expect(html).toContain(`<video controls="" playsInline="" preload="metadata" src="${rawUrl(path)}"`);
      expect(html).not.toContain("<audio");
      expect(html).not.toContain("Preview not available");
    }
  });

  test("gives an unknown binary the download card", () => {
    const html = render(binary("archive.zip", "application/zip"));

    expect(html).toContain("Preview not available");
    expect(html).toContain("application/zip · 2.0 KB");
    expect(html).toContain(`href="${rawUrl("archive.zip")}"`);
    expect(html).not.toContain("<audio");
    expect(html).not.toContain("<video");
    expect(html).not.toContain("PDF preview");
  });
});
