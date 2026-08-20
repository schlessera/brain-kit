import { apiBase } from "./backend.js";
import type { RenderRequest } from "@schlessera/brain-ui-sdk/protocol";

export type ShareKind = "file" | "text" | "richtext";

/**
 * True when the browser supports navigator.share at all. Note this doesn't
 * guarantee that a specific payload is shareable — call canShareFiles too.
 */
export function isShareSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

function canShareFiles(files: File[]): boolean {
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function") return false;
  try {
    return navigator.canShare({ files });
  } catch {
    return false;
  }
}

function triggerDownload(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/**
 * Share a File via the OS share sheet. Falls back to a browser download
 * when the platform can't share files (desktop Chrome / Firefox).
 *
 * Returns true if the share dialog (or fallback) was triggered, false if
 * the user dismissed it.
 */
export async function shareFile(
  file: File,
  opts: { title?: string; text?: string } = {}
): Promise<boolean> {
  if (isShareSupported() && canShareFiles([file])) {
    try {
      await navigator.share({ files: [file], title: opts.title, text: opts.text });
      return true;
    } catch (err) {
      // AbortError = user cancelled; anything else falls through to download
      if (err instanceof DOMException && err.name === "AbortError") return false;
      console.warn("[share] navigator.share failed, falling back to download:", err);
    }
  }
  triggerDownload(file);
  return true;
}

/**
 * Share plain text / a URL via the OS share sheet. Falls back to clipboard
 * copy when unavailable.
 */
export async function shareText(
  data: { text: string; title?: string; url?: string }
): Promise<boolean> {
  if (isShareSupported()) {
    try {
      await navigator.share({ title: data.title, text: data.text, url: data.url });
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return false;
      console.warn("[share] navigator.share text failed, falling back to clipboard:", err);
    }
  }
  try {
    await navigator.clipboard.writeText(data.url ? `${data.text}\n${data.url}` : data.text);
    return true;
  } catch (err) {
    console.warn("[share] clipboard.writeText failed:", err);
    return false;
  }
}

/**
 * Copy rich text (HTML + plain) to the clipboard. Best-effort: on browsers
 * that don't support ClipboardItem, falls back to plain text only.
 */
export async function copyRichText(html: string, plain: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      const item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      return true;
    }
    await navigator.clipboard.writeText(plain);
    return true;
  } catch (err) {
    console.warn("[share] copyRichText failed:", err);
    return false;
  }
}

/**
 * Fetch a URL into a File. Used to wrap the existing
 * /api/files/content?raw=1 endpoint for share-the-bytes flows.
 */
export async function fetchAsFile(
  url: string,
  filename: string,
  mime?: string
): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const blob = await res.blob();
  return new File([blob], filename, { type: mime ?? blob.type ?? "application/octet-stream" });
}

/**
 * POST to /api/render and return the resulting File. Throws on non-2xx.
 */
export async function renderToFile(
  req: RenderRequest,
  filename: string
): Promise<File> {
  const res = await fetch(`${apiBase()}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = (j as { error?: string; detail?: string }).detail ?? (j as { error?: string }).error ?? detail;
    } catch {
      // ignore
    }
    throw new Error(`Render failed (${res.status}): ${detail}`);
  }
  const blob = await res.blob();
  const ext = req.format === "png" ? "png" : "pdf";
  const safeBase = filename.replace(/\.(png|pdf|md|html?|txt)$/i, "");
  return new File([blob], `${safeBase}.${ext}`, {
    type: req.format === "png" ? "image/png" : "application/pdf",
  });
}

/**
 * One-call helper: render content to PNG/PDF and dispatch the share sheet.
 */
export async function renderAndShare(opts: {
  content: string;
  contentType: RenderRequest["contentType"];
  format: RenderRequest["format"];
  filename: string;
  title?: string;
  text?: string;
}): Promise<boolean> {
  const file = await renderToFile(
    { content: opts.content, contentType: opts.contentType, format: opts.format, title: opts.title },
    opts.filename
  );
  return shareFile(file, { title: opts.title, text: opts.text });
}
