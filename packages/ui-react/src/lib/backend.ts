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
import { uiConfig } from "../config.js";

/** Base URL for API calls. Empty backendUrl = same-origin "/api". */
export function apiBase(): string {
  return `${uiConfig.backendUrl}/api`;
}

/** WebSocket URL. Derives wss/ws + host from backendUrl, else same-origin. */
export function getWsUrl(): string {
  if (uiConfig.backendUrl) {
    const url = new URL("/ws", uiConfig.backendUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }
  // Same-origin (default).
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

/** Base URL for direct fetch calls (streaming endpoints). */
export function getBackendUrl(path: string): string {
  return `${uiConfig.backendUrl}${path}`;
}
