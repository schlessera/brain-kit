import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dir, "../../..");
test("resumed real Pi requests retain system and prior bytes while changed facts use owned new-tail context", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-session-prefix-"));
  try {
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
      "--preload", join(root, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "fixtures/session-prompt-probe.ts"), scratch],
      { cwd: root, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    const { requests, history, original, unsupportedVoice } = JSON.parse(readFileSync(join(scratch, "requests.json"), "utf8"));
    expect(requests).toHaveLength(5);
    const [first, second, third, noGrant, missing] = requests;
    expect(JSON.stringify(second.input[0]), "PI_SYSTEM_BYTES_STABLE").toBe(JSON.stringify(first.input[0]));
    expect(JSON.stringify(first.input[0]), "MUTABLE_TIMEOUT_OUTSIDE_APPEND").not.toContain("hard budget of about 1 minutes");
    expect(JSON.stringify(third.input[0]), "PI_SYSTEM_BYTES_STABLE").toBe(JSON.stringify(first.input[0]));
    // #2053 permits native cache breakpoint movement; preserve every other byte.
    const contentBytes = (value: unknown) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);
    expect(contentBytes(second.input.slice(0, first.input.length)), "PI_PRIOR_MESSAGES_UNCHANGED").toBe(contentBytes(first.input));
    expect(JSON.stringify(second.input.at(-1)), "CHANGED_DEVICE_NEW_TAIL").toContain("350px");
    const secondText = second.input.at(-1).content.filter((part: any) => part.type === "input_text").map((part: any) => part.text).join("");
    expect(secondText, "CHANGED_TIMEOUT_NEW_TAIL").toContain("timeout: The host hard budget for this turn is 120000 ms");
    expect(secondText, "CHANGED_PROFILE_NEW_TAIL").toContain("**Profile: `governed`.**");
    const capabilityLine = secondText.split("\n").find((line: string) => line.startsWith("capabilities: "));
    expect(capabilityLine, "INDEPENDENT_INBOX_HANDLER_CHANGE_DELIVERED").toBeDefined();
    const capabilities = JSON.parse(capabilityLine.slice("capabilities: ".length));
    expect(capabilities.inbox, "INDEPENDENT_INBOX_HANDLER_FACTS").toEqual({ list: false, get: false, add: true, resolveAction: false, completeShare: false });
    expect(JSON.stringify(first.input[0]), "LIVE_FACTS_OUTSIDE_APPEND").not.toContain("1200px");
    expect(JSON.stringify(third.input.at(-1)), "UNCHANGED_FACTS_NOT_REINJECTED").not.toContain("Host context for this turn");
    expect(unsupportedVoice.message, "PI_UNSUPPORTED_VOICE_REFUSED").toContain("declares no voice tool posture");
    expect(unsupportedVoice.after, "PI_UNSUPPORTED_VOICE_NO_INFERENCE").toBe(unsupportedVoice.before);
    const noGrantText = noGrant.input.at(-1).content.filter((part: any) => part.type === "input_text").map((part: any) => part.text).join("");
    const noGrantFacts = JSON.parse(noGrantText.split("\n").find((line: string) => line.startsWith("capabilities: ")).slice("capabilities: ".length));
    expect(noGrantFacts, "NO_GRANT_CAPABILITY_FACTS_MATCH_AUTHORITY").toMatchObject({ askUser: true, location: true, activity: true, askUserList: false, askUserRank: false, askUserForm: false, mask: false, policyChange: false, inbox: { list: true, get: true, add: false, resolveAction: false, completeShare: false } });
    const missingText = missing.input.at(-1).content.filter((part: any) => part.type === "input_text").map((part: any) => part.text).join("");
    const missingFacts = JSON.parse(missingText.split("\n").find((line: string) => line.startsWith("capabilities: ")).slice("capabilities: ".length));
    expect(missingFacts, "MISSING_HANDLER_FACTS_MATCH_AUTHORITY").toMatchObject({ askUser: false, location: false, activity: false, askUserList: false, askUserRank: false, askUserForm: false, mask: false, policyChange: false, inbox: { list: false, get: false, add: false, resolveAction: false, completeShare: false } });
    expect(history.filter((entry: any) => entry.role === "user").map((entry: any) => entry.content), "PI_OWNED_REPLAY_USER_TEXT").toEqual(original);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 180000);
