import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { GovernancePolicySchema, parseGovernancePolicy, resolveGovernancePolicy } from "../src/governance-policy";
import { canonicalTrustHost, parseTrustOrigin, parseTrustTunnel, parseTrustGithub, TrustedSourcesSchema, TrustRuleSchema,
  TrustSelectorSchema, TrustProvenanceSchema, matchTrustRules, TRUST_RUNTIME_CAPABILITIES, TRUST_LIMITS,
  type TrustProvenance, type TrustRule, type TrustVerification } from "../src/taint-trust";

const origin = parseTrustOrigin("https://ithaca.example");
const admission = { phase: "prospective_admission" as const, trustRevision: "3", collectionRevision: "9", policyHash: "a".repeat(64) };
const webProof = { kind: "web_origin" as const, origin, verifiedBy: "host_transport" as const };
const source = TrustRuleSchema.parse({ id: "odysseus", label: "Ithaca", selector: origin });
const gitRule = TrustRuleSchema.parse({ id: "athena", label: "Navigation", selector: { kind: "github_repository", host: "github.com", owner: "odysseus", repository: "navigation", repositoryId: "42" } });
const gitProof: TrustProvenance = { kind: "github_read", repository: { kind: "github_repository", host: "github.com", owner: "odysseus", repository: "navigation", repositoryId: "42" },
  ownerId: "7", ref: "refs/heads/main", commit: "c".repeat(40), acquisitionId: "acquired", contentHash: "b".repeat(64), immutable: true, verifiedBy: "managed_acquisition" };
const verified = (p: TrustProvenance): TrustVerification => p.kind === "web_origin" ? { kind: "host_transport" } : p.kind === "tunnel_authority" ? { kind: "host_proxy" }
  : { kind: "managed_acquisition", currentIdentity: true, approvedOwnerBoundary: true, sameOwnerRenameRevalidated: false };
const match = (rules: TrustRule[], p: unknown, capability: "incomingContent" | "recipientWhileRestricted" = "incomingContent", verify = verified) => matchTrustRules(rules, p, capability, admission, verify);

// These fixtures pin the installed URL implementation, rather than relying on a remembered IDNA API.
test("origins canonicalize IDNA, case, one DNS dot and explicit effective ports", () => {
  expect(parseTrustOrigin("HTTPS://ITHACA.EXAMPLE.:443/")).toEqual(origin);
  expect(parseTrustOrigin("http://ithaca.example")).toEqual({ ...origin, scheme: "http", port: 80 });
  expect(parseTrustOrigin("https://itháca.example").host).toBe("xn--ithca-zqa.example");
  expect(parseTrustOrigin("https://itha\u0301ca.example").host).toBe("xn--ithca-zqa.example");
  expect(parseTrustOrigin("https://127.0.0.1").host).toBe("127.0.0.1");
  expect(parseTrustOrigin("https://[2001:db8::1]:8443")).toEqual({ kind: "web_origin", scheme: "https", host: "[2001:db8::1]", port: 8443 });
  expect(parseTrustOrigin("http://ithaca.example:1").port).toBe(1);
  expect(parseTrustTunnel("[::1]:65535").port).toBe(65535);
  expect(parseTrustTunnel("ITHACA.EXAMPLE.:443")).toEqual({ kind: "tunnel_authority", host: "ithaca.example", port: 443 });
});
test("origin and tunnel syntax refuse spoofing, ambiguous IPs and URL parser repairs", () => {
  for (const value of ["https://ithaca.example/path", "https://ithaca.example//", "https://ithaca.example?", "https://ithaca.example#", "https://user@ithaca.example", "https://@ithaca.example",
    "https://*.ithaca.example", "https://ithaca..example", "https://ithaca.example..", "https://ithaca%2eexample", "https://ithaca.example\\", "https://ithaca.example\n", " https://ithaca.example",
    "https://127.1", "https://0177.0.0.1", "https://0x7f000001", "https://2130706433", "https://[::ffff:127.0.0.1]", "https://[2001:0db8::1]", "https://[fe80::1%25eth0]",
    "https://ithaca.example:0", "https://ithaca.example:65536", "https://ithaca.example:", "ftp://ithaca.example", "https:ithaca.example", "https://-ithaca.example", `https://${"a".repeat(64)}.example`])
    expect(() => parseTrustOrigin(value), value).toThrow();
  for (const value of ["ithaca.example", "https://ithaca.example:443", "ithaca.example:443/", "user@ithaca.example:443", "::1:443", "ithaca.example:0", "ithaca.example:65536"])
    expect(() => parseTrustTunnel(value), value).toThrow();
  expect(() => canonicalTrustHost(`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`)).toThrow();
});
test("exact origins and opaque tunnels never borrow each other's source or recipient capability", () => {
  expect(match([source], webProof)?.ruleId).toBe(source.id);
  for (const altered of [{ ...origin, scheme: "http" }, { ...origin, port: 8443 }, { ...origin, host: "sub.ithaca.example" }, { ...origin, host: "ithaca.example.evil.example" }])
    expect(match([source], { ...webProof, origin: altered })).toBeNull();
  const tunnel = parseTrustTunnel("ithaca.example:443");
  const p = { kind: "tunnel_authority", authority: tunnel, verifiedBy: "host_proxy" };
  expect(match([source], p)).toBeNull();
  const tunnelRule = TrustRuleSchema.parse({ ...source, selector: tunnel });
  expect(match([tunnelRule], webProof)).toBeNull();
  expect(match([tunnelRule], p)?.ruleId).toBe(source.id);
});
test("incoming-only trust cannot grant recipient approval after unrelated taint", () => {
  expect(source.incomingContent).toBe(true);
  expect(source.recipientWhileRestricted).toBe(false);
  expect(match([source], webProof, "recipientWhileRestricted")).toBeNull();
  const recipient = TrustRuleSchema.parse({ ...source, incomingContent: false, recipientWhileRestricted: true });
  expect(match([recipient], webProof, "incomingContent")).toBeNull();
  expect(match([recipient], webProof, "recipientWhileRestricted")?.capability).toBe("recipientWhileRestricted");
  expect(match([gitRule], gitProof, "recipientWhileRestricted")).toBeNull();
});
test("worker claims, null, stale or wrong host authority never self-verify", () => {
  expect(matchTrustRules([source], webProof, "incomingContent", admission)).toBeNull();
  for (const p of [null, {}, { ...webProof, verifiedBy: "worker" }, { ...webProof, extra: true }, { ...webProof, origin: { ...origin, extra: true } }]) expect(match([source], p)).toBeNull();
  expect(match([source], webProof, "incomingContent", () => ({ kind: "unknown" }))).toBeNull();
  expect(match([source], webProof, "incomingContent", () => ({ kind: "host_proxy" }))).toBeNull();
  expect(match([gitRule], gitProof, "incomingContent", () => ({ kind: "unknown" }))).toBeNull();
  for (const patch of [{ currentIdentity: false }, { approvedOwnerBoundary: false }])
    expect(match([gitRule], gitProof, "incomingContent", () => ({ ...verified(gitProof), ...patch }) as TrustVerification)).toBeNull();
  expect(TRUST_RUNTIME_CAPABILITIES).toMatchObject({ originRules: false, repositoryRules: false, recipientRules: false });
});
test("GitHub names have exact host and segment boundaries and normalize a single git suffix", () => {
  expect(parseTrustGithub("https://github.com/Odysseus/Navigation.git")).toEqual({ host: "github.com", owner: "odysseus", repository: "navigation" });
  expect(parseTrustGithub("Odysseus")).toEqual({ host: "github.com", owner: "odysseus" });
  expect(parseTrustGithub("odysseus/navigation.git.git").repository).toBe("navigation.git");
  for (const name of ["https://github.com.evil.example/odysseus/navigation", "https://github.com:443/odysseus/navigation", "https://odysseus@github.com/navigation", "http://github.com/odysseus/navigation",
    "git@github.com:odysseus/navigation", "ssh://github.com/odysseus/navigation", "ext::git", "odysseus/navigation/extra", "odysseus/navigation/", "odysseus/navigation?x", "odysseus/navigation#x", "odysseus/nav%2figation",
    "odysseus/nav\\igation", "odysseus/..", "-odysseus/navigation", "odysseus-/navigation", "ody--sseus/navigation", "οdysseus/navigation", `${"a".repeat(40)}/navigation`, `odysseus/${"a".repeat(101)}`])
    expect(() => parseTrustGithub(name), name).toThrow();
});
test("exact repository requires stable ID and approved current owner; rename needs authoritative revalidation", () => {
  expect(match([gitRule], gitProof)?.ruleId).toBe(gitRule.id);
  for (const patch of [{ owner: "odysseus-other" }, { owner: "ody" }, { repositoryId: "43" }, { repository: "navigation-other" }])
    expect(match([gitRule], { ...gitProof, repository: { ...gitProof.repository, ...patch } })).toBeNull();
  const renamed = { ...gitProof, repository: { ...gitProof.repository, repository: "voyage" } };
  expect(match([gitRule], renamed)).toBeNull();
  expect(match([gitRule], renamed, "incomingContent", () => ({ kind: "managed_acquisition", currentIdentity: true, approvedOwnerBoundary: true, sameOwnerRenameRevalidated: true }))?.ruleId).toBe(gitRule.id);
  expect(match([gitRule], { ...renamed, repository: { ...renamed.repository, owner: "poseidon" } }, "incomingContent",
    () => ({ kind: "managed_acquisition", currentIdentity: true, approvedOwnerBoundary: true, sameOwnerRenameRevalidated: true }))).toBeNull();
});
test("owner namespace includes future repositories, but never prefix owners, transfers or namespace reuse", () => {
  const ownerRule = TrustRuleSchema.parse({ ...gitRule, selector: { kind: "github_owner", host: "github.com", owner: "odysseus", ownerId: "7" } });
  expect(match([ownerRule], { ...gitProof, repository: { ...gitProof.repository, repository: "future-voyage", repositoryId: "99" } })?.ruleId).toBe(ownerRule.id);
  for (const p of [{ ...gitProof, ownerId: "8" }, { ...gitProof, repository: { ...gitProof.repository, owner: "odysseus-other" } }]) expect(match([ownerRule], p)).toBeNull();
  expect(match([ownerRule], webProof, "recipientWhileRestricted")).toBeNull();
});
test("managed immutable ordinary-ref proofs refuse PR refs, mutable bytes and malformed stable IDs", () => {
  for (const patch of [{ immutable: false }, { verifiedBy: "worker" }, { ownerId: "0" }, { ownerId: "07" }, { ownerId: "1".repeat(21) }, { commit: "A".repeat(40) }, { acquisitionId: "../acquired" },
    { ref: "refs/pull/1/head" }, { ref: "refs/heads/../main" }, { ref: "refs/heads/main.lock" }, { ref: "refs/heads/a//b" }, { ref: "refs/heads/.hidden" }, { ref: "refs/heads/a@{b" }, { ref: "refs/heads/a " }])
    expect(match([gitRule], { ...gitProof, ...patch })).toBeNull();
  for (const ref of ["refs/heads/main", "refs/tags/voyage-1", "refs/heads/voyage/ithaca"]) {
    const result = spawnSync("git", ["check-ref-format", ref]);
    expect(result.status).toBe(0);
    expect(TrustProvenanceSchema.safeParse({ ...gitProof, ref }).success).toBe(true);
  }
});
test("strict policy defaults, duplicate identities and UTF-8/record bounds", () => {
  expect(resolveGovernancePolicy({ schema_version: 1 }).taint.trusted_sources).toEqual([]);
  expect(GovernancePolicySchema.parse({ schema_version: 1, taint: { trusted_sources: [source] } }).taint?.trusted_sources).toEqual([source]);
  const reordered = { port: 443, host: "ithaca.example", kind: "web_origin", scheme: "https" };
  for (const rules of [[source, { ...source, id: "other", label: "Different", selector: reordered }], [source, { ...source, selector: parseTrustOrigin("https://troy.example") }]])
    expect(TrustedSourcesSchema.safeParse(rules).success).toBe(false);
  for (const rule of [{ ...source, extra: true }, { ...source, incomingContent: false }, { ...gitRule, recipientWhileRestricted: true }, { ...gitRule, incomingContent: false }, { ...source, label: "é".repeat(65) }, { ...source, id: "a".repeat(129) }])
    expect(TrustRuleSchema.safeParse(rule).success).toBe(false);
  expect(TrustedSourcesSchema.safeParse([source, { ...source, id: "recipient-duplicate", incomingContent: false, recipientWhileRestricted: true }]).success).toBe(false);
  for (const repositoryId of ["0", "042", "42.0", "1".repeat(21)])
    expect(TrustSelectorSchema.safeParse({ ...gitRule.selector, repositoryId }).success).toBe(false);
  expect(TrustRuleSchema.safeParse({ ...source, label: "é".repeat(64) }).success).toBe(true);
  expect(TrustSelectorSchema.safeParse({ ...origin, host: "ITHACA.EXAMPLE" }).success).toBe(false);
  const rules = Array.from({ length: 256 }, (_, i) => ({ ...source, id: `voyage-${i}`, selector: parseTrustOrigin(`https://voyage-${i}.example`) }));
  expect(TrustedSourcesSchema.safeParse(rules).success).toBe(true);
  expect(TrustedSourcesSchema.safeParse([...rules, { ...source, id: "overflow" }]).success).toBe(false);
  const large = rules.map((r, i) => ({ ...r, id: `large-${i}`, label: "\u0000".repeat(128), selector: parseTrustOrigin(`https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${i}.${"d".repeat(48)}`) }));
  expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeGreaterThan(262144);
  expect(TrustedSourcesSchema.safeParse(large).success).toBe(false);
  expect(TrustSelectorSchema.safeParse({ ...origin, host: "a".repeat(1025) }).success).toBe(false);
  for (const selector of [{ ...gitRule.selector, repository: "renamed" }, { ...gitRule.selector, repositoryId: "43" }])
    expect(TrustedSourcesSchema.safeParse([gitRule, { ...gitRule, id: "other", selector }]).success).toBe(false);
  expect(TRUST_LIMITS).toEqual({ rules: 256, selectorBytes: 1024, sectionBytes: 262144, labelBytes: 128 });
});
test("prospective match audit survives rule deletion and retains immutable admission facts", () => {
  // A private copy: mutating the shared fixture would leak into every later test if an assertion failed first.
  const rules = [structuredClone(source)];
  const proof = structuredClone(webProof);
  const audit = match(rules, proof)!;
  expect(audit).toEqual({ ruleId: source.id, capability: "incomingContent", trustRevision: "3", collectionRevision: "9", policyHash: "a".repeat(64), provenance: webProof });
  rules.splice(0); proof.origin.port = 8443;
  expect(match(rules, proof)).toBeNull();
  expect(audit.provenance).toEqual({ ...webProof, origin: { ...origin, port: 443 } });
  expect(audit).toMatchObject({ trustRevision: "3", collectionRevision: "9", policyHash: "a".repeat(64) });
  for (const bad of [{ ...admission, phase: "historical" }, { ...admission, trustRevision: "oops" }, { ...admission, trustRevision: "1.5" }, { ...admission, trustRevision: "1".repeat(200) }, { ...admission, trustRevision: "03" }, { ...admission, trustRevision: "18446744073709551616" }, { ...admission, collectionRevision: "-1" }, { ...admission, policyHash: "" }])
    expect(matchTrustRules([source], webProof, "incomingContent", bad as typeof admission, verified)).toBeNull();
});
test("frontmatter parser reports trust defaults and invalid-policy fallback without adding legacy egress authority", () => {
  const bytes = (data: unknown) => new TextEncoder().encode(`---\n${JSON.stringify(data)}\n---\nOdysseus policy.\n`);
  const valid = parseGovernancePolicy(bytes({ schema_version: 1, taint: { trusted_sources: [source] } }));
  expect(valid.ok).toBe(true);
  expect(valid.effective.taint).toEqual({ egress: { allow: [] }, trusted_sources: [source] });
  const invalid = parseGovernancePolicy(bytes({ schema_version: 1, taint: { trusted_sources: [source, source] } }));
  expect(invalid.ok).toBe(false);
  expect(invalid.errors.join(" ")).toContain("Duplicate trust");
  expect(invalid.effective.taint.trusted_sources).toEqual([]);
});
