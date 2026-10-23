import { expect, test } from "bun:test";
import { classifyOutwardCall, outwardTarget } from "../src/server/outward-actions";
import { prepareOutwardPlan, workerOutwardNote } from "../src/server/outward-policy";

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

test("a tainted session borrows no outward.allow rule and only an outward call reads the taint", () => {
  const allow = [{ command: "^git push ", remotes: ["github.com/odysseus/*"], index: 0 }];
  let reads = 0;
  const taint = () => { reads++; return { eventId: 7, source: "web_fetch" }; };
  const plan = (command: string) => prepareOutwardPlan({ toolName: "Bash", shellToolName: "Bash", input: { command }, allow, taint });
  expect(plan("git push https://github.com/odysseus/voyage.git main"), "G6_TAINTED_PLAN_ASKS").toMatchObject({ tainted: true, needsApproval: true, rules: [null] });
  expect(plan("ls -la")).toMatchObject({ tainted: false, needsApproval: false });
  expect(reads).toBe(1);
  expect(prepareOutwardPlan({ toolName: "Bash", shellToolName: "Bash", input: { command: "git push https://github.com/odysseus/voyage.git main" }, allow, taint: () => null }))
    .toMatchObject({ tainted: false, needsApproval: false });
});

test("the capabilities note states the taint rules, the session's taint and where tainted egress is not enforced", () => {
  expect(workerOutwardNote(true), "G6_NOTE_ABSENT_WITHOUT_HOST_RECORD").not.toContain("# Untrusted input");
  const clean = workerOutwardNote(false, null);
  expect(clean).toContain("results from any MCP server other than brain-kit's own");
  expect(clean, "G6_NOTE_NOT_ENFORCED_OFF_PROXY").toContain("Tainted egress is not enforced for this turn: it does not run on the host egress proxy.");
  expect(clean).not.toContain("This session is tainted");
  const tainted = workerOutwardNote(true, { eventId: 7, source: "web_fetch" });
  expect(tainted, "G6_NOTE_STATES_TAINT").toContain("This session is tainted (first recorded source: web_fetch).");
  expect(tainted).toContain("as does any connection other than the inference relay");
  expect(tainted).toContain("taint.egress.allow hosts, hosts this session already contacted, and the inference relay");
});
