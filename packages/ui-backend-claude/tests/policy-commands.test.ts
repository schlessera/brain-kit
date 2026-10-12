import { expect, test } from "bun:test";
import { probe } from "./helpers/command-effect-probe";

const force = { pattern: "^git push (-f|--force)", reason: "No force pushes.", index: 0 };
test("policy deny stops actual Bash and identical retries before fake git runs", async () => {
  const receipt = await probe({ deny: [force], command: "git push --force", repeats: 2 });
  expect(receipt.executed, "CLAUDE_POLICY_DENY_BEFORE_EXECUTION").toBe(false);
  expect(receipt.requests).toEqual([]);
  expect(JSON.stringify(receipt.outputs)).toContain("commands.deny[0]");
  expect(JSON.stringify(receipt.outputs)).toContain(force.reason);
  expect(receipt.events.filter(event => event.kind === "policy_block")).toHaveLength(2);
});
test("the negative control actually executes a nonmatching fake git command", async () => {
  const receipt = await probe({ deny: [force], command: "git status" });
  expect(receipt.executed).toBe(true);
  expect(receipt.bytes).toBe("status\n");
  expect(receipt.requests).toEqual([]);
});
test("policy confirmation uses the existing per-use card and declining runs nothing", async () => {
  const receipt = await probe({ confirm: [{ pattern: "^git push", reason: "Pushing leaves the host.", index: 0 }],
    command: "git push", decision: { behavior: "deny", message: "Declined." } });
  expect(receipt.executed, "CLAUDE_POLICY_CONFIRM_DECLINED").toBe(false);
  expect(receipt.requests).toHaveLength(1);
  expect(receipt.requests[0]).toMatchObject({ kind: "command", description: "Pushing leaves the host." });
});
for (const callback of [false, true]) test(`approved edits into denied Bash run nothing (${callback ? "callback" : "hook"})`, async () => {
  const receipt = await probe({ deny: [force], command: "git status", callback,
    confirm: callback ? [] : [{ pattern: "^git status", reason: "Review this command.", index: 0 }],
    decision: { behavior: "allow", updatedInput: { command: "git push --force" } } });
  expect(receipt.executed, "CLAUDE_POLICY_EDIT_DENY_BEFORE_EXECUTION").toBe(false);
  expect(receipt.requests).toHaveLength(1);
  expect(receipt.events.some(event => event.kind === "policy_block")).toBe(true);
});

test("approved policy confirmation executes exactly the command shown", async () => {
  const receipt = await probe({ confirm: [{ pattern: "^git push", reason: "Review pushing.", index: 1 }], command: "git push" });
  expect(receipt.bytes).toBe("push\n");
  expect(receipt.events.find(e => e.kind === "policy_confirm")).toMatchObject({ payload: { decision: "approved", rule: { index: 1 } } });
});
test("cancellation during an approval prevents actual execution", async () => {
  const receipt = await probe({ confirm: [{ pattern: "^git push", reason: "Review pushing.", index: 1 }], command: "git push", cancelOnApproval: true });
  expect(receipt.executed).toBe(false);
  expect(receipt.events.find(e => e.kind === "policy_confirm")).toMatchObject({ payload: { decision: "cancelled" } });
});
test("a no-grant turn refuses policy confirmation without raising a card", async () => {
  const receipt = await probe({ confirm: [{ pattern: "^git push", reason: "Review pushing.", index: 1 }], command: "git push", noGrantSurface: true });
  expect(receipt.executed).toBe(false); expect(receipt.requests).toEqual([]);
});

for (const list of ["deny", "confirm"] as const) test(`RTK cannot rewrite a permitted input into a policy ${list}`, async () => {
  const receipt = await probe({ [list]: [force], command: "git status", rewrite: "git push --force" });
  expect(receipt.rewritten, "RTK_ORACLE_ACTUALLY_RAN").toBe(true);
  expect(receipt.executed, "CLAUDE_REWRITTEN_POLICY_BEFORE_EXECUTION").toBe(false);
});
