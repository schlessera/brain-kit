/**
 * Deterministic extraction heuristics for a tainted session's outgoing calls
 * (#4088), measured by #3434 (`docs/plans/extraction-classifier.md`).
 *
 * Pure and host-side. It judges one outgoing call from what admission holds
 * and the session's own state (shingle hashes of the files it read, the hosts
 * its tainting content named, the hosts it contacted and each site's earlier
 * payloads), and returns a band with a reason. Nothing here enters the
 * provider-facing conversation; the turn's egress decides what the band may
 * change (`prepareTurnEgress`, `packages/ui-server/src/brain/turn-egress.ts`).
 */

/** Where the call was admitted, which decides what can be read from it. */
type Surface = "web_fetch" | "bash" | "mcp" | "brain_cli" | "provider_relay" | "other";

/**
 * The host's existing classification of the call: the command policy's
 * read/outward split (`classifyOutwardCall`,
 * `packages/ui-sdk/src/server/outward-actions.ts:149`). `opaque` is a call
 * the host cannot read, such as a script file.
 */
export type ToolClass = "read" | "outward" | "opaque";
export type Band = "allow" | "ask" | "block";

/** One outgoing call as the admission point receives it. */
export interface CallInput {
  surface: Surface;
  /** Tool name as admitted: `WebFetch`, `Bash`, `mcp__<server>__<tool>`, `brain`. */
  tool: string;
  toolClass: ToolClass;
  /** WebFetch: the URL. */
  url?: string;
  /** Bash and `brain` CLI: the full command line. */
  command?: string;
  /** MCP and provider relay: the arguments or request body. */
  args?: Record<string, unknown>;
  /** Provider relay only: the configured provider host. */
  relayHost?: string;
}

/** The normalized request the classifier scores (the plan's request schema). */
export interface OutgoingRequest {
  surface: Surface;
  tool: string;
  toolClass: ToolClass;
  /**
   * `network` reaches a destination through the turn proxy; `relay` is a
   * validated provider-relay request, routed under G2; `local` opens no
   * connection the host can attribute (brain-kit's own MCP servers, local
   * `brain` commands, file tools).
   */
  route: "network" | "relay" | "local";
  method: string;
  /** Destination hosts, lowercased. Empty for `local`. */
  hosts: string[];
  /** Path, query and subdomain labels of each URL, raw. */
  urls: Array<{ host: string; path: string; query: string }>;
  /** Everything else that reaches the destination: body, command arguments, MCP argument values. */
  body: string;
  /** Brain-relative paths the call names, which a command can send without quoting their text. */
  pathRefs: string[];
  bytes: { query: number; body: number };
}

/** brain-kit's own MCP servers open no outside connection. */
const LOCAL_MCP_SERVERS = new Set(["brain", "brain-ui"]);
const URL_RE = /https?:\/\/[^\s'"<>()`]+/g;
/** Tools that read the brain or edit it and open no connection. */
const LOCAL_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead", "Glob", "Grep", "LS", "TodoWrite",
  "Task", "Agent", "ToolSearch", "WebSearch", "ExitPlanMode", "read", "write", "edit", "grep", "find", "ls"]);

/** Shell words, honouring quotes, backslashes and a `<<<` here-string. Enough to find arguments, not a shell. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "", quote: "'" | '"' | null = null, started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === "\\" && i + 1 < command.length) { word += command[++i]; started = true; continue; }
    if (/\s/.test(c)) { if (started) words.push(word); word = ""; started = false; continue; }
    word += c; started = true;
  }
  if (started) words.push(word);
  return words;
}

function splitUrl(raw: string): { host: string; path: string; query: string } | null {
  try {
    const url = new URL(raw);
    return { host: url.hostname.toLowerCase(), path: url.pathname, query: url.search.replace(/^\?/, "") };
  } catch { return null; }
}

const CURL_DATA = new Set(["-d", "--data", "--data-binary", "--data-raw", "--data-urlencode", "--data-ascii", "-F", "--form", "-T", "--upload-file", "--json"]);
const GH_TEXT = new Set(["--body", "-b", "--title", "-t", "--description", "-d", "--field", "-f", "--raw-field", "-F", "--notes", "-n"]);
const GH_WRITES = /^(create|comment|edit|delete|close|reopen|merge|upload|review)$/;

/** A brain-relative Markdown path a command names, with any `@` or `<` sigil removed. */
function pathRef(word: string): string | null {
  const bare = word.replace(/^[a-z]+=/i, "").replace(/^[@<]+/, "");
  return /^(?!\/)(?!https?:)[\w.\-/]+\.md$/.test(bare) ? bare : null;
}

function bashRequest(command: string): Pick<OutgoingRequest, "method" | "hosts" | "urls" | "body" | "pathRefs" | "bytes"> {
  const words = shellWords(command);
  const urls = [...command.matchAll(URL_RE)].map(m => splitUrl(m[0])).filter(u => u !== null);
  const hosts = new Set(urls.map(u => u.host));
  const data: string[] = [];
  let method = "GET", explicit: string | null = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!, next = words[i + 1];
    if ((w === "-X" || w === "--request" || w === "--method") && next) { explicit = next.toUpperCase(); i++; continue; }
    if (/^-X[A-Z]+$/.test(w)) { explicit = w.slice(2); continue; }
    if (CURL_DATA.has(w) && next !== undefined && words[0] === "curl") {
      data.push(next);
      method = w === "-T" || w === "--upload-file" ? "PUT" : "POST";
      i++; continue;
    }
    if (w === "<<<" && next !== undefined) { data.push(next); continue; }
  }
  if (words[0] === "gh") {
    // gh reaches the REST API; its subcommand stands in for the path it calls.
    hosts.add("api.github.com");
    const sub = words[1] === "api" ? (words.find((w, i) => i > 1 && !w.startsWith("-")) ?? "") : `gh/${words[1] ?? ""}/${words[2] ?? ""}`;
    const [path, query = ""] = sub.replace(/^\/?/, "/").split("?");
    urls.push({ host: "api.github.com", path: path!, query });
    if (GH_WRITES.test(words[2] ?? "")) method = "POST";
    for (let i = 0; i < words.length; i++) {
      if (GH_TEXT.has(words[i]!) && words[i + 1] !== undefined) data.push(words[i + 1]!);
      if (words[1] === "api" && (words[i] === "-f" || words[i] === "-F" || words[i] === "--input")) method = "POST";
    }
  }
  if (explicit) method = explicit;
  const query = urls.reduce((n, u) => n + u.query.length, 0);
  return { method, hosts: [...hosts], urls, body: command, pathRefs: [...new Set(words.map(pathRef).filter((p): p is string => p !== null))],
    bytes: { query, body: data.reduce((n, d) => n + Buffer.byteLength(d), 0) } };
}

function argStrings(value: unknown, depth = 0): string[] {
  if (depth > 16) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(item => argStrings(item, depth + 1));
  if (value && typeof value === "object") return Object.values(value).flatMap(item => argStrings(item, depth + 1));
  return value === undefined || value === null ? [] : [String(value)];
}

/** The request the classifier scores, built from what the admission point already holds. */
export function toRequest(call: CallInput): OutgoingRequest {
  const base = { surface: call.surface, tool: call.tool, toolClass: call.toolClass };
  if (call.surface === "web_fetch") {
    const url = splitUrl(call.url ?? "");
    // The prompt goes to the fetch summarizer on the conversation's own provider, never to the destination.
    return { ...base, route: "network", method: "GET", hosts: url ? [url.host] : [], urls: url ? [url] : [],
      body: "", pathRefs: [], bytes: { query: url?.query.length ?? 0, body: 0 } };
  }
  if (call.surface === "provider_relay") {
    const body = argStrings(call.args).join("\n");
    return { ...base, route: "relay", method: "POST", hosts: call.relayHost ? [call.relayHost] : [], urls: [],
      body, pathRefs: [], bytes: { query: 0, body: Buffer.byteLength(body) } };
  }
  if (call.surface === "mcp") {
    const server = call.tool.split("__")[1] ?? "";
    const strings = argStrings(call.args), body = strings.join("\n");
    const urls = strings.flatMap(s => [...s.matchAll(URL_RE)].map(m => splitUrl(m[0]))).filter(u => u !== null);
    const local = LOCAL_MCP_SERVERS.has(server);
    return { ...base, route: local ? "local" : "network", method: call.toolClass === "outward" ? "POST" : "GET",
      hosts: local ? [] : urls.length ? [...new Set(urls.map(u => u.host))] : [`mcp.${server}`],
      urls, body, pathRefs: strings.map(pathRef).filter((p): p is string => p !== null), bytes: { query: 0, body: Buffer.byteLength(body) } };
  }
  if (call.surface === "other") return { ...base, route: "local", method: "GET", hosts: [], urls: [], body: "", pathRefs: [], bytes: { query: 0, body: 0 } };
  const shell = bashRequest(call.command ?? "");
  const local = call.surface === "brain_cli" && shell.hosts.length === 0;
  return { ...base, route: local ? "local" : "network", ...shell };
}

/**
 * A tool call as the classifier's input. `toolClass` is the command
 * policy's classification of the same input, which the caller supplies so
 * this module stays pure. A tool the host does not know is `other`: it opens
 * no connection the host can name, and its class is the caller's.
 */
export function callInput(tool: string, input: unknown, toolClass: ToolClass): CallInput {
  const object = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (tool === "WebFetch" || tool === "fetch_content") return { surface: "web_fetch", tool, toolClass, url: typeof object.url === "string" ? object.url : "" };
  if (tool === "Bash" || tool === "bash") {
    const command = typeof object.command === "string" ? object.command : "";
    return { surface: shellWords(command)[0] === "brain" ? "brain_cli" : "bash", tool, toolClass, command };
  }
  if (tool.startsWith("mcp__")) return { surface: "mcp", tool, toolClass, args: object };
  return { surface: "other", tool, toolClass };
}

/** Whether the host knows a tool opens no connection of its own: a file tool, a brain-kit MCP server's tool. */
export function localTool(tool: string): boolean {
  const server = /^mcp__(.+?)__/.exec(tool)?.[1];
  return server !== undefined ? LOCAL_MCP_SERVERS.has(server) : LOCAL_TOOLS.has(tool);
}

// ---- Signals ---------------------------------------------------------------

/** Words per shingle. Four keeps a short copied phrase detectable without matching two-word commonplaces. */
const SHINGLE_WORDS = 4;
/** Matched shingles that make overlap strong on their own (about seven copied words in a row). */
const STRONG_SHINGLES = 4;

function words(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** FNV-1a over a shingle's words; the classifier keeps hashes, never the text. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function shingleList(w: readonly string[], k = SHINGLE_WORDS): number[] {
  const out: number[] = [];
  for (let i = 0; i + k <= w.length; i++) out.push(hash(w.slice(i, i + k).join(" ")));
  return out;
}

function shingles(text: string, k = SHINGLE_WORDS): Set<number> {
  return new Set(shingleList(words(text), k));
}

function percentDecode(s: string): string {
  let out = s.replace(/\+/g, " ");
  for (let i = 0; i < 2; i++) {
    try { const next = decodeURIComponent(out); if (next === out) break; out = next; } catch { break; }
  }
  return out;
}

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
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
  try { return Uint8Array.from(atob(std.padEnd(Math.ceil(std.length / 4) * 4, "=")), c => c.charCodeAt(0)); } catch { return null; }
}

function hexBytes(token: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(token)) return null;
  return Uint8Array.from(token.match(/../g)!, b => parseInt(b, 16));
}

interface Blob {
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

function classifyToken(token: string): { kind: Blob["kind"]; decoded: string | null } | null {
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

/** The registrable domain, approximated as the last two labels (no public-suffix list). */
export function site(host: string): string {
  return host.split(".").slice(-2).join(".");
}

interface Payload {
  /** Everything that reaches the destination, percent-decoded, plus the text any encoded blob decodes to. */
  text: string;
  blobs: Blob[];
}

function payload(req: OutgoingRequest): Payload {
  const parts: Array<{ where: Blob["where"]; raw: string }> = [];
  for (const u of req.urls) {
    parts.push({ where: "subdomain", raw: u.host.split(".").slice(0, -2).join(" ") });
    parts.push({ where: "path", raw: u.path });
    parts.push({ where: "query", raw: u.query });
  }
  if (req.body) parts.push({ where: "body", raw: req.body });
  const texts: string[] = [], blobs: Blob[] = [];
  for (const { where, raw } of parts) {
    const decoded = percentDecode(raw);
    texts.push(decoded);
    for (const token of candidateTokens(decoded, where)) {
      const found = classifyToken(token);
      if (!found) continue;
      blobs.push({ kind: found.kind, where, length: token.length, text: found.decoded !== null });
      if (found.decoded) texts.push(found.decoded);
    }
  }
  return { text: texts.join("\n"), blobs };
}

/** Destinations whose purpose is to store or relay what they receive. */
const WRITE_HOSTS = [
  /(^|\.)pastebin\.com$/, /^paste\./, /(^|\.)hastebin\./, /^gist\.github\.com$/, /(^|\.)webhook\.site$/,
  /(^|\.)requestbin\./, /(^|\.)pipedream\.net$/, /^forms?\./, /^upload\./, /^collect\./,
  // The built-in outward mail hosts (`MAIL_SUBMISSION_HOSTS`, `packages/ui-server/src/brain/turn-egress.ts:23-25`).
  /^(gmail\.googleapis\.com|graph\.microsoft\.com|outlook\.office365\.com|api\.fastmail\.com|api\.sendgrid\.com|api\.mailgun\.net|api\.postmarkapp\.com|api\.resend\.com)$/,
];
const WRITE_PATH = /(^|[/_.-])(submit|collect|upload|drop|paste|webhook|hook|api_post|forms?|issues?|comments?|gists?|notes|pages|send|messages|create)([/_.-]|$)/i;
const BEACON_PATH = /(^|\/)(pixel|beacon|p\.gif|collect|track|ping)([/?.]|$)/i;
const WRITE_TOOL = /__(send|create|post|upload|comment|write|update|append|share)/i;

function writeShaped(req: OutgoingRequest): boolean {
  if (req.route !== "network") return false;
  if (req.surface === "mcp") return WRITE_TOOL.test(req.tool);
  if (req.hosts.some(h => WRITE_HOSTS.some(re => re.test(h)))) return true;
  const writes = req.method !== "GET" && req.method !== "HEAD";
  return req.urls.some(u => (writes && WRITE_PATH.test(u.path)) || BEACON_PATH.test(u.path));
}

/** Query or body bytes that count as volume to a host the session has not used. */
const VOLUME = { query: 120, body: 512 };
/** Earlier calls, or distinct hosts, to one new site that make the next call fan-out. */
const FANOUT = { calls: 5, hosts: 3 };

interface Overlap {
  /** Shingles this call adds to its site's stream that match a file read in the session. */
  matched: number;
  /** Matched shingles over the call's own shingles. */
  containment: number;
  /** A brain path the call names, which sends the file without its text appearing. */
  pathRef: boolean;
  /** The read files the matched shingles and named paths come from, for the reason. */
  files: string[];
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

// ---- Session state ---------------------------------------------------------

/** Bounds on what one session keeps. Past one, the state is incomplete: it never allows, and still asks and refuses. */
const SESSION_LIMITS = { shingles: 200_000, taintHosts: 1_024, sites: 512, siteHosts: 64, fileBytes: 4 * 1024 * 1024 };

interface SiteStream { matched: Set<number>; tail: string[]; hosts: string[] }

/**
 * What the host keeps about one session for the classifier, never the text
 * itself: shingle hashes of the files it read (each with the path it came
 * from), the hosts its tainting content named, the sites it used before its
 * taint and each site's earlier payloads, as the hashes they matched and the
 * last words of the stream.
 *
 * `complete` is false when the state may have missed a read: it was created
 * after the session began (a restart, the setting turned on mid-session) or
 * outgrew a bound. An incomplete state never allows.
 */
export class ExtractionSession {
  readonly fingerprint = new Map<number, string>();
  readonly taintHosts = new Set<string>();
  readonly streams = new Map<string, SiteStream>();
  /** Sites the session had used before it was tainted; fixed at the first tainted classification. */
  initialSites: Set<string> | null = null;
  complete: boolean;
  constructor(complete: boolean) { this.complete = complete; }

  /** A file the session read. `path` names it in a reason. */
  read(path: string, text: string): void {
    if (Buffer.byteLength(text) > SESSION_LIMITS.fileBytes) { this.complete = false; return; }
    for (const h of shingles(text)) {
      if (this.fingerprint.has(h)) continue;
      if (this.fingerprint.size >= SESSION_LIMITS.shingles) { this.complete = false; return; }
      this.fingerprint.set(h, path);
    }
  }

  /** Hosts the content that tainted the session named. */
  tainting(hosts: Iterable<string>): void {
    for (const host of hosts) {
      if (this.taintHosts.has(host)) continue;
      if (this.taintHosts.size >= SESSION_LIMITS.taintHosts) { this.complete = false; return; }
      this.taintHosts.add(host);
    }
  }

  /** Fix the sites used before the taint, once. */
  freezeInitial(contacted: Iterable<string>): void {
    this.initialSites ??= new Set([...contacted].map(site));
  }

  /** Every attempted call joins its site's stream, refused or not: the attempt is what the next admission can see. */
  record(req: OutgoingRequest, p: Payload): void {
    const host = req.hosts[0];
    if (!host) return;
    const key = site(host);
    let stream = this.streams.get(key);
    if (!stream) {
      if (this.streams.size >= SESSION_LIMITS.sites) { this.complete = false; return; }
      this.streams.set(key, stream = { matched: new Set(), tail: [], hosts: [] });
    }
    const all = [...stream.tail, ...words(p.text)];
    for (const h of shingleList(all)) if (this.fingerprint.has(h)) stream.matched.add(h);
    stream.tail = all.slice(-(SHINGLE_WORDS - 1));
    if (stream.hosts.length < SESSION_LIMITS.siteHosts) stream.hosts.push(host);
  }
}

interface SessionView {
  session: ExtractionSession;
  /** Hosts admitted before this call. */
  contacted(host: string): boolean;
  /** Whether a brain-relative path names a file in the brain. */
  brainPath(path: string): boolean;
}

function overlap(req: OutgoingRequest, p: Payload, view: SessionView): Overlap {
  const host = req.hosts[0];
  const stream = host ? view.session.streams.get(site(host)) : undefined;
  // Only what this call adds counts: the shingles of the whole stream to the
  // site that match, less those its earlier calls already matched. A phrase
  // split across a trickle's calls is new evidence on the call that completes it.
  const fingerprint = view.session.fingerprint;
  const fresh = new Set<number>();
  for (const h of shingleList([...(stream?.tail ?? []), ...words(p.text)])) if (fingerprint.has(h) && !stream?.matched.has(h)) fresh.add(h);
  const own = shingles(p.text).size;
  const named = req.pathRefs.map(ref => ref.replace(/^\.\//, "")).filter(ref => view.brainPath(ref));
  const files = [...new Set([...named, ...[...fresh].map(h => fingerprint.get(h)!)])];
  return { matched: fresh.size, containment: own ? Math.min(1, fresh.size / own) : 0, pathRef: named.length > 0, files };
}

function signals(req: OutgoingRequest, p: Payload, view: SessionView): Signals {
  const host = req.hosts[0] ?? "";
  const network = req.route === "network";
  const newHost = network && req.hosts.some(h => !view.contacted(h));
  const earlier = view.session.streams.get(site(host))?.hosts ?? [];
  const newSite = network && host !== "" && !(view.session.initialSites?.has(site(host)) ?? false);
  const taintSites = new Set([...view.session.taintHosts].map(site));
  return {
    overlap: overlap(req, p, view),
    taintHost: network && req.hosts.some(h => taintSites.has(site(h))),
    encoded: p.blobs.length > 0,
    encodedText: p.blobs.some(b => b.text),
    newHost,
    volume: newHost && (req.bytes.query >= VOLUME.query || req.bytes.body >= VOLUME.body),
    writeShaped: writeShaped(req),
    fanout: newSite && (earlier.length >= FANOUT.calls || new Set([...earlier, host]).size >= FANOUT.hosts),
    method: network && (req.method !== "GET" && req.method !== "HEAD" || req.toolClass !== "read"),
  };
}

// ---- Tiers and the combination with policy ----------------------------------

/** Weights of the non-overlap evidence, as #3434 calibrated them (`WEIGHTS`, `evals/3434-extraction-classifier/classify.ts`). */
const WEIGHTS = {
  weakOverlap: 0.45, taintHost: 0.25, encodedText: 0.25, encodedOpaque: 0.1,
  volume: 0.15, writeShaped: 0.25, fanout: 0.3, method: 0.1,
} as const;
/** Below this score a call is allowed; at or above it, it asks. Calibrated on the #3434 tuning sessions. */
const ALLOW_BELOW = 0.2;
/**
 * The top of the ambiguous band: a score from `ALLOW_BELOW` up to this asks
 * on the heuristics alone, and is the band a judge may be asked about (#4089).
 * Calibrated with the judge on the #3434 tuning sessions; in practice it holds
 * links the tainting content named and pagination cursors.
 */
const ASK_FROM = 0.35;

const strongOverlap = (s: Signals): boolean =>
  s.overlap.pathRef || s.overlap.matched >= STRONG_SHINGLES || (s.overlap.matched >= 2 && s.overlap.containment >= 0.5);

function score(s: Signals): number {
  const w = WEIGHTS;
  return (s.overlap.matched > 0 ? w.weakOverlap : 0) + (s.taintHost ? w.taintHost : 0) +
    (s.encodedText ? w.encodedText : s.encoded ? w.encodedOpaque : 0) + (s.volume ? w.volume : 0) +
    (s.writeShaped ? w.writeShaped : 0) + (s.fanout ? w.fanout : 0) + (s.method ? w.method : 0);
}

/**
 * The heuristics' band. Strong overlap blocks a copy leaving for a new,
 * write-shaped or writing destination. An outward action (a gist, an issue,
 * mail) already raises its own card, and the user's own write often quotes
 * their notes, so there it asks, with the overlap as the card's evidence. A
 * validated relay request is routed under G2, and a local call opens no
 * connection: both are allowed. Every other call sums weighted evidence.
 */
function band(req: OutgoingRequest, s: Signals): Band {
  if (req.route !== "network") return "allow";
  if (strongOverlap(s)) return req.toolClass === "outward" ? "ask" : s.writeShaped || s.method || s.newHost ? "block" : "ask";
  return score(s) < ALLOW_BELOW ? "allow" : "ask";
}

/** What the host decides without the classifier, after #3430. */
type Policy = "admit" | "taint_ask" | "outward_ask" | "refuse";
export type Final = "admit" | "ask" | "refuse";

export function policyFor(req: OutgoingRequest, contacted: (host: string) => boolean): Policy {
  if (req.route !== "network") return "admit";
  if (req.toolClass === "outward") return "outward_ask";
  if (req.surface === "mcp") return "admit";
  return req.hosts.every(contacted) ? "admit" : "taint_ask";
}

/**
 * The band combined with the host's own decision. The band can add a card or
 * a refusal to anything; the only thing an `allow` may relax is the #3430
 * tainted-destination card. Deny, `allowlist` mode, budgets and outward rules
 * (`refuse`, `outward_ask`) stand whatever the band says. A turn with no grant
 * surface refuses wherever an interactive one would ask, and keeps refusing a
 * tainted new destination whatever the verdict.
 */
export function decide(policy: Policy, verdict: Band | null, origin: "interactive" | "voice" = "interactive"): Final {
  if (policy === "refuse" || verdict === "block") return "refuse";
  if (origin !== "interactive" && policy === "taint_ask") return "refuse";
  const asks = verdict === "ask" || policy === "outward_ask" || (policy === "taint_ask" && verdict === null);
  if (!asks) return "admit";
  return origin === "interactive" ? "ask" : "refuse";
}

export interface Verdict {
  band: Band;
  /**
   * The call's score is in the ambiguous band (`ALLOW_BELOW` to `ASK_FROM`),
   * with no strong overlap, on the network: its band is `ask`, and it is the
   * only kind of call a judge may answer instead (#4089).
   */
  ambiguous: boolean;
  request: OutgoingRequest;
  signals: Signals;
  score: number;
  /** Why, as a clause completing "This call …"; null for an allowed call with no evidence. */
  reason: string | null;
}

const code = (path: string) => `\`${path.replace(/`/g, "")}\``;
/** The evidence as a clause completing "This call …", strongest first. */
function reasonFor(s: Signals): string | null {
  const parts: string[] = [];
  if (s.overlap.files.length) {
    const named = s.overlap.files.slice(0, 2).map(code).join(" and ") + (s.overlap.files.length > 2 ? ` and ${s.overlap.files.length - 2} more` : "");
    parts.push(s.overlap.matched > 0 ? `contains text from ${named}` : `sends ${named}`);
  }
  if (s.taintHost) parts.push("matches a link from the content that tainted this session");
  if (s.encodedText) parts.push("carries encoded text");
  else if (s.encoded) parts.push("carries an encoded value");
  if (s.volume) parts.push("sends a large query or body to a host this session has not contacted");
  if (s.writeShaped) parts.push("goes to a destination that stores what it receives");
  if (s.fanout) parts.push("is one of many calls to a site this session only started using after its taint");
  if (s.method && !parts.length) parts.push("writes rather than reads");
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Judge one call and record it in its site's stream. */
export function classify(call: CallInput, view: SessionView): Verdict {
  const request = toRequest(call);
  const p = payload(request);
  const s = signals(request, p, view);
  const verdict = band(request, s);
  view.session.record(request, p);
  const value = score(s);
  const ambiguous = request.route === "network" && !strongOverlap(s) && value >= ALLOW_BELOW && value < ASK_FROM;
  return { band: verdict, ambiguous, request, signals: s, score: Number(value.toFixed(3)), reason: verdict === "allow" ? null : reasonFor(s) };
}

// ---- Ingestion -------------------------------------------------------------

/** Tools whose result is a file's text, once `mcp__brain__`/`mcp__brain-ui__` is removed, and the input key naming the file. */
const READ_TOOLS: Record<string, string> = { Read: "file_path", read_file: "path", read: "path", brain_read: "path", brain_read_base: "path", brain_read_many: "paths" };

/** The file a read tool names, or null when the tool reads no file. */
export function readPath(tool: string, input: unknown): string | null {
  const key = READ_TOOLS[tool.replace(/^mcp__brain(?:-ui)?__/, "")];
  if (!key || !input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : Array.isArray(value) ? value.filter(v => typeof v === "string").join(", ") || null : null;
}

/** A read result's text: string values of a JSON result, without a file viewer's line-number gutter. */
export function readText(output: string): string {
  let texts: string[] = [output];
  try {
    const parsed: unknown = JSON.parse(output);
    texts = [];
    const collect = (value: unknown, depth: number): void => {
      if (depth > 8) return;
      if (typeof value === "string") texts.push(value);
      else if (Array.isArray(value)) for (const item of value) collect(item, depth + 1);
      else if (value && typeof value === "object") for (const item of Object.values(value)) collect(item, depth + 1);
    };
    collect(parsed, 0);
  } catch { /* Plain text. */ }
  return texts.join("\n").replace(/^ *\d+(?:\t|→)/gm, "");
}

const NOT_HOSTS = new Set(["md", "txt", "json", "ts", "js", "tsx", "jsx", "png", "jpg", "jpeg", "gif", "svg", "pdf", "html", "htm", "yaml", "yml", "csv", "py", "sh", "css", "lock", "toml", "log"]);
/** Hosts a piece of content names: every URL's host and bare domain names. */
export function namedHosts(text: string): string[] {
  const hosts = new Set<string>();
  for (const match of text.matchAll(URL_RE)) { const url = splitUrl(match[0]); if (url) hosts.add(url.host); }
  for (const match of text.matchAll(/(?<![\w@.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))(?![\w-])/gi)) {
    if (!NOT_HOSTS.has(match[2]!.toLowerCase())) hosts.add(match[1]!.toLowerCase());
  }
  return [...hosts];
}
