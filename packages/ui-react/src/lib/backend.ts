/**
 * Backend URL configuration.
 *
 * Default topology is SAME-ORIGIN: the server serves the built client and the
 * API/WS from one origin, so API calls go to "/api" and the WebSocket derives
 * its host from window.location. No build-time configuration is needed.
 *
 * VITE_BACKEND_URL is optional advanced config for a SPLIT topology (client and
 * backend on different origins, e.g. a public frontend with the backend reached
 * over a VPN). When set at build time, API and WS calls target that origin.
 * The read is defensive — outside a Vite build (bun test, Node import of the
 * dist) `import.meta.env` does not exist.
 */
const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
const BACKEND_URL = viteEnv?.VITE_BACKEND_URL?.replace(/\/$/, "") ?? "";

/** Base URL for API calls. Empty BACKEND_URL = same-origin "/api". */
export const API_BASE = `${BACKEND_URL}/api`;

/** WebSocket URL. Derives wss/ws + host from BACKEND_URL, else same-origin. */
export function getWsUrl(): string {
  if (BACKEND_URL) {
    const url = new URL("/ws", BACKEND_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }
  // Same-origin (default).
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

/** Base URL for direct fetch calls (streaming endpoints). */
export function getBackendUrl(path: string): string {
  return `${BACKEND_URL}${path}`;
}
