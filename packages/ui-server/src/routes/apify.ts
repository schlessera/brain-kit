/**
 * Apify settings for the Settings UI (#3159, #3163). Internal transport: human
 * owners read the truthful state, confirm a changed account and propose policy
 * changes; delegated agent principals get none of it. No route accepts, stores
 * or returns a token — the host reads `APIFY_TOKEN` from its own environment.
 *
 * No route writes policy either. `POST /apify/policy` turns one control into a
 * complete proposed `governance.md` for the existing policy-change review, and
 * `POST /apify/policy/:turnId/:requestId` is the proposing owner's one answer
 * to that exact review; only an approval lets the existing writer publish it.
 * A lost answer is reconciled through `GET /policy-proposals/:turnId/:requestId`,
 * which only reads.
 */
import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import { readJsonBody } from "../middleware/body-limit.js";
import { requireJson } from "../middleware/origin.js";
import { ApifyAuthorityError, type ApifyAuthority } from "@schlessera/brain-common/internal/apify";
import {
  apifySettingsRead, ApifySettingsError, parseApifyPolicyChange, readApifyPolicy, readApifySpend,
  type ApifyPolicyEdits, type ApifySpendSource,
} from "../apify/settings.js";

export interface ApifyRoutesDeps {
  authority: ApifyAuthority;
  /** The live human-owner check every owner route applies to the resolved principal. */
  authorized(principalId: string): boolean;
  /** The brain whose governance policy holds the `apify` block (#3163). */
  brainPath?: string;
  /** This brain's ledger, for Today and unresolved runs (#3163). */
  spend?: ApifySpendSource;
  /** Settle and clean up open runs now: the owner's "Check again". */
  reconcile?: () => Promise<void>;
  /** Policy edits through the existing review (#3163). */
  edits?: ApifyPolicyEdits;
  /** @internal Test seam for grant expiry. */
  now?: () => number;
}

const SESSION = /^[A-Za-z0-9:_.-]{1,200}$/u;
const HASH = /^[0-9a-f]{64}$/u;

export function createApifyRoutes(deps: ApifyRoutesDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use("/apify*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "Authentication required." }, 401);
    if (!["owner", "ambient"].includes(principal.kind) || !deps.authorized(principal.id))
      return c.json({ error: "Apify settings require human-owner access." }, 403);
    await next();
  });
  routes.onError((error, c) => error instanceof ApifyAuthorityError
    ? c.json({ error: error.message, code: error.code, reason: error.reason }, 409)
    : error instanceof ApifySettingsError ? c.json({ error: error.message, code: error.code }, error.status)
    : c.json({ error: "Apify state is temporarily unavailable." }, 503));

  routes.get("/apify", async c => {
    const refresh = c.req.query("refresh") === "1";
    const status = await deps.authority.status({ refresh, signal: c.req.raw.signal });
    // Without a brain, the original #3159 shape.
    if (!deps.brainPath) return c.json(status);
    const session = c.req.query("session"), turn = c.req.query("turn");
    if ((session === undefined) !== (turn === undefined) || (session !== undefined && (!SESSION.test(session) || !SESSION.test(turn!))))
      return c.json({ error: "Name both session and turn, or neither." }, 400);
    if (refresh && deps.reconcile) await deps.reconcile();
    const policy = readApifyPolicy(deps.brainPath, status, (deps.now ?? Date.now)());
    const account = status.pending_account?.id ?? status.account?.id ?? null;
    const spend = deps.spend ? readApifySpend(deps.spend, account, session !== undefined ? { session_id: session, turn_id: turn! } : undefined)
      : { ledger: "absent" as const, observed_at: new Date().toISOString(), coverage: null, day: null, brain_day: null, unresolved: [] };
    return c.json(apifySettingsRead(status, policy, spend));
  });
  routes.post("/apify/account", requireJson(), async c => {
    const result = await readJsonBody(c).catch(() => null);
    if (result instanceof Response) return result;
    const body = result as { account_id?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "account_id")
      || typeof body.account_id !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(body.account_id))
      return c.json({ error: "Expected { account_id } naming the account to confirm." }, 400);
    return c.json(await deps.authority.confirmAccount(body.account_id, { signal: c.req.raw.signal }));
  });
  routes.post("/apify/policy", requireJson(), async c => {
    if (!deps.edits) return c.json({ error: "Policy changes are not available on this server." }, 404);
    const result = await readJsonBody(c).catch(() => null);
    if (result instanceof Response) return result;
    const body = result as { change?: unknown; base_hash?: unknown } | null;
    const change = body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every(key => key === "change" || key === "base_hash")
      ? parseApifyPolicyChange(body.change) : null;
    if (!change || !body || (body.base_hash !== null && (typeof body.base_hash !== "string" || !HASH.test(body.base_hash))))
      return c.json({ error: "Expected { change, base_hash } naming one Apify setting and the policy version it changes." }, 400);
    return c.json(await deps.edits.propose(c.get("principal")!.id, change, body.base_hash as string | null));
  });
  routes.post("/apify/policy/:turnId/:requestId", requireJson(), async c => {
    if (!deps.edits) return c.json({ error: "Policy changes are not available on this server." }, 404);
    const { turnId, requestId } = c.req.param();
    if (turnId.length > 200 || requestId.length > 200) return c.json({ error: "Invalid request identity." }, 400);
    const result = await readJsonBody(c).catch(() => null);
    if (result instanceof Response) return result;
    const body = result as { approve?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "approve") || typeof body.approve !== "boolean")
      return c.json({ error: "Expected { approve } answering this review." }, 400);
    return c.json(await deps.edits.decide(c.get("principal")!.id, turnId, requestId, body.approve));
  });
  return routes;
}
