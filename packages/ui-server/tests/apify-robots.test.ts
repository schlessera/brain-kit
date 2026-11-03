/**
 * Robots-authorized Apify profiles (#3330): the hosted server and a standalone
 * `brain apify` / `brain mcp` process check every target against its site's
 * robots.txt through core's scrape-backed checker before the start request.
 * A disallowed target refuses with nothing started; a host that cannot load
 * the checker refuses every such run.
 *
 * Keyless and offline: the loopback fake serves Apify, a loopback server
 * serves the Odysseus site's robots.txt, and the fictional target origin is
 * routed to it after the network preload. The checker's address-policy seam
 * is opened so its fetch may reach loopback; its default is public-only
 * (packages/core/tests/apify-site-permission.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApifyEnvelope } from "@schlessera/brain-common/internal/apify-operations";
import { APIFY_TOOL_NAMES } from "@schlessera/brain-common/internal/apify-operations";
import { qualifyProfile } from "@schlessera/brain-common/internal/apify";
import { apifyRobotsUserAgent, createApifySitePermission, createStandaloneApify, type StandaloneApify } from "@schlessera/brain/internal/apify";
import type { ApifyHost, ApifyHostTurn } from "../src/apify/host.js";
import { coreSitePermission } from "../src/apify/site-permission.js";
import { APIFY_LIMITS, APIFY_SENTINEL, apifyGrant, apifyPolicy, fakeApify, fixtureApifyHost, type FakeApify } from "./fixtures/apify-host-fixture.js";
import { seaChartsProfile } from "./fixtures/apify-odysseus.js";

const ROBOTS_PROFILE = qualifyProfile(seaChartsProfile({ id: "odysseus-sea-charts-robots@1",
  site: { expansion: "none", redirects: "same_origin", authorization: "robots", permitted_origins: [] } }));
const SITE = "https://ithaca.example";
const ALLOWED = { startUrls: [{ url: `${SITE}/charts` }], maxPages: 3 };
const DISALLOWED = { startUrls: [{ url: `${SITE}/charts` }, { url: `${SITE}/suitors/roster` }], maxPages: 3 };

let root: string, brain: string, ledgerPath: string, fake: FakeApify;
let robots: ReturnType<typeof Bun.serve>;
/** Every robots.txt request, with the paid starts already sent when it arrived. */
let robotsHits: Array<{ path: string; ua: string | null; startsBefore: number }>;
let restoreFetch: () => void;
let closers: Array<() => void>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "odysseus-apify-robots-"));
  brain = join(root, "ithaca");
  mkdirSync(brain, { recursive: true });
  mkdirSync(join(root, "private"), { mode: 0o700 });
  ledgerPath = join(root, "private", "apify-ledger.sqlite");
  fake = fakeApify();
  robotsHits = []; closers = [];
  robots = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    robotsHits.push({ path: url.pathname, ua: request.headers.get("user-agent"), startsBefore: fake.starts() });
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /suitors/\n");
    return new Response("not here", { status: 404 });
  } });
  // Route the fictional site to the loopback robots server, after the network preload; restore the exact descriptor.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
  const original = globalThis.fetch;
  const routed = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === SITE) return original(new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${robots.port}`), init);
    return original(input, init);
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { ...descriptor, value: routed });
  restoreFetch = () => { Object.defineProperty(globalThis, "fetch", descriptor); };
  apifyPolicy(brain, { enabled: true, discovery: "allow", actors: "allow", actor_grants: [apifyGrant({ profile_id: ROBOTS_PROFILE.id })], limits: APIFY_LIMITS });
});
afterEach(() => {
  restoreFetch();
  for (const close of closers) close();
  fake.stop();
  void robots.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const data = <T>(envelope: ApifyEnvelope): T => {
  if (!envelope.ok) throw new Error(`expected ok, got ${JSON.stringify(envelope.error)}`);
  return envelope.data as T;
};

/** discover → inspect → prepare → run through one front door. */
async function runThrough(call: (operation: keyof typeof APIFY_TOOL_NAMES, input: unknown) => Promise<ApifyEnvelope>, input: unknown): Promise<ApifyEnvelope> {
  const candidate = data<{ candidates: Array<{ candidate: string }> }>(await call("discover", { query: "sea charts" })).candidates[0]!.candidate;
  data(await call("inspect", { candidate }));
  const prepared = data<{ proposal: string; admission: string }>(await call("prepare", { candidate, input, max_charge_usd: 2 }));
  expect(prepared.admission, "APIFY_ROBOTS_GRANT_ADMITS").toBe("grant");
  return call("run", { proposal: prepared.proposal });
}

function hosted(sitePermission = coreSitePermission({ addressPolicy: "any" })): (operation: keyof typeof APIFY_TOOL_NAMES, input: unknown) => Promise<ApifyEnvelope> {
  const host: ApifyHost = fixtureApifyHost(brain, fake, ledgerPath, { profiles: [ROBOTS_PROFILE], sitePermission });
  closers.push(() => host.close());
  const turn: ApifyHostTurn = { turnId: "t-robots-1", principalId: "p-penelope", sessionId: () => "s-robots", posture: "interactive",
    signal: new AbortController().signal, approvals: { requestPermission: async () => ({ behavior: "allow" }) } };
  return (operation, input) => host.call(turn, { tool: APIFY_TOOL_NAMES[operation], input });
}

function standalone(): (operation: keyof typeof APIFY_TOOL_NAMES, input: unknown) => Promise<ApifyEnvelope> {
  const service: StandaloneApify = createStandaloneApify({ root: brain, env: { APIFY_TOKEN: APIFY_SENTINEL, BRAIN_APIFY_LEDGER: ledgerPath },
    origin: fake.origin, mcpOrigin: fake.origin, profiles: [ROBOTS_PROFILE], waitSeconds: 1, pollMs: 1,
    sitePermission: createApifySitePermission({ addressPolicy: "any" }) });
  closers.push(() => service.close());
  return (operation, input) => service.call(operation, input);
}

describe("robots-authorized Apify runs", () => {
  for (const [door, open] of [["hosted", () => hosted()], ["standalone", standalone]] as const) {
    test(`${door}: a disallowed target refuses with nothing started`, async () => {
      const refused = await runThrough(open(), DISALLOWED);
      expect(refused, `APIFY_ROBOTS_${door.toUpperCase()}_DISALLOWED`).toMatchObject({ ok: false, error: { code: "policy_denied", reason: "robots_disallowed" } });
      expect(fake.starts(), `APIFY_ROBOTS_${door.toUpperCase()}_NO_START`).toBe(0);
      // Checked through the scrape package's cache: one robots.txt fetch for the origin, as the scrape client.
      expect(robotsHits, `APIFY_ROBOTS_${door.toUpperCase()}_CHECKED_THROUGH_SCRAPE`).toEqual([{ path: "/robots.txt", ua: await apifyRobotsUserAgent(), startsBefore: 0 }]);
    });

    test(`${door}: allowed targets are checked before the start request, which is sent once`, async () => {
      const started = await runThrough(open(), ALLOWED);
      expect(data<{ state: string }>(started).state).toBe("succeeded");
      expect(fake.starts(), `APIFY_ROBOTS_${door.toUpperCase()}_ONE_START`).toBe(1);
      expect(robotsHits, `APIFY_ROBOTS_${door.toUpperCase()}_CHECKED_BEFORE_START`).toEqual([{ path: "/robots.txt", ua: await apifyRobotsUserAgent(), startsBefore: 0 }]);
    });
  }

  test("hosted without core: the checker cannot load, so every robots-authorized run refuses", async () => {
    const call = hosted(coreSitePermission({ load: () => Promise.reject(new Error("Cannot find package '@schlessera/brain'")) }));
    for (const input of [ALLOWED, DISALLOWED]) {
      expect(await runThrough(call, input), "APIFY_ROBOTS_NO_CORE_FAILS_CLOSED")
        .toMatchObject({ ok: false, error: { code: "policy_denied", reason: "site_permission_unproven" } });
    }
    expect(fake.starts(), "APIFY_ROBOTS_NO_CORE_NO_START").toBe(0);
    expect(robotsHits).toEqual([]);
  });
});
