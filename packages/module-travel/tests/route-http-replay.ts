/** Child-process transport replay. No fixture request reaches DNS or the network. */
import { appendFileSync, readFileSync } from "node:fs";

type Reply = { status?: number; body?: string; location?: string };
const replay: { replies: Record<string, Reply>; privateHosts?: string[]; log: string } = JSON.parse(readFileSync(process.env.ROUTE_REPLAY!, "utf8"));
// Bun's node:dns/promises facade uses this transport. mock.module on that
// builtin leaves its native resolver live in Bun 1.3.14.
Bun.dns.lookup = async (host: string) => [
  { address: replay.privateHosts?.includes(host) ? "10.0.0.1" : "93.184.215.14", family: 4, ttl: 60 },
];
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init);
  // scrape's "public-only" policy connects to the address it checked and keeps
  // the host name in the Host header and TLS server name. Replies are keyed by
  // the host name; the log also records the address actually connected to.
  const named = new URL(request.url), host = request.headers.get("host");
  if (host) named.host = host;
  const url = named.href;
  appendFileSync(replay.log, JSON.stringify({ url, connectedTo: request.url, method: request.method, headers: Object.fromEntries(request.headers) }) + "\n");
  const reply = replay.replies[url];
  if (!reply) throw new Error(`Unscripted offline route request: ${url}`);
  return new Response(reply.body ?? "", { status: reply.status ?? 200, headers: reply.location ? { location: reply.location } : undefined });
}, globalThis.fetch);
