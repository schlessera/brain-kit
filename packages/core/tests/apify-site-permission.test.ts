/**
 * The robots.txt checker for robots-authorized Apify runs (#3330) applies the
 * scrape package's rules: its robots cache, its identifying User-Agent for
 * both the fetch and the match, and its `"public-only"` address policy.
 *
 * Offline: the robots.txt is served by a loopback server; the address-policy
 * seam is opened only where a test has to reach it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_USER_AGENT } from "@schlessera/brain-scrape/internal";
import { APIFY_ROBOTS_ADDRESS_POLICY, APIFY_ROBOTS_USER_AGENT, createApifySitePermission } from "../src/lib/apify/site-permission.js";

let server: ReturnType<typeof Bun.serve>;
let hits: Array<{ path: string; ua: string | null }>;
let origin: string;

beforeEach(() => {
  hits = [];
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    hits.push({ path: url.pathname, ua: request.headers.get("user-agent") });
    if (url.pathname === "/robots.txt")
      return new Response("User-agent: polyphemus-bot\nDisallow: /\n\nUser-agent: *\nDisallow: /suitors\n");
    return new Response("not here", { status: 404 });
  } });
  origin = `http://127.0.0.1:${server.port}`;
});
afterEach(() => { void server.stop(true); });

describe("Apify site permission", () => {
  test("uses the scrape package's User-Agent and public-only address policy", () => {
    expect(APIFY_ROBOTS_USER_AGENT, "APIFY_ROBOTS_SCRAPE_USER_AGENT").toBe(DEFAULT_USER_AGENT);
    expect(APIFY_ROBOTS_ADDRESS_POLICY, "APIFY_ROBOTS_PUBLIC_ONLY").toBe("public-only");
  });

  test("answers from the site's robots.txt, fetched once per origin", async () => {
    const allowed = createApifySitePermission({ addressPolicy: "any" });
    expect(await allowed(`${origin}/charts/ithaca`), "APIFY_ROBOTS_ALLOWED").toBe(true);
    expect(await allowed(`${origin}/suitors/list`), "APIFY_ROBOTS_DISALLOWED").toBe(false);
    // Another agent's group does not bind this one.
    expect(await allowed(`${origin}/palace/loom`), "APIFY_ROBOTS_OTHER_AGENT_GROUP").toBe(true);
    expect(hits, "APIFY_ROBOTS_ONE_FETCH_WITH_SCRAPE_AGENT").toEqual([{ path: "/robots.txt", ua: DEFAULT_USER_AGENT }]);
  });

  test("by default never fetches robots.txt from a non-public address", async () => {
    const check = createApifySitePermission();
    await check(`${origin}/suitors/list`);
    expect(hits, "APIFY_ROBOTS_DEFAULT_REFUSES_LOOPBACK").toEqual([]);
  });

  test("an aborted turn rejects instead of answering", async () => {
    const check = createApifySitePermission({ addressPolicy: "any" });
    const controller = new AbortController();
    controller.abort(new Error("turn cancelled"));
    await expect(check(`${origin}/charts/ithaca`, controller.signal), "APIFY_ROBOTS_ABORT_REJECTS").rejects.toThrow("turn cancelled");
  });
});
