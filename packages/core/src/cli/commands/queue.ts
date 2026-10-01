import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { emit, parseArgs, UsageError } from "../io.js";
import type { CoreCommand } from "../types.js";

const resultSchema = z.object({ queued: z.literal(true), created: z.boolean(),
  threadId: z.string().min(1), itemId: z.string().min(1), stagingId: z.string().min(1) });
const credentialSchema = z.strictObject({ server: z.string(), cookie: z.string() });

function serverOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new UsageError("--server must be an HTTP(S) origin"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) throw new UsageError("--server must be an HTTP(S) origin without credentials, path or query");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new UsageError("Queue credentials require HTTPS; HTTP is allowed only on loopback");
  }
  return url.origin;
}

async function credential(path: string, audience: string): Promise<string> {
  // An explicit private file binds a cookie to one audience. Provider keys and
  // ambient session env vars never become queue credentials.
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

async function readResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty queue response");
  let size = 0;
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw new Error("Oversized queue response");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}

export const queueCommand: CoreCommand = {
  summary: "Queue intake on a UI server without filing content",
  helpBlock: "  brain queue add --server ORIGIN --key KEY [--credential-file FILE] [--title TITLE] [--text TEXT] [--url URL] [--json]",
  async run(rest, cli) {
    const { args, flags } = parseArgs(rest);
    if (args.length !== 1 || args[0] !== "add") throw new UsageError("Usage: brain queue add --server ORIGIN --key KEY --text TEXT|--url URL");
    const allowed = new Set(["server", "key", "credential-file", "title", "text", "url", "json", "human", "root"]);
    for (const key of Object.keys(flags)) if (!allowed.has(key)) throw new UsageError(`Unsupported queue flag: --${key}`);
    for (const key of ["server", "key", "credential-file", "title", "text", "url"]) {
      if (flags[key] !== undefined && typeof flags[key] !== "string") throw new UsageError(`--${key} needs a value`);
    }
    if (typeof flags.server !== "string" || typeof flags.key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(flags.key)) {
      throw new UsageError("--server and a 1–128 character --key (letters, digits, . _ : -) are required");
    }
    if (![flags.title, flags.text, flags.url].some(value => typeof value === "string" && value.trim())) throw new UsageError("Queue intake needs --title, --text or --url");
    const origin = serverOrigin(flags.server);
    const fail = (code: string, message: string, exit: number) => {
      emit(cli.json, { queued: false, error: { code, message } }, () => console.error(message));
      return exit;
    };
    let cookie: string | undefined;
    if (typeof flags["credential-file"] === "string") {
      try { cookie = await credential(flags["credential-file"], origin); }
      catch { return fail("credential_file_invalid", "Queue credential file is invalid, not private, or belongs to another server.", 1); }
    }
    let response: Response;
    try {
      response = await fetch(`${origin}/api/queue`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", accept: "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ key: flags.key, ...(typeof flags.title === "string" ? { title: flags.title } : {}),
          ...(typeof flags.text === "string" ? { text: flags.text } : {}), ...(typeof flags.url === "string" ? { url: flags.url } : {}) }),
      });
    } catch { return fail("server_unavailable", "Queue server unavailable; retry with the same --key.", 2); }
    if (response.status === 401 || response.status === 403) return fail("unauthorized", "Queue server refused this credential.", 1);
    if (response.status === 409) return fail("key_conflict", "Queue key was already used for different content.", 1);
    if (!response.ok) return fail("queue_failed", "Queue intake failed; retry with the same --key.", response.status >= 500 ? 2 : 1);
    let result: z.infer<typeof resultSchema>;
    try { result = resultSchema.parse(await readResponse(response)); }
    catch { return fail("invalid_response", "Queue server returned an invalid response; retry with the same --key.", 2); }
    emit(cli.json, result, () => console.log(`Queued ${result.itemId}${result.created ? "" : " (already queued)"}. Content has not been filed.`));
    return 0;
  },
};
