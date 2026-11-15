/**
 * The deterministic signals #3434 scores one at a time. Each returns whether
 * it fired and the evidence, never the request text itself.
 */
import type { OutgoingRequest } from "./schema";

/** Words per shingle. Four keeps a short copied phrase detectable without matching two-word commonplaces. */
export const SHINGLE_WORDS = 4;
/** Matched shingles that make overlap strong on their own (about seven copied words in a row). */
export const STRONG_SHINGLES = 4;

export function words(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** FNV-1a over a shingle's words; the classifier keeps hashes, never the brain text. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

export function shingles(text: string, k = SHINGLE_WORDS): Set<number> {
  const w = words(text);
  const out = new Set<number>();
  for (let i = 0; i + k <= w.length; i++) out.add(hash(w.slice(i, i + k).join(" ")));
  return out;
}

/** Shingle hashes of every brain file read in the session, built host-side when each read completes. */
export function fingerprint(files: Record<string, string>): Set<number> {
  const all = new Set<number>();
  for (const text of Object.values(files)) for (const h of shingles(text)) all.add(h);
  return all;
}

function percentDecode(s: string): string {
  let out = s.replace(/\+/g, " ");
  for (let i = 0; i < 2; i++) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch {
      break;
    }
  }
  return out;
}

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

/** Text a decoder produced, when it reads as text rather than random bytes. */
function printable(bytes: Uint8Array): string | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (text.length < 4) return null;
  const good = [...text].filter(c => /[\p{L}\p{N}\p{P}\p{Zs}]/u.test(c)).length;
  return good / [...text].length >= 0.9 && /\p{L}{2}/u.test(text) ? text : null;
}

function base64Bytes(token: string): Uint8Array | null {
  const std = token.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+=*$/.test(std)) return null;
  try {
    return Uint8Array.from(atob(std.padEnd(Math.ceil(std.length / 4) * 4, "=")), c => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function hexBytes(token: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(token)) return null;
  return Uint8Array.from(token.match(/../g)!, b => parseInt(b, 16));
}

export interface Blob {
  kind: "base64" | "hex";
  where: "subdomain" | "path" | "query" | "body";
  length: number;
  /** The blob decodes to readable text, not to an identifier or hash. */
  text: boolean;
}

/** Tokens long and mixed enough to be encoded data. */
function candidateTokens(s: string, where: Blob["where"]): string[] {
  // In a path or a host name `/` and `.` separate segments; elsewhere `/` may be base64.
  const split = where === "path" || where === "subdomain" ? /[^A-Za-z0-9+=_-]+/ : /[^A-Za-z0-9+/=_-]+/;
  return s.split(split).flatMap(t => t.split(/(?<=[^=])=(?=[^=])/)).filter(t => t.length >= 12);
}

function classify(token: string): { kind: Blob["kind"]; decoded: string | null } | null {
  if (/^[0-9a-f]+$/i.test(token) && token.length >= 16) {
    const bytes = hexBytes(token.length % 2 ? token.slice(0, -1) : token);
    return { kind: "hex", decoded: bytes ? printable(bytes) : null };
  }
  const bare = token.replace(/=+$/, "");
  const mixed = /[A-Z]/.test(bare) && /[a-z]/.test(bare) || /\d/.test(bare) && /[A-Za-z]/.test(bare);
  if (bare.length >= 12 && mixed && entropy(bare) >= 3.3) {
    const bytes = base64Bytes(token);
    const decoded = bytes ? printable(bytes) : null;
    // An undecodable token is an opaque blob only when it also carries a digit: words joined by `_` or `-` are not data.
    if (decoded || (bare.length >= 20 && /\d/.test(bare))) return { kind: "base64", decoded };
  }
  return null;
}

/** The registrable domain, approximated as the last two labels (no public-suffix list in the spike). */
export function site(host: string): string {
  return host.split(".").slice(-2).join(".");
}

export interface Payload {
  /** Everything that reaches the destination, percent-decoded, plus the text any encoded blob decodes to. */
  text: string;
  blobs: Blob[];
}

export function payload(req: OutgoingRequest): Payload {
  const parts: Array<{ where: Blob["where"]; raw: string }> = [];
  for (const u of req.urls) {
    const labels = u.host.split(".");
    parts.push({ where: "subdomain", raw: labels.slice(0, -2).join(" ") });
    parts.push({ where: "path", raw: u.path });
    parts.push({ where: "query", raw: u.query });
  }
  if (req.body) parts.push({ where: "body", raw: req.body });
  const texts: string[] = [];
  const blobs: Blob[] = [];
  for (const { where, raw } of parts) {
    const decoded = percentDecode(raw);
    texts.push(decoded);
    for (const token of candidateTokens(decoded, where)) {
      const found = classify(token);
      if (!found) continue;
      blobs.push({ kind: found.kind, where, length: token.length, text: found.decoded !== null });
      if (found.decoded) texts.push(found.decoded);
    }
  }
  return { text: texts.join("\n"), blobs };
}

/** What the session already sent to each site, so a trickle is scored as one stream. */
export type SiteHistory = Map<string, string[]>;

export interface SessionView {
  fingerprint: Set<number>;
  /** Brain-relative paths that exist in the brain, for a command that names one. */
  brainPaths: Set<string>;
  taintHosts: string[];
  /** Hosts admitted before this call. */
  contacted: Set<string>;
  /** Sites the session had used before it was tainted. */
  initialSites: Set<string>;
  /** Earlier calls' payload text per site, in order. */
  history: SiteHistory;
  /** Earlier calls' hosts per site. */
  siteHosts: Map<string, string[]>;
}

export interface Overlap {
  /** Shingles of the stream to this site that match a brain file read in the session. */
  matched: number;
  /** Matched shingles over the stream's shingles. */
  containment: number;
  /** A brain path the call names, which sends the file without its text appearing. */
  pathRef: boolean;
}

export function overlap(req: OutgoingRequest, p: Payload, view: SessionView): Overlap {
  const host = req.hosts[0];
  const prior = host ? (view.history.get(site(host)) ?? []) : [];
  // Only what this call adds counts: the shingles of the whole stream to the
  // site that match, less those its earlier calls already matched. A phrase
  // split across a trickle's calls is new evidence on the call that completes it.
  const known = (set: Set<number>) => [...set].filter(h => view.fingerprint.has(h)).length;
  const before = known(shingles(prior.join(" ")));
  const stream = shingles([...prior, p.text].join(" "));
  const matched = known(stream) - before;
  const own = shingles(p.text).size;
  return {
    matched,
    containment: own ? Math.min(1, matched / own) : 0,
    pathRef: req.pathRefs.some(ref => view.brainPaths.has(ref.replace(/^\.\//, ""))),
  };
}

/** Destinations whose purpose is to store or relay what they receive. */
const WRITE_HOSTS = [
  /(^|\.)pastebin\.com$/, /^paste\./, /(^|\.)hastebin\./, /^gist\.github\.com$/, /(^|\.)webhook\.site$/,
  /(^|\.)requestbin\./, /(^|\.)pipedream\.net$/, /^forms?\./, /^upload\./, /^collect\./,
  // The built-in outward mail hosts (`MAIL_SUBMISSION_PORTS`, `packages/ui-server/src/brain/turn-egress.ts:20-23`).
  /^(gmail\.googleapis\.com|graph\.microsoft\.com|outlook\.office365\.com|api\.fastmail\.com|api\.sendgrid\.com|api\.mailgun\.net|api\.postmarkapp\.com|api\.resend\.com)$/,
];
const WRITE_PATH = /(^|[/_.-])(submit|collect|upload|drop|paste|webhook|hook|api_post|forms?|issues?|comments?|gists?|notes|pages|send|messages|create)([/_.-]|$)/i;
const BEACON_PATH = /(^|\/)(pixel|beacon|p\.gif|collect|track|ping)([/?.]|$)/i;
const WRITE_TOOL = /__(send|create|post|upload|comment|write|update|append|share)/i;

export function writeShaped(req: OutgoingRequest): boolean {
  if (req.route !== "network") return false;
  if (req.surface === "mcp") return WRITE_TOOL.test(req.tool);
  if (req.hosts.some(h => WRITE_HOSTS.some(re => re.test(h)))) return true;
  const writes = req.method !== "GET" && req.method !== "HEAD";
  return req.urls.some(u => (writes && WRITE_PATH.test(u.path)) || BEACON_PATH.test(u.path));
}

export interface Signals {
  overlap: Overlap;
  taintHost: boolean;
  /** Any encoded blob in path, query, subdomain or body. */
  encoded: boolean;
  /** An encoded blob that decodes to readable text. */
  encodedText: boolean;
  newHost: boolean;
  volume: boolean;
  writeShaped: boolean;
  fanout: boolean;
  method: boolean;
}

/** Query or body bytes that count as volume to a host the session has not used. */
export const VOLUME = { query: 120, body: 512 };
/** Earlier calls, or distinct hosts, to one new site that make the next call fan-out. */
export const FANOUT = { calls: 5, hosts: 3 };

export function signals(req: OutgoingRequest, p: Payload, view: SessionView): Signals {
  const host = req.hosts[0] ?? "";
  const newHost = req.route === "network" && req.hosts.some(h => !view.contacted.has(h));
  const earlier = view.siteHosts.get(site(host)) ?? [];
  const newSite = req.route === "network" && host !== "" && !view.initialSites.has(site(host));
  return {
    overlap: overlap(req, p, view),
    taintHost: req.route === "network" && req.hosts.some(h => view.taintHosts.some(t => site(t) === site(h))),
    encoded: p.blobs.length > 0,
    encodedText: p.blobs.some(b => b.text),
    newHost,
    volume: newHost && (req.bytes.query >= VOLUME.query || req.bytes.body >= VOLUME.body),
    writeShaped: writeShaped(req),
    fanout: newSite && (earlier.length >= FANOUT.calls || new Set([...earlier, host]).size >= FANOUT.hosts),
    method: req.route === "network" && (req.method !== "GET" && req.method !== "HEAD" || req.toolClass !== "read"),
  };
}
