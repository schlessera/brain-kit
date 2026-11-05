/** Data-only, authorized startup orientation. Never import the brain's config or skills. */
import { constants } from "node:fs";
import { open, opendir, realpath, lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { openGovernancePolicyAnchored, parseGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { projectConversationGuidance } from "@schlessera/brain-ui-sdk/internal";
import type { ConversationOrientation } from "@schlessera/brain-ui-sdk/server";
import { readAnchoredSnapshot, safeResolve } from "../files/walker.js";
import type { WsHost } from "../ws/host.js";

const SOURCE_BYTES = 65_536;
const MAP_ROOT_ENTRIES = 64, MAP_SOURCES = 9, MAP_SOURCE_BYTES = 8_192, MAP_TEXT_BYTES = 900;
const TOOLING_ROOTS = new Set(["node_modules", "skills", "scripts", "src", "packages", "tests", "dist", "build", "coverage", "tmp", "vendor", "workspaces"]);

/** Same containment and anchored descriptor reader as the file surface; a stricter byte cap. */
async function source(root: string, path: string, anchor: string, maxBytes = SOURCE_BYTES): Promise<string> {
  const abs = await safeResolve(path, root);
  const snapshot = readAnchoredSnapshot(join(anchor, path), anchor, path, maxBytes);
  if (snapshot) return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
  // Non-Linux follows the existing file surface's containment policy, without
  // allocating an unbounded file if it grows between stat and read.
  const file = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw Error("Orientation source unavailable");
    const data = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > maxBytes) throw Error("Orientation source unavailable");
    return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytesRead));
  } finally { await file.close(); }
}

/** Existing index prose only: never a generated registry, code block or inferred taxonomy. */
function indexPurpose(text: string): string | undefined {
  const parsed = parseFrontmatter(text, { dataOnly: true });
  const prose = parsed.content.split(/^\s*(?:#{2,6}\s|\||```|~~~|<!--)/mu)[0]!.replace(/^#\s+[^\n]*(?:\n|$)/u, "").trim();
  const candidates = [typeof parsed.data.summary === "string" ? parsed.data.summary.trim() : "", ...prose.split(/\n\s*\n/u)];
  return candidates.find(value => value && Buffer.byteLength(value, "utf8") <= 240)?.replace(/\s+/gu, " ");
}

/** A bounded shallow sample, enumerated through the SAME held root as policy and reads. */
async function observedMap(anchor: string, read: (path: string, maxBytes?: number) => Promise<string>, authorized: () => boolean): Promise<{
  entry?: ConversationOrientation["knowledge"][number]; gap?: string;
}> {
  // Other platforms have no descriptor-relative directory enumeration here.
  // Do not substitute an enumeration of the mutable configured root path.
  if (process.platform !== "linux") return { gap: "content map: anchored enumeration unavailable; explore through host" };
  let inspected = 0, capped = true;
  const names: string[] = [];
  const directory = await opendir(anchor, { bufferSize: 1 });
  try {
    for (; inspected < MAP_ROOT_ENTRIES; inspected++) {
      if (!authorized()) throw Error("Orientation authorization ended");
      const entry = await directory.read();
      if (!entry) { capped = false; break; }
      if (!entry.isDirectory() || entry.name.startsWith(".") || TOOLING_ROOTS.has(entry.name.toLowerCase())
        || /[:\\\p{Cc}\p{Cf}]/u.test(entry.name) || Buffer.byteLength(entry.name) > 96) continue;
      names.push(entry.name);
    }
  } finally { await directory.close(); }
  names.sort();
  const candidates = ["_index.md", ...names.map(name => `${name}/_index.md`)];
  const leads: string[] = [];
  let attempted = 0, unavailable = 0;
  for (const path of candidates.slice(0, MAP_SOURCES)) {
    if (!authorized()) throw Error("Orientation authorization ended");
    attempted++;
    try {
      const purpose = indexPurpose(await read(path, MAP_SOURCE_BYTES));
      if (purpose) leads.push(JSON.stringify({ path, purpose }));
      else unavailable++;
    } catch { unavailable++; }
  }
  const prefix = "OBSERVED partial content map: existing _index.md purpose/summary leads, not runtime taxonomy.";
  const rows: string[] = [];
  const footer = (omitted: number) => `Coverage: ${inspected} root entries inspected${capped ? " (entry cap reached)" : ""}; ${attempted} index sources attempted; ${unavailable} missing/unreadable/malformed/oversized or without a short lead; ${omitted} omitted by count/bytes. Hidden/tooling/link roots, deeper directories, registry tables and other files excluded. Explore gaps through host.`;
  // Reserve complete coverage/omission labels before selecting whole path/purpose rows.
  const omittedByCount = Math.max(0, candidates.length - MAP_SOURCES);
  for (const lead of leads) {
    const candidate = [prefix, ...rows, lead, footer(omittedByCount + leads.length)].join("\n\n");
    if (Buffer.byteLength(candidate) <= MAP_TEXT_BYTES) rows.push(lead);
  }
  if (!rows.length) return { gap: `content map: 0 leads; ${attempted} sources, ${unavailable} unavailable, ${omittedByCount + leads.length} omitted${capped ? "; scan capped" : ""}; host lookup` };
  return { entry: { source: "observed root/top-level _index.md leads", topic: "content_map",
    text: [prefix, ...rows, footer(omittedByCount + leads.length - rows.length)].join("\n\n") } };
}

/** The same data-only policy parser, pinned to the collection's held root. */
function providerPolicy(root: string): { hash: string | null; withheld: boolean } {
  try {
    const handle = openGovernancePolicyAnchored(root);
    try {
      if (handle.bytes === null) return { hash: null, withheld: false };
      const checked = parseGovernancePolicy(handle.bytes);
      return { hash: checked.content_hash, withheld: !checked.ok || checked.effective.providers.length > 0 };
    } finally { handle.close(); }
  } catch (error) {
    return { hash: null, withheld: (error as NodeJS.ErrnoException).code !== "ENOENT" };
  }
}

/** Called only after disclosure/Start. Missing sources are gaps, never invented context. */
export async function readConversationOrientation(host: WsHost, target: { sessionId?: string; agentProviderId?: string },
  authorized: () => boolean): Promise<ConversationOrientation> {
  if (!authorized()) return { guidance: [], knowledge: [], unavailable: ["authorization ended"] };
  const guidance: ConversationOrientation["guidance"][number][] = [];
  const knowledge: ConversationOrientation["knowledge"][number][] = [];
  const unavailable: string[] = [];
  try {
    const backend = target.sessionId
      ? await host.registry.getBackendForSession(host.catalog.getStoredBackendId(target.sessionId))
      : target.agentProviderId ? await host.registry.getBackendForProfile(target.agentProviderId) : await host.registry.getDefaultBackend();
    if (!authorized()) return { guidance: [], knowledge: [], unavailable: ["authorization ended"] };
    guidance.push(...backend?.conversationGuidance ?? []);
    if (!backend?.conversationGuidance?.length) unavailable.push("configured append: guidance absent or withheld");
  } catch { unavailable.push("configured append unavailable"); }
  const rootPath = host.brainPath;
  if (!rootPath || !authorized()) return { guidance, knowledge, unavailable: [...unavailable, "brain sources unavailable"] };
  const configuredCount = guidance.length;
  const withheld = (): ConversationOrientation => ({ guidance: guidance.slice(0, configuredCount), knowledge: [],
    unavailable: ["repository orientation changed or withheld; retrieve through host"] });
  let held: FileHandle | undefined;
  try {
    const root = await realpath(rootPath);
    held = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = await held.stat();
    // Policy and content traverse the same root descriptor on Linux, including
    // a temporary replacement restored before the final identity check.
    const anchor = process.platform === "linux" ? `/proc/self/fd/${held.fd}/.` : root;
    let changed = false;
    const unchanged = async (): Promise<boolean> => {
      try {
        const canonical = await realpath(rootPath), named = await lstat(root);
        if (canonical !== root || !named.isDirectory() || named.dev !== identity.dev || named.ino !== identity.ino) changed = true;
      } catch { changed = true; }
      return !changed;
    };
    if (!authorized() || !await unchanged()) return withheld();
    const before = providerPolicy(anchor);
    // No admitted taxonomy worker resolves provider/type rules at startup.
    if (before.withheld) return { guidance, knowledge, unavailable: [...unavailable,
      "repository orientation withheld by provider policy; retrieve through host"] };
    const read = async (path: string, maxBytes = SOURCE_BYTES): Promise<string> => {
      if (!authorized() || !await unchanged()) throw Error("Orientation source changed");
      const text = await source(root, path, anchor, maxBytes);
      if (!authorized() || !await unchanged()) throw Error("Orientation source changed");
      return text;
    };
    if (!authorized()) return { guidance: [], knowledge: [], unavailable: ["authorization ended"] };
    // Put the map first among knowledge, so supplemental leads are shed first
    // under aggregate pressure. Whole selected guidance still has priority.
    const map = await observedMap(anchor, read, authorized);
    if (map.entry) knowledge.push(map.entry);
    if (map.gap) unavailable.push(map.gap);
    const domains = new Set<string>();
    for (const path of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        const text = await read(path);
        if (!authorized()) break;
        const selected = projectConversationGuidance(text, path);
        guidance.push(...selected);
        if (!selected.length) unavailable.push(`${path}: guidance absent or withheld`);
        for (const match of text.matchAll(/<!--\s*brain:generated:module-([a-z][a-z0-9-]{0,30})\s*-->/gu)) domains.add(match[1]!);
      } catch { unavailable.push(`${path}: missing, unreadable or too large`); }
    }
    if (domains.size) knowledge.push({ source: "root module instruction regions", topic: "domains", text: [...domains].sort().join(", ") });
    else unavailable.push("domain modules not supplied; ask the host when relevant");

    // JSON is safe to inspect as data. TS precedence is respected: when it
    // exists, don't pretend its runtime taxonomy was evaluated by the host.
    let paths: Record<string, unknown> = { identity: "me/identity.md", currentFocus: "context/current-focus.md" };
    let conventional = true;
    let hasTypeScript = false;
    try { await lstat(join(anchor, "brain.config.ts")); hasTypeScript = true; } catch { /* no readable TS configuration */ }
    if (!hasTypeScript) {
      try {
        const config = JSON.parse(await read("brain.config.json"));
        paths = { ...paths, ...config?.taxonomy?.canonical }; conventional = false;
      } catch { /* Conventional candidates are explicitly qualified below. */ }
    }
    if (conventional) unavailable.push("runtime canonical paths not evaluated; conventional identity/focus candidates only");
    for (const [key, topic] of [["identity", "identity"], ["currentFocus", "current_focus"]] as const) {
      const path = paths[key];
      if (typeof path !== "string" || !path || !/\.md$/iu.test(path)) { unavailable.push(`${topic}: disabled or invalid canonical path`); continue; }
      try {
        const parsed = parseFrontmatter(await read(path), { dataOnly: true });
        const text = [typeof parsed.data.summary === "string" ? parsed.data.summary : "", parsed.content.split(/^##\s/mu)[0]!.trim()].filter(Boolean).join("\n\n");
        if (!text) { unavailable.push(`${topic}: empty lead`); continue; }
        knowledge.push({ source: `${conventional ? "conventional " : "canonical "}${path}`, topic, text });
      } catch { unavailable.push(`${topic}: missing, unreadable or too large`); }
    }
    const after = providerPolicy(anchor);
    if (!authorized() || !await unchanged() || after.withheld || after.hash !== before.hash) return withheld();
    // Imports, other sections, skill bodies and full documents remain host-side.
    unavailable.push("unselected instructions, imports, skills and document sections remain with host");
    return { guidance, knowledge, unavailable };
  } catch { return withheld(); }
  finally { await held?.close(); }
}
