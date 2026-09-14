import type { Logger } from "@opentelemetry/api-logs";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { generateSignedCookie } from "hono/cookie";

import type { AppEnv } from "../app-env.js";
import {
  createPrincipal,
  listLivePrincipals,
  PrincipalCreatorNotUsableError,
  PrincipalLimitError,
  revokePrincipal,
} from "../db/principals.js";
import { readJsonBody } from "./body-limit.js";
import {
  applyPrincipalRevocation,
  SESSION_TTL_SECONDS,
  type AuthMode,
  type AuthRuntime,
} from "./auth.js";
import { requireJson } from "./origin.js";
import type { WsHost } from "../ws/host.js";

const COOKIE_NAME = "brain_ui_session";
const SECONDS_PER_DAY = 24 * 60 * 60;
const DEFAULT_AGENT_TTL_DAYS = 7;
const MAX_AGENT_TTL_DAYS = SESSION_TTL_SECONDS / SECONDS_PER_DAY;
const MAX_LABEL_LENGTH = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

export interface PrincipalManagementContext {
  db: Database;
  clients: Pick<WsHost, "revokePrincipals">;
  log?: Logger;
}

function notEnabled(c: Context) {
  return c.json({ error: "Principal management is not enabled" }, 400);
}

function sanitizeLabel(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(CONTROL_CHARACTERS, "")
        .trim()
        .slice(0, MAX_LABEL_LENGTH)
        .trim()
    : "";
}

function cookieValue(serialized: string): string {
  const valueStart = serialized.indexOf("=") + 1;
  const valueEnd = serialized.indexOf(";", valueStart);
  return decodeURIComponent(
    serialized.slice(valueStart, valueEnd === -1 ? undefined : valueEnd)
  );
}

/**
 * Owner-only delegated-principal routes. Mount AFTER the auth guard: the
 * family middleware below authorizes the resolved principal, it does not
 * authenticate the request itself.
 */
export function principalManagementRoutes(
  mode: AuthMode,
  auth: AuthRuntime,
  ctx: PrincipalManagementContext
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("/auth/principals/*", async (c, next) => {
    if (mode !== "password") return notEnabled(c);
    if (c.get("principal")?.kind !== "owner") {
      return c.json({ error: "Owner access required" }, 403);
    }
    await next();
  });

  app.get("/auth/principals", (c) => {
    const caller = c.get("principal")!;
    const principals = listLivePrincipals(ctx.db, Date.now()).map((principal) => ({
      id: principal.id,
      kind: principal.kind,
      auth_method: principal.authMethod,
      label: principal.label,
      created_at: principal.createdAt,
      expires_at: principal.expiresAt,
      last_seen_at: principal.lastSeenAt,
      is_own: principal.id === caller.id,
    }));
    return c.json({ principals });
  });

  app.post("/auth/principals", requireJson(), async (c) => {
    let body: { label?: unknown; ttlDays?: unknown };
    try {
      const result = await readJsonBody<{ label?: unknown; ttlDays?: unknown }>(c);
      if (result instanceof Response) return result;
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        return c.json({ error: "Invalid request body" }, 400);
      }
      body = result;
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const label = sanitizeLabel(body.label);
    if (!label) return c.json({ error: "label must be a non-empty string" }, 400);

    const ttlDays =
      body.ttlDays === undefined ? DEFAULT_AGENT_TTL_DAYS : body.ttlDays;
    if (
      typeof ttlDays !== "number" ||
      !Number.isInteger(ttlDays) ||
      ttlDays < 1 ||
      ttlDays > MAX_AGENT_TTL_DAYS
    ) {
      return c.json(
        { error: `ttlDays must be an integer between 1 and ${MAX_AGENT_TTL_DAYS}` },
        400
      );
    }

    const caller = c.get("principal")!;
    let principal;
    try {
      principal = createPrincipal(ctx.db, {
        authMethod: "delegated",
        label,
        createdBy: caller.id,
        ttlSeconds: ttlDays * SECONDS_PER_DAY,
      });
    } catch (error) {
      if (error instanceof PrincipalCreatorNotUsableError) {
        return c.json({ error: "Owner access required" }, 403);
      }
      if (!(error instanceof PrincipalLimitError)) throw error;
      return c.json(
        { error: "Principal capacity reached. Revoke another principal and try again." },
        503
      );
    }

    const serialized = await generateSignedCookie(
      COOKIE_NAME,
      principal.id,
      auth.cookieSecret ?? ""
    );
    const cookie = cookieValue(serialized);

    ctx.log?.emit({
      severityText: "INFO",
      body: "delegated principal minted",
      attributes: {
        "auth.principal.id": caller.id,
        "auth.target_principal.id": principal.id,
      },
    });
    c.header("Cache-Control", "no-store");
    return c.json({
      id: principal.id,
      label: principal.label,
      expiresAt: principal.expiresAt,
      cookie,
    });
  });

  app.delete("/auth/principals/:id", (c) => {
    const caller = c.get("principal")!;
    const targetId = c.req.param("id");
    const revokedIds = revokePrincipal(ctx.db, targetId, Date.now());
    if (revokedIds.length === 0) {
      return c.json({ error: "Unknown principal" }, 404);
    }

    applyPrincipalRevocation(ctx.clients, revokedIds);
    ctx.log?.emit({
      severityText: "INFO",
      body: "principal revoked",
      attributes: {
        "auth.principal.id": caller.id,
        "auth.target_principal.id": targetId,
      },
    });
    return c.json({ ok: true });
  });

  return app;
}
