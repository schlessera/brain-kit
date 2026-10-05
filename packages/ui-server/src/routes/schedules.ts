import { Hono, type Context } from "hono";

import type { AppEnv } from "../app-env.js";
import { parseStrictJson } from "../schedules/canonical.js";
import { ScheduleError, type ScheduleService } from "../schedules/service.js";

/** Schedule requests are small: a definition file is at most 32 KiB. */
const MAX_BODY_BYTES = 64 * 1024;

function errorResponse(c: Context, error: ScheduleError) {
  c.header("Cache-Control", "no-store");
  return c.json({ ok: false, error: { code: error.code, message: error.message.slice(0, 1024) } }, error.status as 400);
}

/** Strict body: JSON media type, bounded bytes, valid UTF-8, no NUL, no duplicate keys. */
async function readBody(c: Context): Promise<unknown> {
  const media = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (media !== "application/json") throw new ScheduleError("invalid_request", "Send application/json.");
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new ScheduleError("invalid_request", "Request body too large.");
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new ScheduleError("invalid_request", "Expected a JSON body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ScheduleError("invalid_request", "Request body too large.");
    }
    chunks.push(value);
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new ScheduleError("invalid_request", "Request body is not valid UTF-8."); }
  if (text.includes("\u0000")) throw new ScheduleError("invalid_request", "Request body contains NUL.");
  try { return parseStrictJson(text); }
  catch { throw new ScheduleError("invalid_request", "Request body is not strict JSON."); }
}

function query(c: Context): Record<string, string | undefined> {
  const url = new URL(c.req.url);
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(out, key)) throw new ScheduleError("invalid_request", "Repeated query parameter.");
    out[key] = value;
  }
  return out;
}

/**
 * Authenticated schedule routes. Mount after the auth guard: every handler
 * revalidates the resolved principal itself, so a revoked credential cannot
 * race a request.
 */
export function createScheduleRoutes(service: ScheduleService) {
  const app = new Hono<AppEnv>();
  const run = (handler: (c: Context<AppEnv>) => Promise<Response>) => async (c: Context<AppEnv>) => {
    if (!c.get("principal")) return errorResponse(c, new ScheduleError("unauthorized", "Authentication required.", 401));
    try {
      await service.ready.catch(() => {});
      const response = await handler(c);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      if (error instanceof ScheduleError) return errorResponse(c, error);
      return errorResponse(c, new ScheduleError("server_unavailable", "Schedule storage is unavailable; retry with the same key."));
    }
  };
  app.post("/schedules/proposals", run(async (c) => {
    const result = await service.propose(c.get("principal")!, await readBody(c));
    return c.json({ ok: true, proposal: result.proposal }, result.status);
  }));
  app.post("/schedules/proposals/:id/approve", run(async (c) => {
    const result = await service.approve(c.get("principal")!, c.req.param("id") ?? "", await readBody(c));
    return c.json({ ok: true, approvalId: result.approvalId }, 200);
  }));
  app.get("/schedules/due", run(async (c) => c.json(await service.due(c.get("principal")!, query(c)), 200)));
  app.post("/schedules/:id/cancel", run(async (c) => {
    return c.json(await service.cancel(c.get("principal")!, c.req.param("id") ?? "", await readBody(c)), 200);
  }));
  app.get("/schedules", run(async (c) => c.json(await service.list(c.get("principal")!, query(c)), 200)));
  app.post("/schedules", run(async (c) => {
    const result = await service.publish(c.get("principal")!, await readBody(c));
    return c.json({ ok: true, created: result.created, task: result.task }, result.status);
  }));
  return app;
}
