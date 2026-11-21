import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  // Execute the generated file from its own directory, as /fixture-variants
  // does, with no adjacent helper. Stop before any native filesystem setup.
  const variants = mkdtempSync(join(tmpdir(), "ithaca-fixture-variants-"));
  try {
    const path = join(variants, "identity-fixture.py"); writeFileSync(path, rewritten);
    const program = `import ast,json,pathlib,sys
path=pathlib.Path(sys.argv[1]); sys.argv=[str(path),"claude","1000"]
nodes=[]
for node in ast.parse(path.read_text()).body:
    if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=="ROOT" for target in node.targets): break
    nodes.append(node)
else: raise RuntimeError("fixture configuration boundary missing")
namespace={"__file__":str(path),"__name__":"__main__"}
exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),"exec"),namespace)
assert "ROOT" not in namespace
print(json.dumps({"timeout":namespace["HOSTED_TIMEOUT"],"backend":namespace["BACKEND"],"appUid":namespace["APP_UID"]}))`;
    const configured = Bun.spawnSync(["python3", "-I", "-S", "-B", "-c", program, path], {
      cwd: variants, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
    });
    expect(configured.exitCode, `IDENTITY_FIXTURE_CONFIGURATION_EXECUTES_FROM_VARIANT ${configured.stderr.toString()}`).toBe(0);
    expect(JSON.parse(configured.stdout.toString())).toEqual({ timeout: 180, backend: "claude", appUid: "1000" });
  } finally { rmSync(variants, { recursive: true, force: true }); }

});
