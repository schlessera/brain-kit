import { expect, test } from "bun:test";
import { parseGovernancePolicy } from "../src/lib/governance-policy";

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
