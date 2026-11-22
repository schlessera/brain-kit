/** Compile the programs selected by the hosted control, without its privileged fixture. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NATIVE_CHECKPOINT_READER_PROGRAM, NATIVE_CHECKPOINT_CLIENT_PROGRAM } from "../packages/ui-sdk/src/server/native-checkpoint-reader";

const control = resolve(import.meta.dir, "../scripts/native-proof/checkpoint-reader-controls.py");

async function selectedPrograms(root: string) {
  // Execute only the real source-selection block. The root/UID/mount controls
  // never run here; this test proves the exact Python bytes they will launch.
  const selector = `import json,pathlib,subprocess,sys
__file__=sys.argv[1]
source=pathlib.Path(__file__).read_text()
start=source.index("import pathlib,re")
end=source.index("def drop():",start)
exec(compile(source[start:end],__file__,"exec"))
print(json.dumps({"reader":program,"client":client,"authority":authority_client}))
`;
  const child = Bun.spawn(["python3", "-I", "-S", "-c", selector, control], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, error).toBe(0);
  return JSON.parse(output) as Record<"reader" | "client" | "authority", string>;
}

test("checkpoint reader controls launch compiled shipped programs with resolved transport bounds", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-reader-control-"));
  try {
    const programs = await selectedPrograms(root);
    for (const [name, program] of Object.entries(programs)) {
      const child = Bun.spawn(["python3", "-I", "-S", "-c", "import sys;compile(sys.stdin.read(),sys.argv[1],'exec')", name],
        { cwd: root, stdin: new TextEncoder().encode(program), stdout: "pipe", stderr: "pipe" });
      const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      await new Response(child.stdout).text();
      expect(code, `CONTROL_${name.toUpperCase()}_COMPILES: ${error}`).toBe(0);
    }
    expect(programs.reader).toBe(NATIVE_CHECKPOINT_READER_PROGRAM);
    expect(programs.client).toBe(NATIVE_CHECKPOINT_CLIENT_PROGRAM);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
