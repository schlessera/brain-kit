import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { generateSignedCookie, getSignedCookie } from "hono/cookie";

import type { AppEnv } from "../src/app-env";
import { resolveServerConfig } from "../src/config/env";
import { createUiDb } from "../src/db/client";
import {
  createPrincipal,
  MAX_LIVE_PRINCIPALS,
  resolvePrincipal,
  revokePrincipal,
  type Principal,
} from "../src/db/principals";
import {
  authGuard,
  SESSION_TTL_SECONDS,
  type AuthMode,
  type AuthRuntime,
} from "../src/middleware/auth";
import { principalManagementRoutes } from "../src/middleware/principals";
import {
  createRecordingObservability,
  type RecordingObservability,
} from "../src/observability/index";

const SECRET = "test-cookie-secret-0123456789abcdef";
const COOKIE_NAME = "brain_ui_session";
const SECONDS_PER_DAY = 24 * 60 * 60;

const db = createUiDb(":memory:");
const config = resolveServerConfig({
  AUTH_MODE: "password",
  BRAIN_UI_PASSWORD_HASH: "unused-test-hash",
  COOKIE_SECRET: SECRET,
});
const auth: AuthRuntime = { ...config.auth, host: config.host };

let observability: RecordingObservability;
let revocations: Array<{
  ids: readonly string[];
  code: number;
  reason: string;
}>;

beforeEach(() => {
  db.exec("DELETE FROM principals; DELETE FROM settings;");
  observability = createRecordingObservability();
  revocations = [];
});

function owner(label = "Owner browser"): Principal {
  return createPrincipal(db, {
    authMethod: "password",
    label,
    ttlSeconds: SESSION_TTL_SECONDS,
  });
}

function agent(createdBy: string, label = "Existing agent"): Principal {
  return createPrincipal(db, {
    authMethod: "delegated",
    label,
    createdBy,
    ttlSeconds: 7 * SECONDS_PER_DAY,
  });
}

async function signedValue(id: string): Promise<string> {
  const serialized = await generateSignedCookie(COOKIE_NAME, id, SECRET);
  const valueStart = serialized.indexOf("=") + 1;
  const valueEnd = serialized.indexOf(";", valueStart);
  return decodeURIComponent(serialized.slice(valueStart, valueEnd));
}

function cookieHeader(value: string): string {
  return `${COOKIE_NAME}=${value}`;
}

function app(mode: AuthMode = "password") {
  const instance = new Hono<AppEnv>();
  if (mode === "password") {
    instance.use("/api/*", authGuard(mode, auth, db));
  }
  instance.route(
    "/api",
    principalManagementRoutes(mode, auth, {
      db,
      revoker: {
        revokePrincipals(ids, code, reason) {
          revocations.push({ ids: [...ids], code, reason });
        },
      },
      log: observability.logger("auth"),
    })
  );
  instance.get("/api/who", (c) =>
    c.json({ id: c.get("principal")?.id ?? null })
  );
  return instance;
}

function jsonRequest(
  method: "POST" | "DELETE",
  cookie: string,
  body?: unknown
): RequestInit {
  return {
    method,
    headers: {
      cookie: cookieHeader(cookie),
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe("owner-only principal routes", () => {
  test("mint returns a one-time Hono cookie without replacing the owner's session", async () => {
    const actingOwner = owner();
    const ownerCookie = await signedValue(actingOwner.id);
    const instance = app();

    const response = await instance.request(
      "/api/auth/principals",
      jsonRequest("POST", ownerCookie, { label: "  Build agent  " })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const minted = (await response.json()) as {
      id: string;
      label: string;
      expiresAt: number;
      cookie: string;
    };
    expect(minted.label).toBe("Build agent");
    expect(minted.cookie).toEndWith("=");
    expect(minted.cookie).not.toContain("%3D");

    const stored = resolvePrincipal(db, minted.id)!;
    expect(stored.kind).toBe("agent");
    expect(stored.authMethod).toBe("delegated");
    expect(stored.createdBy).toBe(actingOwner.id);
    expect(stored.expiresAt).toBe(minted.expiresAt);

    const verifier = new Hono();
    verifier.get("/", async (c) =>
      c.json({ value: await getSignedCookie(c, SECRET, COOKIE_NAME) })
    );
    const roundTrip = await verifier.request("/", {
      headers: { cookie: cookieHeader(minted.cookie) },
    });
    expect((await roundTrip.json()).value).toBe(minted.id);

    const agentRequest = await instance.request("/api/who", {
      headers: { cookie: cookieHeader(minted.cookie) },
    });
    expect(agentRequest.status).toBe(200);
    expect(await agentRequest.json()).toEqual({ id: minted.id });
    const ownerRequest = await instance.request("/api/who", {
      headers: { cookie: cookieHeader(ownerCookie) },
    });
    expect(ownerRequest.status).toBe(200);
    expect(await ownerRequest.json()).toEqual({ id: actingOwner.id });

    const audit = observability.logs.find({
      scope: "auth",
      severity: "INFO",
      body: "delegated principal minted",
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.attributes).toEqual({
      "auth.principal.id": actingOwner.id,
      "auth.target_principal.id": minted.id,
    });
    expect(JSON.stringify(audit)).not.toContain(minted.cookie);
  });

  test("an agent gets 403 on every route while an owner gets 200", async () => {
    const actingOwner = owner();
    const delegated = agent(actingOwner.id);
    const ownerCookie = await signedValue(actingOwner.id);
    const agentCookie = await signedValue(delegated.id);
    const instance = app();

    const agentResponses = [
      await instance.request("/api/auth/principals", {
        headers: { cookie: cookieHeader(agentCookie) },
      }),
      await instance.request(
        "/api/auth/principals",
        jsonRequest("POST", agentCookie, { label: "Replacement" })
      ),
      await instance.request(
        `/api/auth/principals/${delegated.id}`,
        jsonRequest("DELETE", agentCookie)
      ),
    ];
    expect(agentResponses.map(({ status }) => status)).toEqual([403, 403, 403]);

    const ownerList = await instance.request("/api/auth/principals", {
      headers: { cookie: cookieHeader(ownerCookie) },
    });
    const ownerMint = await instance.request(
      "/api/auth/principals",
      jsonRequest("POST", ownerCookie, { label: "Second agent" })
    );
    const ownerDelete = await instance.request(
      `/api/auth/principals/${delegated.id}`,
      jsonRequest("DELETE", ownerCookie)
    );
    expect([ownerList.status, ownerMint.status, ownerDelete.status]).toEqual([
      200, 200, 200,
    ]);
  });

  test("ttlDays validates its bounds and persists the default and maximum", async () => {
    const actingOwner = owner();
    const ownerCookie = await signedValue(actingOwner.id);
    const instance = app();

    for (const ttlDays of [
      0,
      SESSION_TTL_SECONDS / SECONDS_PER_DAY + 1,
      "7",
      null,
    ]) {
      const response = await instance.request(
        "/api/auth/principals",
        jsonRequest("POST", ownerCookie, { label: "Rejected", ttlDays })
      );
      expect(response.status).toBe(400);
    }
    expect(
      db.query("SELECT COUNT(*) AS count FROM principals").get()
    ).toEqual({ count: 1 });

    const byDefault = await instance.request(
      "/api/auth/principals",
      jsonRequest("POST", ownerCookie, { label: "Default TTL" })
    );
    const defaultBody = (await byDefault.json()) as { id: string; expiresAt: number };
    const defaultStored = resolvePrincipal(db, defaultBody.id)!;
    expect(defaultStored.expiresAt - defaultStored.createdAt).toBe(
      7 * SECONDS_PER_DAY * 1_000
    );
    expect(defaultStored.expiresAt).toBe(defaultBody.expiresAt);

    const maxDays = SESSION_TTL_SECONDS / SECONDS_PER_DAY;
    const atMaximum = await instance.request(
      "/api/auth/principals",
      jsonRequest("POST", ownerCookie, { label: "Maximum TTL", ttlDays: maxDays })
    );
    const maximumBody = (await atMaximum.json()) as { id: string; expiresAt: number };
    const maximumStored = resolvePrincipal(db, maximumBody.id)!;
    expect(maximumStored.expiresAt - maximumStored.createdAt).toBe(
      maxDays * SECONDS_PER_DAY * 1_000
    );
    expect(maximumStored.expiresAt).toBe(maximumBody.expiresAt);
  });

  test("labels are trimmed, control-safe, and bounded", async () => {
    const actingOwner = owner();
    const ownerCookie = await signedValue(actingOwner.id);
    const response = await app().request(
      "/api/auth/principals",
      jsonRequest("POST", ownerCookie, {
        label: `\t  Agent\u0000 ${"x".repeat(80)}\n`,
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { label: string };
    expect(body.label).toBe(`Agent ${"x".repeat(58)}`);
    expect(body.label).toHaveLength(64);
  });

  test("revocation rejects the cookie on the next request and leaves the owner live", async () => {
    const actingOwner = owner();
    const ownerCookie = await signedValue(actingOwner.id);
    const instance = app();
    const mint = await instance.request(
      "/api/auth/principals",
      jsonRequest("POST", ownerCookie, { label: "Disposable agent" })
    );
    const minted = (await mint.json()) as { id: string; cookie: string };

    expect(
      (
        await instance.request("/api/who", {
          headers: { cookie: cookieHeader(minted.cookie) },
        })
      ).status
    ).toBe(200);
    const deleted = await instance.request(
      `/api/auth/principals/${minted.id}`,
      jsonRequest("DELETE", ownerCookie)
    );
    expect(deleted.status).toBe(200);
    expect(revocations).toEqual([
      { ids: [minted.id], code: 1008, reason: "Sessions invalidated" },
    ]);
    expect(
      (
        await instance.request("/api/who", {
          headers: { cookie: cookieHeader(minted.cookie) },
        })
      ).status
    ).toBe(401);
    expect(
      (
        await instance.request("/api/who", {
          headers: { cookie: cookieHeader(ownerCookie) },
        })
      ).status
    ).toBe(200);

    const audit = observability.logs.find({
      scope: "auth",
      severity: "INFO",
      body: "principal revoked",
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.attributes).toEqual({
      "auth.principal.id": actingOwner.id,
      "auth.target_principal.id": minted.id,
    });
    expect(JSON.stringify(audit)).not.toContain(minted.cookie);
  });

  test("self-revocation is a logout and missing or already-revoked ids are 404", async () => {
    const actingOwner = owner();
    const target = agent(actingOwner.id);
    const ownerCookie = await signedValue(actingOwner.id);
    const instance = app();

    expect(
      (
        await instance.request(
          `/api/auth/principals/${target.id}`,
          jsonRequest("DELETE", ownerCookie)
        )
      ).status
    ).toBe(200);
    expect(
      (
        await instance.request(
          `/api/auth/principals/${target.id}`,
          jsonRequest("DELETE", ownerCookie)
        )
      ).status
    ).toBe(404);
    expect(
      (
        await instance.request(
          "/api/auth/principals/AAAAAAAAAAAAAAAAAAAAAA",
          jsonRequest("DELETE", ownerCookie)
        )
      ).status
    ).toBe(404);

    expect(
      (
        await instance.request(
          `/api/auth/principals/${actingOwner.id}`,
          jsonRequest("DELETE", ownerCookie)
        )
      ).status
    ).toBe(200);
    expect(
      (
        await instance.request("/api/who", {
          headers: { cookie: cookieHeader(ownerCookie) },
        })
      ).status
    ).toBe(401);
  });

  test("ambient modes return the same not-enabled response on all three routes", async () => {
    for (const mode of ["tailscale", "proxy", "none"] as const) {
      const instance = app(mode);
      const responses = [
        await instance.request("/api/auth/principals"),
        await instance.request("/api/auth/principals", { method: "POST" }),
        await instance.request("/api/auth/principals/anything", {
          method: "DELETE",
        }),
      ];
      expect(responses.map(({ status }) => status)).toEqual([400, 400, 400]);
      for (const response of responses) {
        expect(await response.json()).toEqual({
          error: "Principal management is not enabled",
        });
      }
    }
  });

  test("list contains only live non-secret metadata and marks the caller", async () => {
    const actingOwner = owner();
    const liveAgent = agent(actingOwner.id, "Live agent");
    const revoked = agent(actingOwner.id, "Revoked agent");
    const expired = agent(actingOwner.id, "Expired agent");
    revokePrincipal(db, revoked.id, Date.now());
    db.prepare("UPDATE principals SET expires_at = ? WHERE id = ?").run(
      Date.now() - 1,
      expired.id
    );
    const ownerCookie = await signedValue(actingOwner.id);
    const agentCookie = await signedValue(liveAgent.id);

    const response = await app().request("/api/auth/principals", {
      headers: { cookie: cookieHeader(ownerCookie) },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      principals: Array<Record<string, unknown>>;
    };
    expect(new Set(body.principals.map(({ id }) => id))).toEqual(
      new Set([actingOwner.id, liveAgent.id])
    );
    expect(body.principals.find(({ id }) => id === actingOwner.id)?.is_own).toBe(
      true
    );
    expect(body.principals.find(({ id }) => id === liveAgent.id)?.is_own).toBe(
      false
    );
    for (const principal of body.principals) {
      expect(Object.keys(principal).sort()).toEqual(
        [
          "auth_method",
          "created_at",
          "expires_at",
          "id",
          "is_own",
          "kind",
          "label",
          "last_seen_at",
        ].sort()
      );
    }
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(ownerCookie);
    expect(serialized).not.toContain(agentCookie);
  });

  test("mint refuses the live-principal cap with 503 and no credential", async () => {
    const actingOwner = owner();
    for (let index = 1; index < MAX_LIVE_PRINCIPALS; index++) {
      agent(actingOwner.id, `Existing agent ${index}`);
    }
    const ownerCookie = await signedValue(actingOwner.id);

    const response = await app().request(
      "/api/auth/principals",
      jsonRequest("POST", ownerCookie, { label: "Over capacity" })
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      error: "Principal capacity reached. Revoke another principal and try again.",
    });
    expect(
      db.query("SELECT COUNT(*) AS count FROM principals").get()
    ).toEqual({ count: MAX_LIVE_PRINCIPALS });
  });

  test("mint requires JSON before reading its body", async () => {
    const actingOwner = owner();
    const ownerCookie = await signedValue(actingOwner.id);
    const response = await app().request("/api/auth/principals", {
      method: "POST",
      headers: { cookie: cookieHeader(ownerCookie) },
      body: JSON.stringify({ label: "Wrong media type" }),
    });
    expect(response.status).toBe(415);
  });

  test("an owner revoked while its mint body is paused cannot create a credential", async () => {
    const actingOwner = owner("Paused owner");
    const revokingOwner = owner("Revoking owner");
    const actingCookie = await signedValue(actingOwner.id);
    const revokingCookie = await signedValue(revokingOwner.id);
    const instance = app();
    const encoder = new TextEncoder();
    let markBodyRead!: () => void;
    let releaseBody!: () => void;
    const bodyRead = new Promise<void>((resolve) => {
      markBodyRead = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    let sentRemainder = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"label":"Paused'));
      },
      async pull(controller) {
        if (sentRemainder) return;
        sentRemainder = true;
        markBodyRead();
        await released;
        controller.enqueue(encoder.encode(' agent"}'));
        controller.close();
      },
    });
    const mintPromise = Promise.resolve(
      instance.request(
        new Request("http://localhost/api/auth/principals", {
          method: "POST",
          headers: {
            cookie: cookieHeader(actingCookie),
            "content-type": "application/json",
          },
          body,
          // @ts-expect-error -- streamed request bodies require duplex at runtime
          duplex: "half",
        })
      )
    );

    await bodyRead;
    const revoked = await instance.request(
      `/api/auth/principals/${actingOwner.id}`,
      jsonRequest("DELETE", revokingCookie)
    );
    expect(revoked.status).toBe(200);
    releaseBody();

    const mint = await mintPromise;
    expect(mint.status).toBe(403);
    expect(mint.headers.get("set-cookie")).toBeNull();
    expect(await mint.json()).toEqual({ error: "Owner access required" });
    expect(
      db.query("SELECT COUNT(*) AS count FROM principals WHERE kind = 'agent'").get()
    ).toEqual({ count: 0 });
  });
});
