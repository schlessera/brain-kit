import { expect, test } from "bun:test";
import { join } from "node:path";
for (const mode of ["success", "ordinary", "unconfirmed"]) for (const reference of ["explicit", "implicit"]) {
  test(`maintenance helper adapter preserves ${reference} ownership after ${mode}`, async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/maintenance-helper-admission.ts"), mode, reference],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, errors).toBe(0); expect(JSON.parse(output).result).toBe("pass");
  });
}
