/**
 * Which network addresses an HTTP request may reach.
 *
 * `"any"` is the default: a job board adapter fetches a fixed, known site, and
 * there is nothing to protect it from. `"public-only"` is for a caller that
 * fetches a URL a user supplied. It refuses loopback, private, link-local,
 * shared, documentation, benchmarking, multicast and reserved addresses, so a
 * pasted URL (or a redirect, or a DNS answer) cannot make the process read a
 * service on its own host or network, such as a cloud metadata endpoint.
 *
 * The check runs on the initial request, every redirect hop and the
 * robots.txt fetch, independently of `respectRobots`. On the native path the
 * request then connects to the address that was checked: the URL's host is
 * replaced by that address, while the `Host` header and the TLS server name
 * keep the original host name, so certificate verification is unchanged. A
 * second DNS answer therefore cannot redirect the connection (DNS
 * rebinding). Through a proxy the proxy resolves the name itself, so that
 * path keeps a window between the check and the connection (see the README).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** Which addresses a client's requests may reach. */
export type AddressPolicy = "any" | "public-only";

/** One resolved address, in the shape `node:dns` `lookup({ all: true })` returns. */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/**
 * How a host name becomes addresses. Injected so tests never reach DNS;
 * defaults to the system resolver (`node:dns` `lookup`).
 */
export type AddressLookup = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/** Thrown when `"public-only"` refuses a URL. Names the URL, never the answer. */
export class NonPublicAddressError extends Error {
  constructor(readonly url: string, reason: string = "resolves to a non-public address") {
    super(`${url} ${reason}; this client only reaches public addresses (addressPolicy "public-only").`);
    this.name = "NonPublicAddressError";
  }
}

const forbiddenV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) forbiddenV4.addSubnet(network, prefix, "ipv4");
/** Global unicast is the only IPv6 range a public host answers from. */
const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
const documentationV6 = new BlockList();
documentationV6.addSubnet("2001:db8::", 32, "ipv6");

/** True when `address` is one a `"public-only"` client may connect to. */
export function isPublicAddress(address: string, family: number = isIP(address)): boolean {
  if (family === 4) return isIP(address) === 4 && !forbiddenV4.check(address, "ipv4");
  if (family === 6) {
    if (isIP(address) !== 6) return false;
    // An IPv4-mapped address (::ffff:a.b.c.d) is outside 2000::/3 and refused here.
    return publicV6.check(address, "ipv6") && !documentationV6.check(address, "ipv6");
  }
  return false;
}

const systemLookup: AddressLookup = (hostname) => dnsLookup(hostname, { all: true });

/** The URL's host without IPv6 brackets. */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/**
 * Check one URL against `"public-only"` and return the address to connect to.
 *
 * Every address the name resolves to must be public, not just the first: a
 * resolver may answer differently in a different order. Returns `null` for an
 * IP-literal host, which needs no pinning.
 */
export async function checkPublicUrl(
  source: string | URL,
  lookup: AddressLookup = systemLookup
): Promise<ResolvedAddress | null> {
  const href = String(source);
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new NonPublicAddressError(href, "is not a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NonPublicAddressError(href, "is not an HTTP(S) URL");
  }
  const host = bareHost(url).toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new NonPublicAddressError(href, "names a local host");
  }
  const literal = isIP(host);
  if (literal) {
    if (!isPublicAddress(host, literal)) throw new NonPublicAddressError(href);
    return null;
  }
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new NonPublicAddressError(href, "could not be resolved");
  }
  if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
    throw new NonPublicAddressError(href);
  }
  return addresses[0]!;
}

/** `fetch` with Bun's TLS extension, which `RequestInit` does not declare. */
type PinnableInit = RequestInit & { tls?: { serverName?: string } & Record<string, unknown> };

/**
 * `fetch` a URL that `checkPublicUrl` already checked, connecting to the
 * address it returned.
 *
 * The request URL carries the address, and the `Host` header and TLS server
 * name carry the original host, so the server sees the same request and the
 * certificate is verified against the same name. A `null` address (an
 * IP-literal host) is a plain `fetch`.
 */
export function fetchPinned(source: string, init: RequestInit, pinned: ResolvedAddress | null): Promise<Response> {
  if (!pinned) return fetch(source, init);
  const url = new URL(source);
  const target = new URL(source);
  target.hostname = pinned.family === 6 ? `[${pinned.address}]` : pinned.address;
  const headers = new Headers(init.headers);
  headers.set("Host", url.host);
  const pinnedInit: PinnableInit = { ...init, headers };
  if (url.protocol === "https:") {
    pinnedInit.tls = { ...(init as PinnableInit).tls, serverName: bareHost(url) };
  }
  return fetch(target.href, pinnedInit);
}

/** `fetch` one URL under an address policy, without following redirects. */
export async function fetchUnderPolicy(
  source: string,
  init: RequestInit,
  policy: AddressPolicy,
  lookup?: AddressLookup
): Promise<Response> {
  if (policy !== "public-only") return fetch(source, init);
  return fetchPinned(source, init, await checkPublicUrl(source, lookup));
}
