/** Offline worker peer: the real worker-local grep/bash tools under the host's serialized exec helpers (#1429). */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createBrainAccess } from "../../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../../src/tools";
import { createTurnContext } from "../../src/turn-context";
import { pipeMessages, sendPipe } from "../../src/worker-protocol";

const text = (result: any) => result.content.map((part: { text: string }) => part.text).join("");
const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : "";

for await (const message of pipeMessages(process.stdin)) {
  const init = message as any;
  if (init.type !== "init") continue;
  const exec = init.backend.exec as { wrapper?: string; killer?: string };
  const tools = createBrainTools({ brain: createBrainAccess(init.backend.brainPath), exec, turn: createTurnContext(),
    lock: toolLockFromKeyed(createKeyedLock()) });
  const run = (name: string, params: Record<string, unknown>, signal?: AbortSignal) =>
    tools.find(tool => tool.name === name)!.execute("odysseus", params as never, signal, undefined, {} as never);
  const report: Record<string, unknown> = { exec };
  try {
    report.grep = text(await run("grep", { pattern: "wine-dark" }));
    report.bash = text(await run("bash", { command: "echo Ithaca" }));
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(), 300);
    try { await run("bash", { command: "sleep 30" }, controller.signal); report.cancel = "completed"; }
    catch (error) { report.cancel = (error as Error).name; }
    report.cancelMs = Math.round(performance.now() - started);
  } catch (error) { report.error = (error as Error).message; }
  report.wrapperLog = read("/tmp/odysseus-wrapper.log");
  report.killerLog = read("/tmp/odysseus-killer.log");
  const helpers = dirname(exec.killer ?? "/");
  report.helperEntries = existsSync(helpers) ? readdirSync(helpers).sort() : null;
  report.privateEntries = existsSync(dirname(helpers)) ? readdirSync(dirname(helpers)).sort() : null;
  report.siblingVisible = existsSync(`${helpers}/penelope.txt`);
  sendPipe(process.stdout, { type: "ready", sessionId: init.sessionId, model: { id: JSON.stringify(report) }, levels: [], cost: 0 });
  await Bun.sleep(30_000);
}
