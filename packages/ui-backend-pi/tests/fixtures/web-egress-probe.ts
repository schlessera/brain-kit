/**
 * Runs inside the web executor's boundary (#3687) and tries every way out:
 * a direct socket, a spawned curl told to skip the proxy, and fetch under a
 * proxy-bypass setting, each to a host address outside the namespace. Then,
 * as the positive control, the route itself. Prints one JSON line.
 */
import { connect } from "node:net";
const [address, port, routed] = process.argv.slice(2);
const outcome: Record<string, string> = {};
outcome.socket = await new Promise<string>(resolve => {
  const socket = connect({ host: address!, port: Number(port) });
  socket.once("connect", () => { socket.destroy(); resolve("connected"); });
  socket.once("error", error => resolve(`refused:${(error as NodeJS.ErrnoException).code}`));
  setTimeout(() => { socket.destroy(); resolve("refused:timeout"); }, 3000);
});
const curl = Bun.spawnSync(["curl", "--silent", "--max-time", "3", "--noproxy", "*", `http://${address}:${port}/`], { stdout: "pipe", stderr: "pipe" });
outcome.curl = curl.exitCode === 0 && curl.stdout.toString().includes("Odysseus") ? "connected" : `refused:${curl.exitCode}`;
process.env.NO_PROXY = "*"; process.env.no_proxy = "*";
outcome.bypass = await fetch(`http://${address}:${port}/`, { signal: AbortSignal.timeout(3000) })
  .then(async response => (await response.text()).includes("Odysseus") ? "connected" : `refused:${response.status}`, (error: Error) => `refused:${error.name}`);
delete process.env.NO_PROXY; delete process.env.no_proxy;
outcome.routed = await fetch(routed!, { signal: AbortSignal.timeout(5000) })
  .then(async response => `${response.status}:${(await response.text()).trim()}`, (error: Error) => `failed:${error.message}`);
console.log(JSON.stringify(outcome));
