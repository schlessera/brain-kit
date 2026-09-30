import { resolveEnv } from "../../config/env.js";

/**
 * Core's internal adapter for the optional Puppeteer package. Turns a
 * self-contained HTML document into page bytes; absent when that package is
 * not installed, in which case `brain render` still writes HTML and says what
 * to install for PDF/PNG. This is not a public extension seam or provider
 * injection contract; the Puppeteer package owns its public renderer API.
 *
 * @internal
 */
export interface DocumentRenderer {
  renderPdf(opts: { html: string; width?: number }): Promise<Buffer>;
  renderPng(opts: { html: string; width?: number }): Promise<Buffer>;
  shutdown(): Promise<void>;
}

/** Thrown when PDF/PNG was asked for but the optional renderer is absent. */
export class RendererUnavailableError extends Error {}

const INSTALL_HINT =
  "PDF/PNG rendering needs the optional renderer package. Install it in the brain repo:\n" +
  "  bun add @schlessera/brain-render-puppeteer\n" +
  "It drives a headless Chrome, so Chrome (or Chromium) must also be present; set\n" +
  "PUPPETEER_EXECUTABLE_PATH if it lives somewhere unusual. `brain render --format html`\n" +
  "works without either and writes the same document as HTML.";

/**
 * Resolve the optional document renderer.
 *
 * Mirrors how the completion/embedding providers treat `@google/genai`: an
 * optional peer, imported dynamically, with a clean explanation rather than a
 * module-resolution stack trace when it is missing. The package is deliberately
 * not a hard dependency — it pulls puppeteer-core and expects a browser, which
 * no other part of core needs.
 */
export async function resolveDocumentRenderer(opts: {
  /** Chrome without its sandbox. Required when running as root (containers). */
  noSandbox?: boolean;
  /** Image hosts the page may resolve. Default: none — the page is offline. */
  allowHosts?: string[];
  /** Page creation/rendering budget in ms; excludes queue/browser acquisition. */
  renderTimeoutMs?: number;
}): Promise<DocumentRenderer> {
  const mod = await import("@schlessera/brain-render-puppeteer").catch(() => {
    throw new RendererUnavailableError(INSTALL_HINT);
  });
  return mod.createRenderer({
    noSandbox: opts.noSandbox ?? false,
    allowHosts: opts.allowHosts ?? [],
    renderTimeoutMs: opts.renderTimeoutMs,
    // One render per invocation, so keep the browser on a short leash.
    maxConcurrent: 1,
    idleTimeoutMs: 5_000,
  });
}

/**
 * Chrome refuses to start as root with its sandbox on, which is the normal case
 * inside a container. `BRAIN_UI_CHROME_NO_SANDBOX` is the spelling a
 * chat-server deployment sets, and the server passes it to the brain CLI it
 * spawns (`ui-sdk/src/server/subprocess-env.ts`), so honour it as well as the
 * CLI-native spelling.
 */
export function noSandboxFromEnv(): boolean {
  return resolveEnv().chromeNoSandbox;
}
