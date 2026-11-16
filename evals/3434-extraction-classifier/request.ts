import type { CallInput, OutgoingRequest } from "./schema";

/** brain-kit's own MCP servers open no outside connection. */
const LOCAL_MCP_SERVERS = new Set(["brain", "brain-ui"]);
const URL_RE = /https?:\/\/[^\s'"<>()`]+/g;

/** Shell words, honouring quotes, backslashes and a `<<<` here-string. Enough for authored commands, not a shell. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let started = false;
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
    if (/\s/.test(c)) {
      if (started) words.push(word);
      word = ""; started = false;
      continue;
    }
    word += c; started = true;
  }
  if (started) words.push(word);
  return words;
}

function splitUrl(raw: string): { host: string; path: string; query: string } | null {
  try {
    const url = new URL(raw);
    return { host: url.hostname.toLowerCase(), path: url.pathname, query: url.search.replace(/^\?/, "") };
  } catch {
    return null;
  }
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
  let method = "GET";
  let explicit: string | null = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    if ((w === "-X" || w === "--request" || w === "--method") && next) { explicit = next.toUpperCase(); i++; continue; }
    if (/^-X[A-Z]+$/.test(w)) { explicit = w.slice(2); continue; }
    if (CURL_DATA.has(w) && next !== undefined && words[0] === "curl") {
      data.push(next);
      method = w === "-T" || w === "--upload-file" ? "PUT" : "POST";
      i++;
      continue;
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
  const refs = words.map(pathRef).filter((p): p is string => p !== null);
  const body = command;
  const query = urls.reduce((n, u) => n + u.query.length, 0);
  return {
    method,
    hosts: [...hosts],
    urls,
    body,
    pathRefs: [...new Set(refs)],
    bytes: { query, body: data.reduce((n, d) => n + Buffer.byteLength(d), 0) },
  };
}

function argStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(argStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(argStrings);
  return value === undefined || value === null ? [] : [String(value)];
}

/** The request the classifier scores, built from what the admission point already holds. */
export function toRequest(call: CallInput): OutgoingRequest {
  const base = { surface: call.surface, tool: call.tool, toolClass: call.toolClass };
  if (call.surface === "web_fetch") {
    const url = splitUrl(call.url ?? "");
    return {
      ...base, route: "network", method: "GET",
      hosts: url ? [url.host] : [], urls: url ? [url] : [],
      // The prompt goes to the fetch summarizer on the conversation's own provider, never to the destination.
      body: "", pathRefs: [], bytes: { query: url?.query.length ?? 0, body: 0 },
    };
  }
  if (call.surface === "provider_relay") {
    const body = argStrings(call.args).join("\n");
    return {
      ...base, route: "relay", method: "POST", hosts: call.relayHost ? [call.relayHost] : [], urls: [],
      body, pathRefs: [], bytes: { query: 0, body: Buffer.byteLength(body) },
    };
  }
  if (call.surface === "mcp") {
    const server = call.tool.split("__")[1] ?? "";
    const strings = argStrings(call.args);
    const body = strings.join("\n");
    const urls = strings.flatMap(s => [...s.matchAll(URL_RE)].map(m => splitUrl(m[0]))).filter(u => u !== null);
    const local = LOCAL_MCP_SERVERS.has(server);
    return {
      ...base, route: local ? "local" : "network",
      method: call.toolClass === "outward" ? "POST" : "GET",
      hosts: local ? [] : urls.length ? [...new Set(urls.map(u => u.host))] : [`mcp.${server}`],
      urls, body, pathRefs: strings.map(pathRef).filter((p): p is string => p !== null),
      bytes: { query: 0, body: Buffer.byteLength(body) },
    };
  }
  const shell = bashRequest(call.command ?? "");
  const local = call.surface === "brain_cli" && shell.hosts.length === 0;
  return { ...base, route: local ? "local" : "network", ...shell };
}
