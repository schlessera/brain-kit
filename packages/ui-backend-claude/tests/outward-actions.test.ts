import { expect, test } from "bun:test";
import { probe } from "./helpers/command-effect-probe";
const allow = [{ command: "^git push origin ", remotes: ["github.com/odysseus/*"], index: 0 }];
test("Claude: declining visible push executes no fake git", async () => {
  const result = await probe({ command: "git push origin main", decision: { behavior: "deny", message: "Declined." } });
  expect(result.executed, "CLAUDE_OUTWARD_PUSH_DECLINED").toBe(false);
  expect(result.requests[0]?.kind).toBe("command");
  expect(result.events.find(e => e.kind === "outward_action")).toMatchObject({ payload: { action: "git_push", decision: "declined" } });
});
test("Claude: a matching command AND actual origin destination executes without a card", async () => {
  const result = await probe({ command: "git push origin main", outwardAllow: allow });
  expect(result.bytes).toBe("push origin main\n"); expect(result.requests).toEqual([]);
  expect(result.events.find(e => e.kind === "outward_action")).toMatchObject({ payload: { target: "github.com/odysseus/voyage.git", decision: "policy_allowed" } });
});
test("Claude: a matching allow cannot waive force push confirmation", async () => {
  const result = await probe({ command: "git push origin --force main", outwardAllow: allow, decision: { behavior: "deny", message: "Declined." } });
  expect(result.executed, "CLAUDE_OUTWARD_FORCE_ALWAYS_ASKS").toBe(false); expect(result.requests).toHaveLength(1);
});
for (const command of ["gh issue comment 12 --body Homeward", "curl -X POST https://ithaca.example/api", "wget --post-data=Homeward https://ithaca.example/api"]) test(`Claude: visible write ${command.split(" ")[0]} asks`, async () => {
  const result = await probe({ command, decision: { behavior: "deny", message: "Declined." } });
  expect(result.executed, "CLAUDE_OUTWARD_WRITE_DECLINED").toBe(false); expect(result.requests[0]?.kind).toBe("command");
});
for (const command of ["gh issue view 12", "curl https://ithaca.example/api"]) test(`Claude: classified read ${command.split(" ")[0]} needs no outward card`, async () => {
  const result = await probe({ command }); expect(result.executed).toBe(true); expect(result.requests).toEqual([]);
  expect(result.events.find(e => e.kind === "outward_classification")).toMatchObject({ classification: { kind: "read" } });
});
test("Claude: true voice refuses outward even a matching policy allow", async () => {
  const result = await probe({ command: "git push origin main", outwardAllow: allow, voice: true, noGrantSurface: true });
  expect(result.executed, "CLAUDE_VOICE_OUTWARD_REFUSED").toBe(false); expect(result.requests).toEqual([]);
  expect(result.events.find(e => e.kind === "outward_action")).toMatchObject({ payload: { decision: "refused" } });
});
