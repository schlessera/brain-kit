import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { identityNativeFixture } from "../scripts/prove-worker-identity.ts";

/**
 * The identity cell rewrites the native fixture by exact text (#2882 moved
 * one of its anchors and only the hosted runtime cell found out). Every
 * composition it selects must still apply to the fixture as it stands.
 */
const fixture = readFileSync(join(import.meta.dir, "..", "scripts/native-proof/fixture.py"), "utf8");
const base = { applicationTimeoutMs: 180_000, sharedGit: false, privateGitInputs: false, applicationQualification: false,
  probeStatePlacement: false, bootPruneCapture: false, omitProbeStatePlacement: false };
const compositions = {
  default: base,
  "shared git": { ...base, sharedGit: true },
  "private git inputs": { ...base, sharedGit: true, privateGitInputs: true },
  "application scenario with boot prune capture": { ...base, sharedGit: true, applicationQualification: true, applicationScenario: "db-repeat", bootPruneCapture: true },
  "probe-state placement": { ...base, sharedGit: true, probeStatePlacement: true },
  "application default": { ...base, sharedGit: true, applicationQualification: true },
  "application governed": { ...base, sharedGit: true, applicationQualification: true, applicationScenario: "governed" },
  "application strict": { ...base, sharedGit: true, applicationQualification: true, applicationScenario: "strict" },
  "application boot capture": { ...base, sharedGit: true, applicationQualification: true, bootPruneCapture: true },
  "omitted probe-state placement": { ...base, sharedGit: true, probeStatePlacement: true, omitProbeStatePlacement: true },
};

for (const [name, options] of Object.entries(compositions)) test(`the identity fixture applies to the native fixture: ${name}`, () => {
  const rewritten = identityNativeFixture(fixture, options);
  expect(rewritten, "IDENTITY_FIXTURE_REPLACES_THE_HOSTED_APP_RUN").not.toContain("hosted-app.test.ts");
  expect(rewritten.includes("identity-manager.native.ts"), "IDENTITY_FIXTURE_RUNS_THE_MANAGER_PHASE_ONLY_BY_DEFAULT").toBe(!options.sharedGit);
  // A replacement that lands at the wrong indentation is a fixture that never starts.
  const parsed = Bun.spawnSync(["python3", "-I", "-S", "-c", "import ast,sys; ast.parse(sys.stdin.read())"], { stdin: new TextEncoder().encode(rewritten), stderr: "pipe" });
  expect(parsed.exitCode, `IDENTITY_FIXTURE_IS_VALID_PYTHON ${parsed.stderr.toString()}`).toBe(0);
});
