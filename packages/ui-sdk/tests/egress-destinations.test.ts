/**
 * The egress proxy's destination address policy (#3687): the proxy resolves
 * each destination itself, refuses non-public addresses and unlisted ports,
 * and connects to the address it checked.
 */
import { afterEach, expect, test } from "bun:test";
import { connect, createServer, type Server } from "node:net";
import { request } from "node:http";
import { egressAddressRefusal, startEgressProxy, type EgressProxyOptions, type EgressRecord } from "../src/server/egress-proxy.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const step of cleanup.splice(0)) step(); });

/** A loopback service that answers any request with a fixed line. */
async function service(reply: string): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server: Server = createServer(socket => {
    hits++;
    socket.on("data", () => socket.end(`HTTP/1.1 200 OK\r\ncontent-length: ${reply.length}\r\nconnection: close\r\n\r\n${reply}`));
    socket.on("error", () => {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  return { port: (server.address() as { port: number }).port, hits: () => hits };
}

/** A fictional resolver: the proxy, not the client, decides where a name goes. */
const names: Record<string, Array<{ address: string; family: number }>> = {
  "ithaca.test": [{ address: "127.0.0.1", family: 4 }],
  "mixed.test": [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }],
  "metadata.test": [{ address: "169.254.169.254", family: 4 }],
};
const lookup = async (host: string) => { const answer = names[host]; if (!answer) throw new Error("ENOTFOUND"); return answer; };

async function proxy(records: EgressRecord[], extra: Partial<EgressProxyOptions> = {}) {
  const started = await startEgressProxy({ mode: "record", allow: [], deny: [], maxBytes: 1 << 20, outwardHosts: [], observe: record => records.push(record), ...extra });
  cleanup.push(() => started.stop());
  return started;
}
function get(socketPath: string, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: target, method: "GET" }, response => {
      let text = ""; response.on("data", bytes => text += bytes);
      response.on("end", () => resolve({ status: response.statusCode!, body: text })); response.on("error", reject);
    });
    req.on("error", reject); req.end();
  });
}
function tunnel(socketPath: string, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let text = "";
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on("data", data => { text += data; if (/^HTTP\/1\.1 (?:200|403)/.test(text) && text.includes("\r\n\r\n")) socket.end(); });
    socket.on("close", () => resolve(text)); socket.on("error", reject);
  });
}
const settled = async (records: EgressRecord[], count: number) => { for (let i = 0; records.length < count && i < 5000; i++) await Bun.sleep(1); };

test("every non-public address class is refused, metadata even inside an allowed range", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "100.64.0.1", "169.254.10.10", "0.0.0.0", "224.0.0.1",
    "::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "not-an-address"]) {
    expect(egressAddressRefusal(address), `EGRESS_NON_PUBLIC_${address}`).not.toBeNull();
  }
  for (const address of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) expect(egressAddressRefusal(address), address).toBeNull();
  const everything = new (require("node:net").BlockList)();
  everything.addSubnet("0.0.0.0", 0, "ipv4"); everything.addSubnet("::", 0, "ipv6");
  expect(egressAddressRefusal("10.1.2.3", everything)).toBeNull();
  for (const address of ["169.254.169.254", "fd00:ec2::254", "100.100.100.200", "::ffff:169.254.169.254"]) {
    expect(egressAddressRefusal(address, everything), `EGRESS_METADATA_NEVER_${address}`).toBe("metadata_destination");
  }
});

test("a private destination is refused before any connection, over HTTP and CONNECT alike", async () => {
  const records: EgressRecord[] = [], target = await service("Penelope's loom");
  const started = await proxy(records, { destinations: { lookup, ports: [target.port] } });
  const plain = await get(started.socketPath, `http://ithaca.test:${target.port}/loom`);
  expect(plain.status, "EGRESS_PRIVATE_HTTP_REFUSED").toBe(403);
  expect(plain.body).toContain("not a public web address");
  expect(await tunnel(started.socketPath, `ithaca.test:${target.port}`), "EGRESS_PRIVATE_CONNECT_REFUSED").toMatch(/^HTTP\/1\.1 403 Forbidden - not a public web address/);
  expect(await tunnel(started.socketPath, `127.0.0.1:${target.port}`), "EGRESS_PRIVATE_LITERAL_REFUSED").toMatch(/^HTTP\/1\.1 403/);
  expect(await tunnel(started.socketPath, `metadata.test:80`.replace("80", String(target.port)))).toMatch(/^HTTP\/1\.1 403/);
  expect(await tunnel(started.socketPath, `mixed.test:${target.port}`), "EGRESS_MIXED_ANSWER_REFUSED").toMatch(/^HTTP\/1\.1 403/);
  expect(await tunnel(started.socketPath, `nowhere.test:${target.port}`), "EGRESS_UNRESOLVED_REFUSED").toMatch(/^HTTP\/1\.1 403/);
  await settled(records, 6);
  expect(target.hits(), "EGRESS_REFUSED_NEVER_CONNECTS").toBe(0);
  expect(records.map(record => record.reason)).toEqual(["private_destination", "private_destination", "private_destination",
    "metadata_destination", "private_destination", "unresolved_destination"]);
});

test("an allowed range reaches the checked address, and an unlisted port is refused", async () => {
  const records: EgressRecord[] = [], target = await service("Telemachus watches the harbour");
  const started = await proxy(records, { destinations: { lookup, ports: [target.port], allowRanges: ["127.0.0.0/8"] } });
  const plain = await get(started.socketPath, `http://ithaca.test:${target.port}/harbour`);
  expect(plain, "EGRESS_ALLOWED_RANGE_HTTP").toEqual({ status: 200, body: "Telemachus watches the harbour" });
  expect(await tunnel(started.socketPath, `ithaca.test:${target.port}`), "EGRESS_ALLOWED_RANGE_CONNECT").toMatch(/^HTTP\/1\.1 200/);
  expect(await tunnel(started.socketPath, `ithaca.test:${target.port + 1 === 65536 ? 1 : target.port + 1}`), "EGRESS_PORT_REFUSED")
    .toMatch(/^HTTP\/1\.1 403 Forbidden - destination port not allowed/);
  expect(await tunnel(started.socketPath, "metadata.test:443")).toMatch(/^HTTP\/1\.1 403/);
});

test("the connection goes to the address admission checked, not a second answer", async () => {
  const records: EgressRecord[] = [], target = await service("the checked address");
  let calls = 0;
  // A rebinding resolver: public on the check, private afterwards. The proxy asks once and connects there.
  const rebinding = async () => { calls++; return [{ address: "127.0.0.1", family: 4 }]; };
  const started = await proxy(records, { destinations: { lookup: rebinding, ports: [target.port], allowRanges: ["127.0.0.0/8"] } });
  expect((await get(started.socketPath, `http://rebind.test:${target.port}/`)).body).toBe("the checked address");
  expect(calls, "EGRESS_SINGLE_RESOLUTION").toBe(1);
});
