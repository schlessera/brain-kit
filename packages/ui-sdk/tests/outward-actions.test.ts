import { expect, test } from "bun:test";
import { classifyOutwardCall, outwardTarget } from "../src/server/outward-actions";
import { prepareOutwardPlan } from "../src/server/outward-policy";

test("visible writes and remote history rewrites have deterministic shared classification", () => {
  for (const command of ["git push origin main", "git -C workspaces/voyage push origin main", "gh api -XPOST repos/odysseus/voyage/issues", "gh --repo odysseus/voyage issue comment 12 --body Homeward", "gh api repos/odysseus/voyage/issues -f title=Homeward", "curl -sXPOST https://ithaca.example/api", "curl -sd Homeward https://ithaca.example/api", "wget --method=PATCH https://ithaca.example/api"])
    expect(classifyOutwardCall("Bash", "Bash", { command }).kind, command).toBe("outward");
  for (const flag of ["--force", "-f", "--force-with-lease", "--force-if-includes", "--mirror", "--delete", "--prune", "+main:main", ":main"])
    expect(classifyOutwardCall("bash", "bash", { command: `git push origin ${flag}` }).actions[0]?.historyRewrite, flag).toBe(true);
});

test("unknown code and configuration are never represented as blanket classified reads", () => {
  expect(classifyOutwardCall("Bash", "Bash", { command: "gh api -X GET search/issues -f q=Homeward" }).kind).toBe("read");
  expect(classifyOutwardCall("Bash", "Bash", { command: "gh issue view 12 && curl https://ithaca.example/api" })).toEqual({ kind: "read", actions: [] });
  expect(classifyOutwardCall("Bash", "Bash", { command: "gh issue view 12; ./voyage.sh" })).toMatchObject({ kind: "unknown", opaque: true });
  expect(classifyOutwardCall("Bash", "Bash", { command: "git push origin main; ./voyage.sh" })).toMatchObject({ kind: "outward", opaque: true });
  expect(classifyOutwardCall("Bash", "Bash", { command: "curl -K settings -X POST https://ithaca.example/api" }).actions[0]?.target).toBeNull();
  expect(classifyOutwardCall("Bash", "Bash", { command: "curl -K settings https://ithaca.example/api" }).kind).toBe("unknown");
  expect(classifyOutwardCall("Bash", "Bash", { command: "curl -X POST \"$DESTINATION\"" }).actions[0]?.target).toBeNull();
});

test("only an explicit matching command and known destination allow normal pushes; history rewrites still ask", () => {
  const allow = [{ command: "^git push ", remotes: ["github.com/odysseus/*"], index: 3 }];
  const plan = (command: string, extra = {}) => prepareOutwardPlan({ toolName: "Bash", shellToolName: "Bash", input: { command }, allow, ...extra });
  expect(plan("git push https://github.com/odysseus/voyage.git main").needsApproval).toBe(false);
  expect(plan("git push https://github.com/odysseus/voyage.git --force main").needsApproval).toBe(true);
  expect(plan("git push origin main").needsApproval).toBe(true);
  expect(plan("./voyage.sh; git push https://github.com/odysseus/voyage.git main").needsApproval).toBe(true);
  expect(plan("git push https://github.com/athena/voyage.git main").needsApproval).toBe(true);
  expect(plan("git push https://github.com/odysseus/voyage.git main", { voice: true }).voiceRefusal).toBe(true);
  expect(plan("git push origin main", { autonomous: true }).classification.actions).toEqual([]);
  expect(outwardTarget("https://odysseus:secret@github.com/odysseus/voyage.git")).toBe("github.com/odysseus/voyage.git");
});
