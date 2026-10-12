import { expect, test } from "bun:test";
import { probe } from "./helpers/command-effect-probe";
const force = { pattern: "^git push (-f|--force)", reason: "No force pushes.", index: 1 };

for (const binding of ["rpc", "gate"] as const) {
  test(`${binding}: policy deny stops real bash and retries before fake git executes`, async () => {
    const result = await probe(binding, { deny: [force], command: "git push --force", repeats: 2 });
    expect(result.executed, "PI_POLICY_DENY_BEFORE_EXECUTION").toBe(false);
    expect(result.requests).toEqual([]);
    expect(result.events.filter(e => e.kind === "policy_block")).toHaveLength(2);
    expect(result.events.find(e => e.kind === "policy_block")).toMatchObject({ payload: { rule: { index: 1 }, policyHash: "odysseus-policy" } });
  });
  test(`${binding}: nonmatching fake git actually runs`, async () => {
    const result = await probe(binding, { deny: [force], command: "git status" });
    expect(result.bytes).toBe("status\n");
  });
  test(`${binding}: declined confirmation runs nothing, including bash outside the allowlist`, async () => {
    const result = await probe(binding, { confirm: [{ ...force, pattern: "^git push" }], command: "git push", allowedTools: [], decision: { behavior: "deny", message: "Declined." } });
    expect(result.executed, "PI_POLICY_CONFIRM_DECLINED").toBe(false);
    expect(result.requests).toHaveLength(1); expect(result.requests[0]?.kind).toBe("command");
    expect(result.events.find(e => e.kind === "policy_confirm")).toMatchObject({ payload: { decision: "declined" } });
  });
  test(`${binding}: approved confirmation runs and omitted bash still needs its separate tool grant`, async () => {
    const result = await probe(binding, { confirm: [{ ...force, pattern: "^git push" }], command: "git push", allowedTools: [] });
    expect(result.bytes).toBe("push\n"); expect(result.requests.map(request => request.kind)).toEqual(["command", "tool"]);
    expect(result.events.filter(e => e.kind === "policy_confirm")).toHaveLength(1);
  });
  test(`${binding}: approved edit into denied bash runs nothing`, async () => {
    const result = await probe(binding, { deny: [force], confirm: [{ ...force, pattern: "^git status" }], command: "git status",
      decision: { behavior: "allow", updatedInput: { command: "git push --force" } } });
    expect(result.executed, "PI_POLICY_EDIT_DENY_BEFORE_EXECUTION").toBe(false);
    expect(result.events.some(e => e.kind === "policy_block")).toBe(true);
  });
}
