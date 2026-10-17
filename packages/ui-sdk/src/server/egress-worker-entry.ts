/** Trusted worker bootstrap: raw TCP loopback forwarding, before running any tool. */
import { createServer, connect } from "node:net";
import { WORKER_EGRESS_SOCKET } from "./egress-proxy.js";
import { workerEgressEnvironment } from "../config/env.js";

const command = process.argv.slice(2);
if (!command[0]?.startsWith("/")) throw new Error("Egress bootstrap requires an absolute executable");
const sockets = new Set<import("node:net").Socket>();
const track = (socket: import("node:net").Socket) => {
  sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); return socket;
};
const forwarder = createServer(peer => {
  track(peer);
  const upstream = track(connect(WORKER_EGRESS_SOCKET));
  peer.pipe(upstream); upstream.pipe(peer);
  peer.once("error", () => upstream.destroy()); upstream.once("error", () => peer.destroy());
  peer.once("close", () => upstream.destroy()); upstream.once("close", () => peer.destroy());
});
await new Promise<void>((resolve, reject) => {
  forwarder.once("error", reject); forwarder.listen(0, "127.0.0.1", () => { forwarder.removeListener("error", reject); resolve(); });
});
const port = (forwarder.address() as { port: number }).port;
const proxy = `http://127.0.0.1:${port}`;
// Preserve runtime authentication and endpoint selection. Only transport changes.
const env = { ...workerEgressEnvironment(), HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
  http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, NO_PROXY: "", no_proxy: "" };
const child = Bun.spawn(command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const terminate = () => child.kill("SIGTERM");
process.on("SIGTERM", terminate); process.on("SIGINT", terminate);
try { process.exitCode = await child.exited; }
finally {
  process.off("SIGTERM", terminate); process.off("SIGINT", terminate);
  for (const socket of sockets) socket.destroy(); forwarder.close();
}
