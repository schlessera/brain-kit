import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerStartupView } from "../src/server/worker-startup-view.js";
import { workerCommand, prepareWorkerSandbox } from "../src/server/worker-launcher.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const remove of cleanup.splice(0).reverse()) remove(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-startup-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain"); mkdirSync(brain);
  writeFileSync(join(brain, "brain.config.ts"), 'import value from "./helper.ts"; export default value;');
  writeFileSync(join(brain, "helper.ts"), 'export default "Odysseus before launch";');
  return brain;
}
test("startup bytes are independent and absence is preserved", () => {
  const brain = fixture();
  const view = createWorkerStartupView(brain); cleanup.push(view.cleanup);
  writeFileSync(join(brain, "helper.ts"), 'export default "Odysseus during launch";');
  writeFileSync(join(brain, ".mcp.json"), "{}");
  expect(readFileSync(join(view.root, "helper.ts"), "utf8")).toContain("before launch");
  expect(Bun.file(join(view.root, ".mcp.json")).size).toBe(0);
});

test("a real startup-view worker imports the old dependency after a governed edit", async () => {
  const brain = fixture();
  const startupView = createWorkerStartupView(brain); cleanup.push(startupView.cleanup);
  const bun = process.execPath;
  const sandbox = prepareWorkerSandbox(brain, { profile: "strict", areas: [], readPaths: [bun] });
  const child = Bun.spawn(workerCommand({ brainPath: brain, startupView, sandbox, env: {},
    command: ["/bin/sh", "-c", 'printf "ready\\n"; IFS= read -r go; [ "$go" = go ] || exit 40; exec "$1" --no-env-file -e \'console.log((await import("./brain.config.ts")).default); console.log(await Bun.file(".mcp.json").exists())\'', "odysseus-reader", bun] }),
    { cwd: "/", env: {}, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stream = child.stdout.getReader();
  const ready = await stream.read();
  expect(Buffer.from(ready.value ?? []).toString()).toBe("ready\n");
  writeFileSync(join(brain, "helper.ts"), 'export default "Odysseus during launch";');
  writeFileSync(join(brain, ".mcp.json"), "{}");
  child.stdin.write("go\n"); child.stdin.end();
  let output = "";
  for (;;) { const next = await stream.read(); if (next.done) break; output += Buffer.from(next.value).toString(); }
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  expect(output).toBe("Odysseus before launch\nfalse\n");
});
