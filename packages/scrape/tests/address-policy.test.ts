/**
 * `addressPolicy: "public-only"` and the bounded robots.txt fetch, against a
 * real loopback fixture. Host names resolve through an injected lookup, so
 * nothing here reaches DNS; a request the policy should have refused would
 * reach the fixture, and the fixture counts every request it sees.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { ScrapeClient } from "../src/fetch/http.js";
import { NonPublicAddressError, isPublicAddress, type ResolvedAddress } from "../src/politeness/address.js";
import { RobotsCache } from "../src/politeness/robots.js";

const realFetch = globalThis.fetch;

interface Seen {
  path: string;
  userAgent: string | null;
  host: string | null;
}

/** What the fixture answers; each test sets the routes it needs. */
let routes: Record<string, () => Response> = {};
const seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;
let origin: string;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({ path: url.pathname, userAgent: request.headers.get("user-agent"), host: request.headers.get("host") });
      return routes[url.pathname]?.() ?? new Response("not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
afterEach(() => {
  globalThis.fetch = realFetch;
  routes = {};
  seen.length = 0;
});

/** A lookup that answers from a table and records the names it was asked. */
function lookupFrom(table: Record<string, string>) {
  const asked: string[] = [];
  const lookup = async (hostname: string): Promise<ResolvedAddress[]> => {
    asked.push(hostname);
    const address = table[hostname];
    if (!address) throw new Error(`fixture lookup has no answer for ${hostname}`);
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
  return Object.assign(lookup, { asked });
}

interface Attempt {
  url: string;
  host: string | null;
  serverName: string | undefined;
}

/**
 * Record every fetch the client makes. A request pinned to the public test
 * address is answered by `publicReply`; anything else goes to the real
 * fetch, which only the loopback fixture can answer.
 */
function recordFetch(publicReply: (path: string) => Response): Attempt[] {
  const attempts: Attempt[] = [];
  globalThis.fetch = Object.assign(async (input: any, init?: any) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    attempts.push({ url: url.href, host: headers.get("host"), serverName: init?.tls?.serverName });
    if (url.hostname === PUBLIC_ADDRESS) return publicReply(url.pathname);
    return realFetch(input, init);
  }, realFetch) as typeof fetch;
  return attempts;
}

/** A public address the fixture lookup hands out; never actually connected to. */
const PUBLIC_ADDRESS = "93.184.215.14";

describe('addressPolicy "public-only"', () => {
  const refused: Array<[string, string]> = [
    ["127.0.0.1", "127.0.0.1"],
    ["10.0.0.1", "10.0.0.1"],
    ["169.254.169.254", "169.254.169.254"],
    ["[::1]", "::1"],
    ["[fc00::1]", "fc00::1"],
  ];

  for (const respectRobots of [true, false]) {
    for (const [literal, address] of refused) {
      test(`refuses ${literal}, as a literal and as a resolved name (respectRobots: ${respectRobots})`, async () => {
        routes = { "/": () => new Response("Ithaca's harbour ledger"), "/robots.txt": () => new Response("") };
        const lookup = lookupFrom({ "harbour.example": address });
        const attempts = recordFetch(() => new Response("unexpected"));
        const client = new ScrapeClient({ addressPolicy: "public-only", lookup, respectRobots });
        const port = server.port;
        for (const url of [`http://${literal}:${port}/`, `http://harbour.example:${port}/`]) {
          await expect(client.get(url, { retries: 0 })).rejects.toBeInstanceOf(NonPublicAddressError);
        }
        expect(attempts).toEqual([]);
        expect(seen).toEqual([]);
      });
    }

    test(`refuses a public host whose redirect points at a private address (respectRobots: ${respectRobots})`, async () => {
      routes = { "/ledger": () => new Response("Ithaca's harbour ledger") };
      const port = server.port;
      for (const target of [`http://127.0.0.1:${port}/ledger`, `http://harbour.example:${port}/ledger`]) {
        const lookup = lookupFrom({ "ithaca.example": PUBLIC_ADDRESS, "harbour.example": "127.0.0.1" });
        const attempts = recordFetch((path) =>
          path === "/robots.txt"
            ? new Response("", { status: 404 })
            : new Response(null, { status: 302, headers: { location: target } })
        );
        const client = new ScrapeClient({ addressPolicy: "public-only", lookup, respectRobots });
        await expect(client.get("http://ithaca.example/voyage", { retries: 0 })).rejects.toBeInstanceOf(
          NonPublicAddressError
        );
        // Only the public host was contacted; the redirect target never was.
        expect(attempts.map((attempt) => new URL(attempt.url).hostname)).toEqual(
          respectRobots ? [PUBLIC_ADDRESS, PUBLIC_ADDRESS] : [PUBLIC_ADDRESS]
        );
        expect(attempts.map((attempt) => new URL(attempt.url).pathname)).toEqual(
          respectRobots ? ["/robots.txt", "/voyage"] : ["/voyage"]
        );
        expect(seen).toEqual([]);
      }
    });
  }

  test("refuses a name when any of its addresses is private, not just the first", async () => {
    const attempts = recordFetch(() => new Response("unexpected"));
    const client = new ScrapeClient({
      addressPolicy: "public-only",
      respectRobots: false,
      lookup: async () => [
        { address: PUBLIC_ADDRESS, family: 4 },
        { address: "192.168.1.1", family: 4 },
      ],
    });
    await expect(client.get("http://ithaca.example/", { retries: 0 })).rejects.toBeInstanceOf(NonPublicAddressError);
    expect(attempts).toEqual([]);
  });

  test("connects to the checked address, keeping the host name for Host and TLS", async () => {
    let answers = 0;
    // A rebinding resolver: public the first time it is asked, loopback after.
    const lookup = async (): Promise<ResolvedAddress[]> => [
      answers++ === 0 ? { address: PUBLIC_ADDRESS, family: 4 } : { address: "127.0.0.1", family: 4 },
    ];
    const attempts = recordFetch(() => new Response("Penelope's loom count"));
    const client = new ScrapeClient({ addressPolicy: "public-only", respectRobots: false, lookup });
    const response = await client.get("https://ithaca.example/loom", { retries: 0 });
    expect(await response.text()).toBe("Penelope's loom count");
    expect(response.url).toBe("https://ithaca.example/loom");
    expect(answers).toBe(1);
    expect(attempts).toEqual([{ url: `https://${PUBLIC_ADDRESS}/loom`, host: "ithaca.example", serverName: "ithaca.example" }]);
  });

  test("the robots.txt fetch is held to the policy too, including its redirect hops", async () => {
    routes = { "/robots.txt": () => new Response("User-agent: *\nDisallow: /\n") };
    const lookup = lookupFrom({ "ithaca.example": PUBLIC_ADDRESS });
    const attempts = recordFetch((path) =>
      path === "/robots.txt"
        ? new Response(null, { status: 301, headers: { location: `${origin}/robots.txt` } })
        : new Response("Ithaca's harbour ledger")
    );
    const client = new ScrapeClient({ addressPolicy: "public-only", lookup });
    // The private robots.txt is never read, so its Disallow never applies:
    // the refusal is a failed fetch, permissive like any other.
    const response = await client.get("http://ithaca.example/ledger", { retries: 0 });
    expect(await response.text()).toBe("Ithaca's harbour ledger");
    expect(seen).toEqual([]);
    expect(attempts.map((attempt) => new URL(attempt.url).pathname)).toEqual(["/robots.txt", "/ledger"]);
  });

  test("a supplied robots cache must carry the same policy", () => {
    expect(() => new ScrapeClient({ addressPolicy: "public-only", robots: new RobotsCache() })).toThrow(
      /needs a robots cache built with the same policy/
    );
    const robots = new RobotsCache({ addressPolicy: "public-only" });
    expect(new ScrapeClient({ addressPolicy: "public-only", robots }).robots).toBe(robots);
  });

  test('"any" is the default and reaches the loopback fixture', async () => {
    routes = { "/": () => new Response("Ithaca's harbour ledger") };
    const response = await new ScrapeClient({ respectRobots: false }).get(`${origin}/`, { retries: 0 });
    expect(await response.text()).toBe("Ithaca's harbour ledger");
    expect(seen.map((s) => s.path)).toEqual(["/"]);
  });

  test("classifies the reserved ranges", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "172.16.0.1", "192.168.0.1",
      "198.51.100.1", "224.0.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:7f00:1", "2001:db8::1", "not-an-address"]) {
      expect(isPublicAddress(address)).toBe(false);
    }
    for (const address of [PUBLIC_ADDRESS, "2606:4700::1"]) expect(isPublicAddress(address)).toBe(true);
  });
});

describe("the robots.txt fetch", () => {
  test("carries the client's User-Agent", async () => {
    routes = { "/robots.txt": () => new Response("User-agent: *\nAllow: /\n"), "/": () => new Response("ok") };
    await new ScrapeClient({ userAgent: "ithaca-ledger/1.0 (+https://ithaca.example/bot)" }).get(`${origin}/`, { retries: 0 });
    expect(seen).toEqual([
      { path: "/robots.txt", userAgent: "ithaca-ledger/1.0 (+https://ithaca.example/bot)", host: `127.0.0.1:${server.port}` },
      { path: "/", userAgent: "ithaca-ledger/1.0 (+https://ithaca.example/bot)", host: `127.0.0.1:${server.port}` },
    ]);
  });

  test("stops at the configured redirect limit", async () => {
    routes = {
      "/robots.txt": () => new Response(null, { status: 302, headers: { location: "/hop/1" } }),
      "/hop/1": () => new Response(null, { status: 302, headers: { location: "/hop/2" } }),
      "/hop/2": () => new Response(null, { status: 302, headers: { location: "/hop/3" } }),
      "/hop/3": () => new Response("User-agent: *\nDisallow: /cellar\n"),
    };
    const limited = await new RobotsCache({ maxRedirects: 2 }).forUrl(`${origin}/cellar`);
    expect(limited.loaded).toBe(false);
    expect(seen.map((s) => s.path)).toEqual(["/robots.txt", "/hop/1", "/hop/2"]);

    seen.length = 0;
    const followed = await new RobotsCache({ maxRedirects: 3 }).forUrl(`${origin}/cellar`);
    expect(followed.loaded).toBe(true);
    expect(followed.isAllowed(`${origin}/cellar`, "ithaca-ledger")).toBe(false);
    expect(seen.map((s) => s.path)).toEqual(["/robots.txt", "/hop/1", "/hop/2", "/hop/3"]);
  });

  test("refuses a body over the configured size", async () => {
    const body = "User-agent: *\nDisallow: /cellar\n" + "#".repeat(200) + "\n";
    routes = { "/robots.txt": () => new Response(body) };
    const refused = await new RobotsCache({ maxBytes: 64 }).forUrl(`${origin}/cellar`);
    expect(refused.loaded).toBe(false);
    expect(refused.isAllowed(`${origin}/cellar`, "ithaca-ledger")).toBe(true);

    const read = await new RobotsCache({ maxBytes: body.length }).forUrl(`${origin}/cellar`);
    expect(read.loaded).toBe(true);
    expect(read.isAllowed(`${origin}/cellar`, "ithaca-ledger")).toBe(false);
  });
});
