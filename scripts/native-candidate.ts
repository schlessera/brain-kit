/** Native confirmation binds an explicit request, not a later live stack. */
import { randomBytes } from "node:crypto";
import { checkout, git, type Checkout } from "./proof-inputs";
import type { API } from "./proof-reuse";

interface Member { number: number; ref: string; head: string; parent: string; }
export interface NativePrefix {
  version: 1; request: string; repository: string; pr: number; stack: number; position: number;
  trunk: { ref: string; sha: string }; members: Member[];
}
const marker = /<!-- brain-native-candidate: ([A-Za-z0-9_-]+) -->/g;
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const number = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const ref = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) &&
  !value.includes("..") && !value.includes("//") && !value.endsWith("/") && !value.endsWith(".lock");
const fail = (reason: string): never => { throw new Error(`Native candidate rejected: ${reason}`); };

export function nativeRequest(body: unknown): NativePrefix {
  const matches = [...String(body ?? "").matchAll(marker)];
  if (matches.length !== 1 || matches[0]![1]!.length > 16000) fail("freeze the contributing prefix with bun scripts/request-candidate.ts before requesting confirmation");
  let value: NativePrefix;
  try { value = JSON.parse(Buffer.from(matches[0]![1]!, "base64url").toString("utf8")); }
  catch { return fail("malformed prefix request"); }
  if (!value || value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.request) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) ||
      !number(value.pr) || !number(value.stack) || !number(value.position) || !ref(value.trunk?.ref) || !sha(value.trunk?.sha) ||
      !Array.isArray(value.members) || !value.members.length || value.members.length > 6 ||
      value.members.some(m => !number(m.number) || !ref(m.ref) || !ref(m.parent) || !sha(m.head)) ||
      new Set(value.members.map(m => m.number)).size !== value.members.length ||
      new Set(value.members.map(m => m.ref)).size !== value.members.length ||
      new Set(value.members.map(m => m.head)).size !== value.members.length || value.members.at(-1)?.number !== value.pr ||
      value.members.some(m => m.ref === value.trunk.ref) ||
      value.members.some((m, i) => m.parent !== (i ? value.members[i - 1]!.ref : value.trunk.ref))) fail("invalid or unsupported prefix identity");
  return value;
}

export function nativeRequestBody(body: string, prefix: NativePrefix): string {
  return `${body.replace(marker, "").trimEnd()}\n\n<!-- brain-native-candidate: ${Buffer.from(JSON.stringify(prefix)).toString("base64url")} -->\n`;
}

/** Freeze only the live contributing prefix; callers put it in the ready event body. */
export async function freezeNativePrefix(repository: string, pr: number, api: API, allowTopDraft = false): Promise<NativePrefix> {
  const live = await api.json(`pulls/${pr}`);
  if (!number(live.stack?.number) || !number(live.stack?.position) || !ref(live.stack?.base?.ref)) fail("missing authoritative native membership");
  const stack = await api.json(`stacks/${live.stack.number}`);
  const all: Array<{ number: number; state: string; merged_at?: string }> = stack.pull_requests;
  if (stack.number !== live.stack.number || stack.base?.ref !== live.stack.base.ref || !Array.isArray(all) || all.length > 100 ||
      live.stack.size !== all.length || all.some(p => !number(p.number)) || new Set(all.map(p => p.number)).size !== all.length) fail("missing or contradictory stack API inventory");
  const index = all.findIndex(p => p.number === pr);
  if (index < 0 || index + 1 !== live.stack.position) fail("candidate membership/order changed");
  const before = all.slice(0, index + 1);
  if (before.some(p => p.state !== "open" && !(p.state === "closed" && Number.isFinite(Date.parse(p.merged_at ?? ""))))) fail("closed unmerged or unknown contributing member");
  const selected = before.filter(p => p.state === "open");
  if (!selected.length || selected.length > 6) fail("supported contributing prefix contains one to six open members");
  const trunk = { ref: stack.base.ref as string, sha: (await api.json(`git/ref/heads/${encodeURIComponent(stack.base.ref)}`)).object?.sha };
  if (!sha(trunk.sha) || live.stack.base.sha !== trunk.sha) fail("stack trunk is stale or unavailable; refresh the stack before requesting confirmation");
  const members: Member[] = [];
  for (const entry of selected) {
    const member = entry.number === pr ? live : await api.json(`pulls/${entry.number}`);
    const parent = members.at(-1);
    if (member.number !== entry.number || member.state !== "open" || (member.draft !== false && !(allowTopDraft && entry.number === pr && member.draft === true)) ||
        member.stack?.number !== stack.number || member.stack?.position !== all.findIndex(p => p.number === entry.number) + 1 ||
        member.stack?.base?.ref !== trunk.ref || member.stack?.base?.sha !== trunk.sha ||
        member.head?.repo?.full_name !== repository || member.base?.repo?.full_name !== repository || !ref(member.head?.ref) || !sha(member.head?.sha) ||
        member.base?.ref !== (parent?.ref ?? trunk.ref) || member.base?.sha !== (parent?.head ?? trunk.sha)) fail("contributing PR readiness, repository, parent or membership changed");
    if ((await api.json(`git/ref/heads/${encodeURIComponent(member.head.ref)}`)).object?.sha !== member.head.sha) fail("contributing live head changed");
    members.push({ number: entry.number, ref: member.head.ref, head: member.head.sha, parent: member.base.ref });
  }
  // Validate our own generated shape too; this rejects duplicate heads/refs.
  return nativeRequest(nativeRequestBody("", { version: 1, request: randomBytes(16).toString("hex"), repository, pr,
    stack: stack.number, position: index + 1, trunk, members }));
}

/** Bind request/event inputs before planning; live authority is checked separately. */
export function requestedNativePrefix(event: any, env: NodeJS.ProcessEnv): NativePrefix {
  const requested = nativeRequest(event.pull_request?.body);
  const pr = event.pull_request;
  if (requested.repository !== env.GITHUB_REPOSITORY || requested.pr !== pr?.number || requested.stack !== pr.stack?.number ||
      requested.position !== pr.stack?.position || requested.trunk.ref !== pr.stack?.base?.ref || requested.trunk.sha !== pr.stack?.base?.sha ||
      requested.members.at(-1)?.head !== pr.head?.sha) fail("request does not bind the triggering event");
  const parent = requested.members.at(-1)!;
  if (!number(pr.stack.size) || pr.stack.size < requested.position ||
      !((pr.base?.ref === requested.trunk.ref && pr.base?.sha === requested.trunk.sha) ||
        (pr.base?.ref === parent.parent && pr.base?.sha === ownNativeParent(requested))) ||
      (pr.head?.ref && pr.head.ref !== parent.ref) ||
      (pr.head?.repo?.full_name && pr.head.repo.full_name !== requested.repository)) fail("contradictory event parent or repository evidence");
  return requested;
}

/** Contract checks may inspect a draft; candidate proof always requires readiness. */
export async function verifyNativePrefix(event: any, env: NodeJS.ProcessEnv, api: API, allowTopDraft = false): Promise<NativePrefix> {
  const requested = requestedNativePrefix(event, env);
  const live = await freezeNativePrefix(requested.repository, requested.pr, api, allowTopDraft);
  if (JSON.stringify({ ...live, request: requested.request }) !== JSON.stringify(requested)) fail("contributing prefix changed; request confirmation again");
  const current = await api.json(`pulls/${requested.pr}`);
  if (JSON.stringify(nativeRequest(current.body)) !== JSON.stringify(requested)) fail("request was replaced or revoked");
  return requested;
}

export function ownNativeParent(prefix: NativePrefix): string {
  return prefix.members.at(-2)?.head ?? prefix.trunk.sha;
}

/** Supported native shape: a linear ORT merge chain rooted at the frozen trunk. */
export async function validateNativeCandidate(root: string, event: any, env: NodeJS.ProcessEnv, api: API, actual: Checkout): Promise<void> {
  if (actual.sha !== env.GITHUB_SHA) fail("checkout differs from the requested run identity");
  const prefix = await verifyNativePrefix(event, env, api);
  let next = actual.sha;
  for (let index = prefix.members.length - 1; index >= 0; index--) {
    const member = prefix.members[index]!;
    const local = checkout(root, next), immutable = await api.json(`git/commits/${next}`);
    if (local.sha !== immutable.sha || local.tree !== immutable.tree?.sha ||
        JSON.stringify(local.parents) !== JSON.stringify(immutable.parents?.map((p: { sha: string }) => p.sha)) || local.parents.length !== 2 || local.parents[1] !== member.head ||
        (index === prefix.members.length - 1 && JSON.stringify(local) !== JSON.stringify(actual))) fail("immutable synthetic checkout/parents do not match the ordered prefix");
    if (index) git(root, "merge-base", "--is-ancestor", prefix.members[index - 1]!.head, member.head);
    const tree = git(root, "merge-tree", "--write-tree", local.parents[0]!, member.head).trim();
    if (!sha(tree) || tree !== local.tree) fail("synthetic tree differs from the independently reconstructed ORT prefix merge");
    next = local.parents[0]!;
  }
  if (next !== prefix.trunk.sha) fail("synthetic chain does not terminate at the exact frozen trunk");
  console.log(`BRAIN_NATIVE_CANDIDATE_RECEIPT ${JSON.stringify({ prefix, checkout: actual })}`);
}
