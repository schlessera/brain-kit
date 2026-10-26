import type { Logger } from "@opentelemetry/api-logs";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { generateSignedCookie } from "hono/cookie";

import type { AppEnv } from "../app-env.js";
import {
  isCookieBearingPrincipal,
  isUsablePrincipal,
  listLivePrincipals,
  PrincipalCreatorNotUsableError,
  PrincipalLimitError,
  resolvePrincipal,
} from "../db/principals.js";
import {
  listReferenceGrants,
  ReferenceGrantDuplicateError,
  ReferenceGrantLimitError,
  ReferenceGrantPrincipalError,
  ReferenceRepositoryError,
  type ReferenceGrant,
} from "../db/reference-grants.js";
import { accountWrites } from "../db/account-writes.js";
import { readJsonBody } from "./body-limit.js";
import {
  applyPrincipalRevocation,
  SESSION_TTL_SECONDS,
  type AuthMode,
  type AuthRuntime,
} from "./auth.js";
import { requireJson } from "./origin.js";
import type { WsHost } from "../ws/host.js";
import { requireOwner } from "./require-owner.js";

const COOKIE_NAME = "brain_ui_session";
const SECONDS_PER_DAY = 24 * 60 * 60;
const DEFAULT_AGENT_TTL_DAYS = 7;
const MAX_AGENT_TTL_DAYS = SESSION_TTL_SECONDS / SECONDS_PER_DAY;
const MAX_LABEL_LENGTH = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

export interface PrincipalManagementContext {
  db: Database;
  revoker: Pick<WsHost, "revokePrincipals">;
  log?: Logger;
  /** Served brain identity that reference grants bind to (#2429). */
  brain: string;
  /** Told synchronously after a grant or principal loses authority, so in-flight private work stops. */
  referenceAuthorityRevoked?: (input: { grantIds: string[]; principalIds: string[] }) => void;
}

function grantJson(grant: ReferenceGrant) {
  return {
    id: grant.id,
    principal_id: grant.principalId,
    repository_prefix: grant.repositoryPrefix,
    credential: grant.credential,
    created_by: grant.createdBy,
    created_at: grant.createdAt,
  };
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
    await next();
  });
  app.use("/auth/principals/*", requireOwner());

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
      principal = await accountWrites(ctx.db).createPrincipal({
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

  app.delete("/auth/principals/:id", async (c) => {
    const caller = c.get("principal")!;
    const targetId = c.req.param("id");
    const revokedIds = await accountWrites(ctx.db).revokePrincipal(targetId, Date.now());
    if (revokedIds.length === 0) {
      return c.json({ error: "Unknown principal" }, 404);
    }

    await applyPrincipalRevocation(ctx.revoker, revokedIds);
    ctx.referenceAuthorityRevoked?.({ grantIds: [], principalIds: revokedIds });
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

  // Reference-source grants (#2429): the only authority for private
  // reference acquisition. Owner-only through the family guard above.
  app.get("/auth/principals/:id/reference-grants", (c) => {
    const principalId = c.req.param("id");
    const now = Date.now();
    if (!isGrantablePrincipal(ctx.db, principalId, now)) {
      return c.json({ error: "Unknown principal" }, 404);
    }
    return c.json({
      grants: listReferenceGrants(ctx.db, ctx.brain, principalId, now).map(grantJson),
    });
  });

  app.post("/auth/principals/:id/reference-grants", requireJson(), async (c) => {
    let body: { repositoryPrefix?: unknown; credential?: unknown };
    try {
      const result = await readJsonBody<{ repositoryPrefix?: unknown; credential?: unknown }>(c);
      if (result instanceof Response) return result;
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        return c.json({ error: "Invalid request body" }, 400);
      }
      body = result;
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }
    const caller = c.get("principal")!;
    const principalId = c.req.param("id");
    let grant: ReferenceGrant;
    try {
      grant = await accountWrites(ctx.db).createGrant({
        brain: ctx.brain,
        principalId,
        repositoryPrefix: body.repositoryPrefix,
        credential: body.credential === undefined ? null : body.credential,
        createdBy: caller.id,
        now: Date.now(),
      });
    } catch (error) {
      if (error instanceof ReferenceRepositoryError) return c.json({ error: error.message }, 400);
      if (error instanceof ReferenceGrantPrincipalError) return c.json({ error: "Unknown principal" }, 404);
      if (error instanceof ReferenceGrantDuplicateError) return c.json({ error: "An identical live grant exists" }, 409);
      if (error instanceof ReferenceGrantLimitError) {
        return c.json({ error: "Reference grant capacity reached. Revoke another grant and try again." }, 503);
      }
      throw error;
    }
    ctx.log?.emit({
      severityText: "INFO",
      body: "reference grant created",
      attributes: {
        "auth.principal.id": caller.id,
        "auth.target_principal.id": principalId,
        "reference.grant.id": grant.id,
      },
    });
    return c.json(grantJson(grant), 201);
  });

  app.delete("/auth/principals/:id/reference-grants/:grantId", async (c) => {
    const caller = c.get("principal")!;
    const principalId = c.req.param("id");
    const revoked = await accountWrites(ctx.db).revokeGrant({
      brain: ctx.brain,
      principalId,
      id: c.req.param("grantId"),
      now: Date.now(),
    });
    if (!revoked) return c.json({ error: "Unknown reference grant" }, 404);
    ctx.referenceAuthorityRevoked?.({ grantIds: [revoked.id], principalIds: [] });
    ctx.log?.emit({
      severityText: "INFO",
      body: "reference grant revoked",
      attributes: {
        "auth.principal.id": caller.id,
        "auth.target_principal.id": principalId,
        "reference.grant.id": revoked.id,
      },
    });
    return c.json({ ok: true });
  });

  return app;
}

function isGrantablePrincipal(db: Database, id: string, now: number): boolean {
  const principal = resolvePrincipal(db, id);
  return Boolean(principal && isCookieBearingPrincipal(principal) && isUsablePrincipal(principal, now));
}
