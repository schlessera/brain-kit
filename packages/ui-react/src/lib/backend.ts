/**
 * Where the API and WebSocket live.
 *
 * Default topology is SAME-ORIGIN: the server serves the built client and the
 * API/WS from one origin, so API calls go to "/api" and the WebSocket derives
 * its host from window.location. Nothing needs configuring.
 *
 * A SPLIT topology (client and backend on different origins) sets
 * `backendUrl` through `configureBrainUi()`. These are functions rather than
 * module constants on purpose: a constant would freeze the value at import
 * time, and ES imports are hoisted, so it would always capture the default
 * instead of what the shell configured.
 */
import { uiConfig, type BrainUiConfig } from "../config.js";

/** Base URL for API calls. Empty backendUrl = same-origin "/api". */
export function apiBaseFor(config: BrainUiConfig): string {
  return `${config.backendUrl}/api`;
}

/** WebSocket URL. Derives wss/ws + host from backendUrl, else same-origin. */
export function getWsUrlFor(
  config: BrainUiConfig,
  location?: Pick<Location, "protocol" | "host">,
): string {
  if (config.backendUrl) {
    const url = new URL("/ws", config.backendUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }
  // Same-origin (default).
  const origin = location ?? window.location;
  const protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${origin.host}/ws`;
}

/** Base URL for direct fetch calls (streaming endpoints). */
export function getBackendUrlFor(config: BrainUiConfig, path: string): string {
  return `${config.backendUrl}${path}`;
}

// Existing consumers still address the default configuration. Root-owned
// clients use the explicit helpers above, and keep their config in a closure.
export function apiBase(): string { return apiBaseFor(uiConfig); }
export function getWsUrl(): string { return getWsUrlFor(uiConfig); }
export function getBackendUrl(path: string): string { return getBackendUrlFor(uiConfig, path); }
