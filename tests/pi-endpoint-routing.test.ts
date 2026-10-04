import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
async function probe(scenario: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "brain-pi-endpoints-"));
  try {
    const child = Bun.spawn(["bwrap", "--unshare-net", "--bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      process.execPath, "--preload", join(ROOT, "scripts/test-network-child-preload.ts"),
      join(import.meta.dir, "fixtures/pi-endpoint-probe.ts"), scenario, root], {
      cwd: ROOT, env: { PATH: process.env.PATH!, LANG: "C.UTF-8" }, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err || out).toBe(0);
    return JSON.parse(out.trim().split("\n").at(-1)!);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function inference(r: any): string[] { return r.attempts.filter((a: any) => a.kind === "inference").map((a: any) => a.url); }

describe("pi native endpoint routing through the real adapter", () => {
  test("configured endpoint receives ordinary new, resident and persisted-resume requests", async () => {
    const r = await probe("ordinary");
    expect(r.configuredInput).toBe(r.configured);
    expect(r.configured).not.toBe(r.catalogEndpoint);
    expect(inference(r), "every ordinary adapter request uses the full configured endpoint").toEqual(Array(3).fill(r.configured + "/v1/messages?beta=true"));
    expect(r.received).toHaveLength(3);
    expect(r.received.map((request: any) => request.url)).toEqual(Array(3).fill(r.configured + "/v1/messages?beta=true"));
    for (const request of r.received) {
      expect(request.model).toBe(r.modelId);
      expect(request.promptPresent).toBe(true);
      expect(request.tools.length).toBeGreaterThan(0);
      expect(request.tools).toContain("brain_search");
    }
    expect(r.refusals).toEqual([]);
    for (const frames of r.frames) {
      expect(frames.at(-1).outcome).toBe("success");
      expect(frames.filter((f: any) => f.type === "text_delta").map((f: any) => f.text).join("")).toContain("Odysseus reached the fixture endpoint.");
    }
    expect(r.frames[0][0].isNew).toBe(true);
    expect(r.frames[2][0].isNew).toBe(false);
    expect(r.frames[2][0].sessionId).toBe(r.frames[0][0].sessionId);
    expect(r.persisted).toHaveLength(1);
    expect(r.persisted[0]).toContain(r.modelId);
    expect(r.persisted[0]).toContain('"provider":"anthropic"');
    expect(r.sessions).toHaveLength(1);
    expect(r.history[0].length).toBeGreaterThan(0);
  });
  test("configured endpoint receives autonomous inference without persistent history", async () => {
    const r = await probe("autonomous");
    expect(r.configuredInput).toBe(r.configured);
    expect(inference(r), "autonomous adapter uses configured destination").toEqual([r.configured + "/v1/messages?beta=true"]);
    expect(r.received).toHaveLength(1);
    expect(r.received[0].promptPresent).toBe(true);
    expect(r.received[0].model).toBe(r.modelId);
    expect(r.received[0].url).toBe(r.configured + "/v1/messages?beta=true");
    expect(r.frames[0].filter((f: any) => f.type === "text_delta").map((f: any) => f.text).join("")).toContain("Odysseus reached the fixture endpoint.");
    expect(r.frames[0].at(-1).outcome).toBe("success");
    expect(r.frames[0].some((f: any) => f.type === "session_info")).toBe(false);
    expect(r.identities.length).toBeGreaterThan(0);
    expect(r.sessions).toEqual([]);
    expect(r.persisted).toEqual([]);
  });
  test("declared nonbuiltin identity refuses before inference", async () => {
    const r = await probe("invalid");
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toContain("not in pi's builtin catalog");
    expect(inference(r)).toEqual([]);
  });
  test("unavailable saved model refuses a usable native fallback before inference", async () => {
    const r = await probe("unavailable-saved");
    expect(r.requestsBeforeRefusal).toBeGreaterThan(0);
    expect(r.frames[0].at(-1).outcome).toBe("success");
    expect(r.refusals, "saved identity refusal is observable").toHaveLength(1);
    expect(r.refusals[0]).toContain("Cannot resume on the session's saved model");
    expect(inference(r)).toHaveLength(r.requestsBeforeRefusal);
  });
  for (const scenario of ["auth-new", "auth-autonomous", "auth-resume", "auth-matching", "auth-default"]) {
    test(`${scenario}: native authentication endpoint takes precedence`, async () => {
      const r = await probe(scenario);
      expect(r.nativeModelApi).toBe("anthropic-messages");
      expect(r.refusals, "native configuration is usable through session acquisition").toEqual([]);
      const urls = inference(r);
      expect(urls.length).toBeGreaterThan(0);
      expect(urls, "native authentication supplies every inference destination").toEqual(Array(urls.length).fill(r.firstEndpoint + "/v1/messages?beta=true"));
      expect(r.received, "remote inference was blocked before transport").toEqual([]);
      for (const attempt of r.attempts.filter((a: any) => a.kind === "inference")) {
        expect(attempt.model).toBe(r.modelId);
        expect(attempt.promptPresent).toBe(true);
        expect(attempt.authPresent).toBe(true);
      }
      expect(r.nativeAuth.length).toBeGreaterThan(0);
      for (const auth of r.nativeAuth) {
        expect(auth.provider).toBe("github-copilot");
        expect(auth.model).toBe(r.modelId);
        expect(auth.source).toBe("OAuth");
        expect(auth.subscription).toBe(true);
        expect(auth.endpoint).toBe(r.firstEndpoint);
      }
      const positiveControl = scenario === "auth-matching" || scenario === "auth-default";
      expect(r.frames.at(-1).at(-1).outcome).toBe(positiveControl ? "success" : "error");
      expect(r.syntheticInferenceResponses).toBe(positiveControl || scenario === "auth-resume" ? 1 : 0);
      if (scenario === "auth-matching") expect(r.configuredInput).toBe(r.firstEndpoint);
      else if (scenario === "auth-default") expect(r.configuredInput).toBeNull();
      else expect(r.configuredInput).toBe(r.configured);
      if (scenario === "auth-resume") {
        expect(r.frames[0].at(-1).outcome).toBe("success");
        expect(r.frames[1][0].isNew).toBe(false);
        expect(urls).toHaveLength(2);
      }
      if (scenario === "auth-autonomous") { expect(r.sessions).toEqual([]); expect(r.persisted).toEqual([]); }
    });
  }
  test("changed credentials change the native destination on the next resident request", async () => {
    const r = await probe("auth-changed");
    expect(r.refusals).toEqual([]);
    expect(inference(r), "later request uses the changed native credential endpoint").toEqual([
      r.firstEndpoint + "/v1/messages?beta=true", r.changedEndpoint + "/v1/messages?beta=true",
    ]);
    expect(r.frames[1][0].sessionId).toBe(r.frames[0][0].sessionId);
    expect(r.received).toEqual([]);
  });
  test("native refresh updates stored credentials and the next resident destination", async () => {
    const r = await probe("auth-refreshed");
    expect(r.refusals).toEqual([]);
    expect(r.attempts.filter((a: any) => a.kind === "refresh")).toHaveLength(1);
    expect(r.attempts.filter((a: any) => a.kind === "refresh-models")).toHaveLength(1);
    expect(r.refreshedCredential).toBe(true);
    expect(inference(r), "later request uses the refreshed native credential endpoint").toEqual([
      r.firstEndpoint + "/v1/messages?beta=true", r.refreshedEndpoint + "/v1/messages?beta=true",
    ]);
    expect(r.received).toEqual([]);
  });
});
