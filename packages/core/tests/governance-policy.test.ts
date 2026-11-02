import { expect, test } from "bun:test";
import { parseGovernancePolicy, providerAllows } from "../src/lib/governance-policy";

const parse = (yaml: string, body = "Odysseus keeps policy prose separate.\n") => parseGovernancePolicy(Buffer.from(`---\nschema_version: 1\n${yaml}\n---\n${body}`));

test("strict policy schema refuses unknown keys at every depth, restricted profiles and tier A releases", () => {
  for (const yaml of ["unknown: true", "profiles: { voice: restricted }", "release: [.git/config]", "release: [.env.local]",
    "release: [brain.config.ts/child]", "release: [./brain.config.ts]", "protect: [../outside]", "protect: [/outside]",
    "budgets: { turn: { unknown: 1 } }", "scope: { max_tool_calls: -1 }", "providers: [{ paths: [me/**], allow: [anthropic], unknown: 1 }]"]) {
    expect(parse(yaml).ok, `POLICY_STRICT_REFUSAL: ${yaml}`).toBe(false);
  }
  expect(parse("release: [.git/config]").errors.join(" "), "POLICY_TIER_A_RELEASE_REFUSED").toContain("tier B");
  expect(parse("release: [.claude/settings.json, brain.config.ts]").ok).toBe(true);
});

test("raw-byte hash identifies ignored prose while frontmatter alone defines semantics", () => {
  const first = parse("profiles: { interactive: strict }");
  const second = parse("profiles: { interactive: strict }", "The reader revised this rationale.\n");
  expect(first.ok).toBe(true);
  expect(first.effective).toEqual(second.effective);
  expect(first.content_hash).not.toBe(second.content_hash);
  expect(parse("profiles: { interactive: strict }").content_hash).toBe(first.content_hash);
});

test("mixed regex lists preserve valid order and reasons; entirely invalid lists refuse", () => {
  const mixed = parse('commands:\n  deny:\n    - { pattern: "[", reason: "Broken" }\n    - { pattern: "^git push", reason: "Leaves the host" }');
  expect(mixed.ok).toBe(true);
  expect(mixed.warnings.join(" ")).toContain("commands.deny[0]");
  expect(mixed.effective.commands.deny).toEqual([{ pattern: "^git push", reason: "Leaves the host" }]);
  expect(parse('commands: { confirm: [{ pattern: "[" }] }').ok).toBe(false);
  expect(parse("commands: { confirm: [] }").ok).toBe(true);
});

test("approved defaults and individual explicit overrides resolve without sibling enforcement", () => {
  const parsed = parse("budgets: { turn: { block_usd: 300 } }\nscope: { max_tool_calls: 700 }");
  expect(parsed.effective.budgets).toEqual({ turn: { warn_usd: 100, block_usd: 300, block_tokens: 512_000_000 },
    session: { warn_usd: 2000, block_usd: 4000, block_tokens: 8_000_000_000 }, day: { warn_usd: 2000, block_usd: 4000, block_tokens: 8_000_000_000 } });
  expect(parsed.effective.scope).toEqual({ max_tool_calls: 700, max_minutes: 120, max_files_changed: 1000, max_bytes_written: 4 * 1024 ** 3 });
  expect(parsed.effective.profiles).toEqual({ interactive: "governed", voice: "governed" });
});

test("provider selectors intersect their allowlists and unknown recipients do not inherit direct-cost authority", () => {
  const parsed = parse("providers: [{ paths: [me/**], allow: [anthropic, google] }, { types: [private], allow: [anthropic] }]");
  expect(parsed.ok).toBe(true);
  expect(parsed.warnings.join(" ")).toContain("git history");
  expect(providerAllows(parsed.effective.providers, "me/identity.md", "private", "anthropic")).toBe(true);
  expect(providerAllows(parsed.effective.providers, "me/identity.md", "private", "google")).toBe(false);
  expect(providerAllows(parsed.effective.providers, "me/identity.md", "note", "google")).toBe(true);
  expect(providerAllows(parsed.effective.providers, "me/identity.md", "note", "direct")).toBe(false);
  expect(providerAllows(parsed.effective.providers, "me/identity.md", "note", undefined)).toBe(false);
  expect(providerAllows(parsed.effective.providers, "notes/voyage.md", "note", undefined)).toBe(true);
});

const APIFY_DEFAULTS = { enabled: false, discovery: "ask" as const, actors: "ask" as const, actor_grants: [] };

test("Apify stays disabled unless the policy explicitly enables it, and its block is strict", () => {
  expect(parse("profiles: { interactive: governed }").effective.apify).toEqual(APIFY_DEFAULTS);
  expect(parse("apify: {}").effective.apify).toEqual(APIFY_DEFAULTS);
  expect(parse("apify: { enabled: false }").effective.apify).toEqual(APIFY_DEFAULTS);
  expect(parse("apify: { enabled: true }").effective.apify).toEqual({ ...APIFY_DEFAULTS, enabled: true });
  for (const yaml of ["apify: { enabled: yes-please }", "apify: { enabled: 1 }", "apify: { enabled: true, token: x }", "apify: true"]) {
    const parsed = parse(yaml);
    expect(parsed.ok, `APIFY_POLICY_STRICT: ${yaml}`).toBe(false);
    expect(parsed.effective.apify, `APIFY_INVALID_FALLS_BACK_DISABLED: ${yaml}`).toEqual(APIFY_DEFAULTS);
  }
});

const GRANT = {
  account_id: "IthacaHousehold01", actor_id: "SeaCharts01", build_number: "1.4.2", profile_id: "odysseus-sea-charts@1",
  schema_sha256: "a".repeat(64), pricing_sha256: "b".repeat(64), origins: ["https://ithaca.example"],
  expires_at: "2026-07-19T00:00:00.000Z", max_run_usd: 2.5,
};
const grantYaml = (grant: Record<string, unknown>) => `apify:\n  enabled: true\n  actor_grants:\n    - ${JSON.stringify(grant)}`;

test("Apify discovery and Actor modes are independent and default to asking; grants are exact and strict", () => {
  const modes = parse("apify: { enabled: true, discovery: allow, actors: deny }");
  expect(modes.ok).toBe(true);
  expect(modes.effective.apify).toEqual({ enabled: true, discovery: "allow", actors: "deny", actor_grants: [] });
  // Discovery permission never implies an Actor mode, and neither enables the provider.
  expect(parse("apify: { discovery: allow }").effective.apify).toEqual({ ...APIFY_DEFAULTS, discovery: "allow" });
  for (const yaml of ["apify: { discovery: always }", "apify: { actors: yes }", "apify: { actors: [allow] }"])
    expect(parse(yaml).ok, `APIFY_MODE_STRICT: ${yaml}`).toBe(false);

  const granted = parse(grantYaml(GRANT));
  expect(granted.ok, granted.errors.join(" ")).toBe(true);
  expect(granted.effective.apify.actor_grants).toEqual([GRANT]);
  // An unquoted YAML timestamp is the same instant.
  const unquoted = parse(grantYaml(GRANT).replace('"expires_at":"2026-07-19T00:00:00.000Z"', '"expires_at":2026-07-19T00:00:00Z'));
  expect(unquoted.ok, unquoted.errors.join(" ")).toBe(true);
  expect(unquoted.effective.apify.actor_grants[0]?.expires_at).toBe("2026-07-19T00:00:00.000Z");

  for (const [field, value] of [["actor_id", "odysseus/sea-charts"], ["build_number", "latest"], ["schema_sha256", "A".repeat(64)],
    ["pricing_sha256", "b"], ["origins", ["https://ithaca.example/"]], ["origins", ["http://ithaca.example"]], ["origins", ["*"]],
    ["expires_at", "next week"], ["max_run_usd", 0], ["max_run_usd", -1], ["max_run_usd", 1e12], ["account_id", ""]] as const) {
    const parsed = parse(grantYaml({ ...GRANT, [field]: value }));
    expect(parsed.ok, `APIFY_GRANT_STRICT: ${field}=${JSON.stringify(value)}`).toBe(false);
    expect(parsed.effective.apify, `APIFY_INVALID_GRANT_DISABLED: ${field}`).toEqual(APIFY_DEFAULTS);
  }
  expect(parse(grantYaml({ ...GRANT, wildcard: true })).ok, "APIFY_GRANT_NO_EXTRA_FIELDS").toBe(false);
  const { max_run_usd: _cap, ...uncapped } = GRANT;
  expect(parse(grantYaml(uncapped)).ok, "APIFY_GRANT_NEEDS_CAP").toBe(false);
});
