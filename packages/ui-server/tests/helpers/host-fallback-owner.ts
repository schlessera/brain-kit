/**
 * The owning server process of a legacy host fallback (#2284). It asks its
 * never-governed boundary to start a host writer that later replaces a
 * restricted folder, then waits to be killed (or, `detached`, returns
 * normally while a detached descendant keeps running). A refusal is written to
 * `owner-refused.json` in the brain; no host child exists in that case.
 */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUiDb } from "../../src/db/client.js";
import { createWriterGate } from "../../src/brain/writer-gate.js";
import { createHostBoundary } from "../../src/brain/host-boundary.js";

const [brain, dbPath, method = "launch", descendant = "no", target = "group/private", scenario = "crash"] = process.argv.slice(2);
if (!brain || !dbPath || !["launch", "run"].includes(method) || !["group/private", "group"].includes(target) || !["crash", "detached"].includes(scenario))
  throw Error("unknown fixture case");
const db = createUiDb(dbPath), gate = createWriterGate(db, brain);
const boundary = createHostBoundary({ brainPath: brain, dbPath, requireGate: true, gate: () => gate, history: () => false,
  workerHost: () => ({ ok: false, requirement: "fictional never-governed host" }) });
// The host writer publishes its identity atomically and gives up after about
// 15 seconds, so a failed probe cannot leave it running.
const body = `printf "%s" "$$" > old.pid.tmp && mv old.pid.tmp old.pid; printf ready > old-ready; i=0; while ! test -f old-go; do i=$((i+1)); test $i -gt 1500 && exit 47; sleep 0.01; done; mv ${target} ${target}-retired; mkdir -p group/private; printf Athena > group/private/born.md; printf done > old-done`;
const argv = scenario === "detached" ? ["/bin/sh", "-c", 'setsid /bin/sh -c "$1" </dev/null >/dev/null 2>&1 &', "odysseus-detached", body]
  : descendant === "yes" ? ["/bin/sh", "-c", '/bin/sh -c "$1" &', "odysseus-parent", body] : ["/bin/sh", "-c", body];
try {
  const result = await boundary[method as "launch" | "run"]({ argv, env: { PATH: "/usr/bin:/bin" }, credentials: false, gate: "shared", purpose: "owned old host writer" });
  if ("exited" in result) await Promise.all([result.exited, new Response(result.stdout).text(), new Response(result.stderr).text()]);
} catch (error) {
  // Publish atomically: the probe may SIGKILL this owner as soon as it sees the file.
  writeFileSync(join(brain, "owner-refused.json.tmp"), JSON.stringify({ name: (error as Error).name, message: (error as Error).message }));
  renameSync(join(brain, "owner-refused.json.tmp"), join(brain, "owner-refused.json"));
}
if (scenario === "detached") writeFileSync(join(brain, "owner-completed"), "done");
// Stay the live owner until the probe kills it (crash) or cleans up (detached).
await Bun.sleep(60_000);
