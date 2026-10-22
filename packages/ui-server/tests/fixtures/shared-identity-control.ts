/** Namespace-owned fixture; exercise actual operational masks without an ambient parent mask. */
import { prepareWorkerSandbox, workerCommand } from "../../../ui-sdk/src/server/worker-launcher.js";
import { operationalStateMasks } from "../../src/brain/operational-state.js";

const input = JSON.parse(await Bun.stdin.text());
const brain = "/opt/odysseus-identity/brain", dbPath = "/opt/odysseus-identity/server-state/brain-ui.db";
const sandbox = prepareWorkerSandbox(brain, { profile: input.profile, areas: [], readPaths: [],
  maskPaths: operationalStateMasks({ brainPath: brain, dbPath }) });
const child = Bun.spawnSync(workerCommand({ brainPath: brain, sandbox, env: {}, command: input.command }),
  { env: {}, stdout: "pipe", stderr: "pipe" });
process.stdout.write(child.stdout);
process.stderr.write(child.stderr);
process.exit(child.exitCode);
