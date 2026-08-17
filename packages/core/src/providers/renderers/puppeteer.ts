import type { DocumentRenderer } from "../../lib/seams.js";

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
  /** Per-render budget in ms, browser launch included. */
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
 * inside a container. `BRAIN_UI_CHROME_NO_SANDBOX` is the name the brain-ui
 * image already sets, so honour it as well as the CLI-native spelling.
 */
export function noSandboxFromEnv(): boolean {
  return (
    process.env.BRAIN_CHROME_NO_SANDBOX === "1" ||
    process.env.BRAIN_UI_CHROME_NO_SANDBOX === "1"
  );
}
