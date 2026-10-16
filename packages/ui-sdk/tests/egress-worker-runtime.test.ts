/** Real isolated transport controls. Proxy upstreams are restricted to this loopback fixture. */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { startEgressProxy, type EgressRecord } from "../src/server/egress-proxy.js";
import { launchFixtureAgentWorker } from "./helpers/worker-startup-view-fixture.js";
import type { WorkerSandbox } from "../src/server/worker-sandbox.js";

test.each(["strict", "governed"] as const)("%s real worker uses proxy while direct TCP and host sockets remain unavailable", async profile => {
  const root = resolve(import.meta.dir, "../../../tmp"); mkdirSync(root, { recursive: true });
  const fixture = mkdtempSync(join(root, "odysseus-egress-"));
  const brain = join(fixture, "brain"); mkdirSync(brain);
  const records: EgressRecord[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Odysseus reaches Ithaca") });
  const certificate = join(brain, "ca.pem"), key = join(fixture, "key.pem");
  const certificateProcess = Bun.spawnSync(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate], { stdout: "pipe", stderr: "pipe" });
  expect(certificateProcess.exitCode, certificateProcess.stderr.toString()).toBe(0);
  const tlsOrigin = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: readFileSync(key), cert: readFileSync(certificate) },
    fetch: () => new Response("Odysseus reaches Ithaca over TLS") });
  const socketPath = join(fixture, "host.sock"); let socketConnections = 0;
  const hostSocket = createServer(socket => { socketConnections++; socket.end("host bytes"); });
  await new Promise<void>(resolve => hostSocket.listen(socketPath, resolve));
  const proxy = await startEgressProxy({ mode: "allowlist", allow: ["127.0.0.1"], deny: [], outwardHosts: [],
    maxBytes: 64 * 1024, observe: record => records.push(record) });
  const sandbox: WorkerSandbox = { brain, restricted: false, profile, areas: [], scratchAliasesRemoved: [],
    ...(profile === "governed" ? { protection: { paths: [], ancestors: [] } } : {}) };
  const program = `
    const url=${JSON.stringify(origin.url.href)};
    const result={};
    const direct=await import("node:net");
    result.direct=await new Promise(resolve=>{const socket=direct.connect({host:"127.0.0.1",port:${origin.port}});
      socket.on("connect",()=>{resolve(true);socket.destroy()});socket.on("error",()=>resolve(false));});
    result.explicit=await(await fetch(url,{proxy:process.env.HTTP_PROXY})).text();
    try{result.automatic=await(await fetch(url)).text()}catch{result.automatic="unavailable"}
    const curl=Bun.spawn(["/usr/bin/curl","--silent","--show-error","--fail","--max-time","3",url],{stdout:"pipe",stderr:"pipe"});
    result.curl=await new Response(curl.stdout).text();result.curlExit=await curl.exited;
    const tls=Bun.spawn(["/usr/bin/curl","--silent","--show-error","--fail","--max-time","3","--cacert",${JSON.stringify(certificate)},${JSON.stringify(tlsOrigin.url.href)}],{stdout:"pipe",stderr:"pipe"});
    result.tls=await new Response(tls.stdout).text();result.tlsError=await new Response(tls.stderr).text();result.tlsExit=await tls.exited;
    result.hostSocket=await new Promise(resolve=>{const socket=direct.connect(${JSON.stringify(socketPath)});socket.on("connect",()=>{resolve(true);socket.destroy()});socket.on("error",()=>resolve(false));});
    result.capabilities=(await Bun.file("/proc/self/status").text()).match(/^CapEff:\\s+(.*)$/m)?.[1];
    console.log(JSON.stringify(result));
  `;
  let worker: ReturnType<typeof launchFixtureAgentWorker> | undefined;
  try {
    worker = launchFixtureAgentWorker({ brainPath: brain, command: [process.execPath, "-e", program],
      env: { PATH: "/usr/bin:/bin", HOME: "/tmp/odysseus" }, sandbox, egress: { proxyDir: proxy.dir }, turnTempBytes: 16 * 1024 * 1024 });
    worker.stdin.end();
    const output = new Response(worker.stdout as never).text(), errors = new Response(worker.stderr as never).text();
    const [code, stdout, stderr] = await Promise.all([worker.exited, output, errors]);
    expect(code, stderr).toBe(0);
    expect(stdout.startsWith("{"), stdout).toBe(true);
    const result = JSON.parse(stdout);
    expect(result.direct, "EGRESS_NO_DIRECT_TCP").toBe(false);
    expect(result.explicit).toBe("Odysseus reaches Ithaca");
    expect(result.curlExit, "EGRESS_REAL_CURL_PROXY").toBe(0);
    expect(result.curl).toBe("Odysseus reaches Ithaca");
    expect(result.tlsExit, String(result.tlsError)).toBe(0);
    expect(result.tls).toBe("Odysseus reaches Ithaca over TLS");
    expect(result.hostSocket, "EGRESS_HOST_HOME_SOCKET_MASKED").toBe(false);
    expect(socketConnections).toBe(0);
    expect(result.capabilities).toBe("0000000000000000");
    expect(records.filter(record => record.outcome === "completed").length).toBeGreaterThanOrEqual(2);
    expect(records.some(record => record.method === "CONNECT" && record.bytes > 0 && record.path === undefined)).toBe(true);
    console.log(`EGRESS_MEASUREMENT_${profile}=${JSON.stringify(result)}`);
  } finally { worker?.turnTemp?.close(); proxy.stop(); origin.stop(true); tlsOrigin.stop(true); hostSocket.close(); rmSync(fixture, { recursive: true, force: true }); }
});
