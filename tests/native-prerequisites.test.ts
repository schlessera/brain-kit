import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Execute the Dockerfile's actual shell with offline package-manager doubles.
// Real mirror recovery and package equivalence also need the Docker build receipt.
const dockerfile = readFileSync(new URL("../scripts/native-proof/Dockerfile", import.meta.url), "utf8");
const command = dockerfile.slice(dockerfile.indexOf("RUN ") + 4, dockerfile.indexOf("\nENTRYPOINT")).replace(/\\\n/g, "");

function run(updateFailures: number, installFails = false) {
  const dir = mkdtempSync(join(tmpdir(), "native-prerequisites-"));
  try {
    const script = `#!/bin/sh
printf '%s\\n' "$*" >> "$PROBE_DIR/calls"
case "$*" in
  *update*)
    count=0
    if [ -f "$PROBE_DIR/count" ]; then read -r count < "$PROBE_DIR/count"; fi
    count=$((count + 1))
    echo "$count" > "$PROBE_DIR/count"
    [ "$count" -gt "$UPDATE_FAILURES" ] ;;
  *install*) [ "$INSTALL_FAILS" = false ] ;;
esac
`;
    writeFileSync(join(dir, "apt-get"), script, { mode: 0o755 });
    writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(dir, "rm"), '#!/bin/sh\necho cleanup >> "$PROBE_DIR/calls"\n', { mode: 0o755 });
    const result = Bun.spawnSync(["sh", "-ec", command], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROBE_DIR: dir,
        UPDATE_FAILURES: String(updateFailures), INSTALL_FAILS: String(installFails) },
    });
    return { code: result.exitCode, calls: readFileSync(join(dir, "calls"), "utf8").trim().split("\n") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("native prerequisite build retries failed index refreshes before installing", () => {
  const result = run(2);
  expect(result.code).toBe(0);
  expect(result.calls.filter(line => line.endsWith(" update"))).toHaveLength(3);
  expect(result.calls.filter(line => line.includes("install "))).toHaveLength(1);
  for (const call of result.calls.filter(line => line !== "cleanup")) {
    expect(call).toContain("Acquire::Retries=5");
    expect(call).toContain("Acquire::http::Timeout=30");
    expect(call).toContain("Acquire::https::Timeout=30");
  }
  expect(result.calls[0]).toContain("APT::Update::Error-Mode=any");
  expect(result.calls.at(-1)).toBe("cleanup");
});

test("native prerequisite build refuses persistent index failures after three attempts", () => {
  const result = run(3);
  expect(result.code).not.toBe(0);
  expect(result.calls).toHaveLength(3);
  expect(result.calls.every(line => line.endsWith(" update"))).toBe(true);
});

test("native prerequisite build does not hide a failed package install with cleanup", () => {
  const result = run(0, true);
  expect(result.code).not.toBe(0);
  expect(result.calls).toHaveLength(2);
  expect(result.calls.at(-1)).toContain("install ");
});
