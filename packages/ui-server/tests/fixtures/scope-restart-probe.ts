/** Disposable host whose SIGKILL exercises die-with-parent and retained restart recovery. */
import { scopeFixture } from "../helpers/scope-fixture.js";
const f = scopeFixture({ max_tool_calls: 1 }); await f.begin();
const child = f.worker(["/usr/bin/python3", "-I", "-S", "-c", `import pathlib,time
pathlib.Path("restart-note").write_text("Ithaca")
while True: time.sleep(1)`]);
while (!await Bun.file(f.brain + "/restart-note").exists()) await Bun.sleep(5);
f.scope.toolCall("voyage", "loom");
console.log(JSON.stringify({ root: f.root, brain: f.brain, workerPid: child.pid, serverPid: process.pid, state: f.receipt().state }));
await new Promise(() => {});
