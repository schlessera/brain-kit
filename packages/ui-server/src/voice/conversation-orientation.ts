/** Data-only, authorized startup orientation. Never import the brain's config or skills. */
import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { openGovernancePolicyAnchored, parseGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { projectConversationGuidance } from "@schlessera/brain-ui-sdk/internal";
import type { ConversationOrientation } from "@schlessera/brain-ui-sdk/server";
import { readAnchoredSnapshot, safeResolve } from "../files/walker.js";
import type { WsHost } from "../ws/host.js";

const SOURCE_BYTES = 65_536;

/** Same containment and anchored descriptor reader as the file surface; a stricter byte cap. */
async function source(root: string, path: string, anchor: string): Promise<string> {
  const abs = await safeResolve(path, root);
  const snapshot = readAnchoredSnapshot(join(anchor, path), anchor, path, SOURCE_BYTES);
  if (snapshot) return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
  // Non-Linux follows the existing file surface's containment policy, without
  // allocating an unbounded file if it grows between stat and read.
  const file = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > SOURCE_BYTES) throw Error("Orientation source unavailable");
    const data = Buffer.alloc(SOURCE_BYTES + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > SOURCE_BYTES) throw Error("Orientation source unavailable");
    return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytesRead));
  } finally { await file.close(); }
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
    const read = async (path: string): Promise<string> => {
      if (!authorized() || !await unchanged()) throw Error("Orientation source changed");
      const text = await source(root, path, anchor);
      if (!authorized() || !await unchanged()) throw Error("Orientation source changed");
      return text;
    };
    if (!authorized()) return { guidance: [], knowledge: [], unavailable: ["authorization ended"] };
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
    try { await lstat(await safeResolve("brain.config.ts", root)); hasTypeScript = true; } catch { /* no readable TS configuration */ }
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
