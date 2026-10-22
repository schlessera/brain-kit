/**
 * Trusted worker-side `ProxyCommand`: one opaque CONNECT through the turn's
 * egress socket, then raw stdio. SSH keeps its own end-to-end encryption; the
 * proxy sees only host, port and byte counts, like any other CONNECT.
 */
import { connect } from "node:net";
import { WORKER_EGRESS_SOCKET } from "./egress-proxy.js";

const [host, port] = process.argv.slice(2);
if (!host || !/^[a-zA-Z0-9.-]+$/.test(host) || !port || !/^[0-9]{1,5}$/.test(port)) {
  process.stderr.write("usage: egress-connect <host> <port>\n");
  process.exit(2);
}
const upstream = connect(WORKER_EGRESS_SOCKET);
let header = Buffer.alloc(0);
let established = false;
upstream.once("connect", () => upstream.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
upstream.on("data", (chunk: Buffer) => {
  if (established) { if (!process.stdout.write(chunk)) upstream.pause(); return; }
  header = Buffer.concat([header, chunk]);
  const end = header.indexOf("\r\n\r\n");
  if (end < 0) { if (header.length > 8192) { process.stderr.write("egress proxy: oversized response\n"); process.exit(1); } return; }
  const status = header.subarray(0, header.indexOf("\r\n")).toString("latin1");
  if (!/^HTTP\/1\.[01] 200 /.test(status)) {
    process.stderr.write(`egress proxy refused ${host}:${port}: ${status}\n`);
    process.exit(1);
  }
  established = true;
  const rest = header.subarray(end + 4);
  if (rest.length) process.stdout.write(rest);
  process.stdin.on("data", data => { if (!upstream.write(data)) process.stdin.pause(); });
  upstream.on("drain", () => process.stdin.resume());
  process.stdout.on("drain", () => upstream.resume());
  process.stdin.once("end", () => upstream.end());
});
upstream.once("error", error => { process.stderr.write(`egress proxy unavailable: ${error.message}\n`); process.exit(1); });
upstream.once("close", () => process.exit(established ? 0 : 1));
