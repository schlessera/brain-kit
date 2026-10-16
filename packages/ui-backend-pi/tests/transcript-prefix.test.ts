/** Exact provider-history regression using the installed runtimes, no live provider. */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const root = resolve(import.meta.dir, "../../..");
test("PI promoted links preserve the previous request messages byte for byte", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "transcript-prefix-pi-"));
  try {
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev", process.execPath,
      "--preload", join(root, "scripts/test-network-child-preload.ts"), join(import.meta.dir, "fixtures/transcript-prefix-probe.ts"), scratch],
      { cwd: root, env: { PATH: process.env.PATH!, LANG: "C.UTF-8", TMPDIR: tmpdir() }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err || out).toBe(0);
    const { requests, history, transcript } = JSON.parse(readFileSync(join(scratch, "requests.json"), "utf8"));
    expect(requests, "REAL_TOOL_ROUND_TRIP_AND_RESUMED_REQUEST").toHaveLength(4);
    const previous = requests[2].messages, resumed = requests[3].messages;
    expect(JSON.stringify(previous), "INTERMEDIATE_PROVIDER_LINK_BEFORE_TOOL").toContain("Before checking: [Ithaca chart](/tmp/ithaca-chart.pdf)");
    expect(JSON.stringify(resumed.slice(0, previous.length)), "PI_BYTE_IDENTICAL_MESSAGES_PREFIX").toBe(JSON.stringify(previous));
    expect(transcript, "SAVED_RUNTIME_ANSWER_UNCHANGED").toContain("After checking: [Ithaca chart](/tmp/ithaca-chart.pdf)");
    const displayed = JSON.stringify(history);
    expect(displayed, "RELOADED_DISPLAY_HAS_BOTH_PROMOTED_LINKS").toContain("Before checking: [Ithaca chart](.brain/scratch/turns/odysseus-0/ithaca-chart.pdf)");
    expect(displayed).toContain("After checking: [Ithaca chart](.brain/scratch/turns/odysseus-0/ithaca-chart.pdf)");
    expect(displayed).not.toContain("[Ithaca chart](/tmp/");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 180_000);
