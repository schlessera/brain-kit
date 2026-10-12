/** Disposable host /run inside an offline namespace; the worker must mask its socket. */
import { prepareWorkerSandbox, workerCommand } from "../../packages/ui-sdk/src/server/worker-launcher.js";
const brain = process.argv[2]!;
const socket = "/run/odysseus-host.sock";
let hits = 0;
const server = Bun.listen({ unix: socket, socket: { open(client) { hits++; client.end(); }, data() {} } });
try {
  const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [], readPaths: [process.execPath] });
  const child = Bun.spawn(workerCommand({ brainPath: brain, sandbox, env: {}, command: [process.execPath, "--config=/dev/null", "--no-env-file", "-e",
    `const net=require("node:net"); const client=net.connect(${JSON.stringify(socket)}); client.on("connect",()=>process.exit(41)); client.on("error",()=>process.exit(0)); setTimeout(()=>process.exit(42),1000);`] }),
    { env: {}, stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  const errors = await new Response(child.stderr).text();
  if (errors) process.stderr.write(errors);
  console.log(JSON.stringify({ code, hits }));
} finally { server.stop(true); }
