/**
 * Shared transport rules for CLI commands that talk to a UI host
 * (`brain queue`, `brain schedule`): an explicit HTTP(S) origin, an optional
 * private credential file bound to that audience, no redirects, a 10-second
 * timeout and a bounded response body.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";

import { UsageError } from "./io.js";

const credentialSchema = z.strictObject({ server: z.string(), cookie: z.string() });

export class HostResponseTooLargeError extends Error {}

/** Normalize `--server`; throws UsageError. HTTP is allowed only on loopback. */
export function serverOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new UsageError("--server must be an HTTP(S) origin"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) throw new UsageError("--server must be an HTTP(S) origin without credentials, path or query");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new UsageError("Host credentials require HTTPS; HTTP is allowed only on loopback");
  }
  return url.origin;
}

/**
 * Read the cookie header from a private credential file. An explicit file
 * binds a cookie to one audience; provider keys and ambient session
 * environment variables never become host credentials. Throws on any defect.
 */
export async function credentialCookie(path: string, audience: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0) throw new Error("Invalid credential file");
    const parsed = credentialSchema.parse(JSON.parse(await file.readFile("utf8")));
    if (serverOrigin(parsed.server) !== audience) throw new Error("Wrong credential audience");
    const cookie = decodeURIComponent(parsed.cookie);
    if (!/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9+/]{43}=$/.test(cookie)) throw new Error("Invalid credential");
    return `brain_ui_session=${encodeURIComponent(cookie)}`;
  } finally { await file.close(); }
}

/** Read and parse a JSON response, refusing more than `maxBytes`. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty host response");
  let size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new HostResponseTooLargeError("Oversized host response");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}

/** One request with the shared rules: manual redirects, 10-second timeout. */
export function hostFetch(origin: string, path: string, init: { method: "GET" | "POST"; cookie?: string; body?: unknown }): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: init.method,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: "application/json",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}
