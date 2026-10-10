import { describe, expect, test } from "bun:test";
import { closeSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join, resolve } from "node:path";
import { launchAgentWorker, probeWorkerHost, workerBootstrap, workerCommand } from "../src/server/worker-launcher";
import { createWorkerPipes } from "../src/server/worker-pipes";

const GOLDEN = "Odysseus: only the server owns policy writes.\n";
const PAYLOAD = "Odysseus: scratch writer is functional.\n";
const ROOT = resolve(import.meta.dir, "../../..");

function fixture() {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/worker-boundary-"));
  const brain = join(root, "brain"), scratch = join(root, "scratch");
  const policies = join(brain, "context/policies"), policy = join(policies, "rule.md");
  mkdirSync(policies, { recursive: true }); mkdirSync(join(brain, "notes")); mkdirSync(scratch);
  writeFileSync(policy, GOLDEN);
  linkSync(policy, join(brain, "notes/hardlink.md"));
  linkSync(policy, join(scratch, "alias.md"));
  return { root, brain, scratch, policies, policy, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  for await (const chunk of stream as AsyncIterable<Buffer>) output += chunk.toString();
  return output;
}

describe("real bubblewrap worker launcher", () => {
  test("policy bytes and membership survive hardlinks and scratch aliases while scratch writes succeed", async () => {
    const f = fixture();
    try {
      const program = `import {writeFileSync,readFileSync,statfsSync} from "node:fs";
        const brain=${JSON.stringify(f.brain)}, scratch=process.env.BRAIN_WORKER_SCRATCH;
        for(const path of [brain+"/context/policies/rule.md",brain+"/notes/hardlink.md",scratch+"/alias.md"])
          try{writeFileSync(path,"changed policy")}catch{}
        try{writeFileSync(brain+"/context/policies/new.md","new policy")}catch{}
        writeFileSync(scratch+"/positive",${JSON.stringify(PAYLOAD)});
        console.log(JSON.stringify({scratch:readFileSync(scratch+"/positive","utf8"),
          scratchFilesystem:statfsSync(scratch).type.toString(16),
          inherited:process.env.ODYSSEUS_HOST_ONLY,explicit:process.env.ODYSSEUS_EXPLICIT}));`;
      const previous = process.env.ODYSSEUS_HOST_ONLY;
      process.env.ODYSSEUS_HOST_ONLY = "host-only";
      let worker;
      try { worker = launchAgentWorker({ brainPath: f.brain, scratchPath: f.scratch,
        command: [process.execPath, "-e", program], env: { ODYSSEUS_EXPLICIT: "explicit" } }); }
      finally { if (previous === undefined) delete process.env.ODYSSEUS_HOST_ONLY; else process.env.ODYSSEUS_HOST_ONLY = previous; }
      worker.stdin.end();
      const [code, output, errors] = await Promise.all([worker.exited, collect(worker.stdout), collect(worker.stderr)]);
      expect(errors).toBe(""); expect(code).toBe(0);
      expect(JSON.parse(output).scratch).toBe(PAYLOAD);
      // These observations are outside the namespace and do not trust a tool result.
      expect(readFileSync(f.policy, "utf8")).toBe(GOLDEN);
      expect(readFileSync(join(f.scratch, "alias.md"), "utf8")).toBe(GOLDEN);
      expect(readdirSync(f.policies)).toEqual(["rule.md"]);
      expect(JSON.parse(output)).toEqual({ scratch: PAYLOAD, explicit: "explicit", scratchFilesystem: "1021994" });
    } finally { f.cleanup(); }
  });

  test.each(["stdout", "stderr"] as const)("refuses policy-backed %s before a worker executes", (channel) => {
    const f = fixture(), pipes = createWorkerPipes();
    const fd = openSync(f.policy, "r+");
    try {
      const boot = workerBootstrap({ brainPath: f.brain, command: [process.execPath, "-e", "process.stdout.write('changed')"], env: {} });
      const child = Bun.spawnSync(boot.command, { env: boot.env, stdin: pipes.child[0],
        stdout: channel === "stdout" ? fd : pipes.child[1], stderr: channel === "stderr" ? fd : pipes.child[2] });
      pipes.closeChild(); pipes.closeInput();
      expect(child.exitCode).toBe(1);
      expect(readFileSync(f.policy, "utf8")).toBe(GOLDEN);
      if (channel === "stdout") expect(readFileSync(pipes.parent[2], "utf8")).toContain("protocol descriptor 1 must be a pipe");
      else expect(readFileSync(pipes.parent[1], "utf8")).toContain("protocol descriptor 2 must be a pipe");
      // A diagnostic on refused stderr may touch that descriptor; the worker
      // payload must never run. stderr rejection therefore must report on stdout.
    } finally { closeSync(fd); pipes.cleanup(); f.cleanup(); }
  });

  test("refuses inherited writable descriptor 3 before policy bytes can change", () => {
    const f = fixture(), pipes = createWorkerPipes(), fd = openSync(f.policy, "r+");
    try {
      const boot = workerBootstrap({ brainPath: f.brain, command: [process.execPath, "-e", "process.stdout.write('worker-started');try{require('node:fs').writeSync(3,'changed')}catch{}"], env: {} });
      const child = Bun.spawnSync(boot.command, { env: boot.env,
        stdio: [pipes.child[0], pipes.child[1], pipes.child[2], fd] });
      pipes.closeChild(); pipes.closeInput();
      expect(child.exitCode).toBe(1);
      expect(readFileSync(pipes.parent[2], "utf8")).toContain("non-protocol descriptor 3 would be inherited");
      expect(readFileSync(f.policy, "utf8")).toBe(GOLDEN);
      expect(readdirSync(f.policies)).toEqual(["rule.md"]);
    } finally { closeSync(fd); pipes.cleanup(); f.cleanup(); }
  });

  test("actual configured-brain probe passes and removes all disposable sentinels", () => {
    const f = fixture();
    try {
      expect(probeWorkerHost(f.brain)).toEqual({ ok: true });
      expect(readdirSync(f.brain).sort()).toEqual(["context", "notes"]);
      expect(workerCommand({ brainPath: f.brain, command: [process.execPath], env: {} })).not.toContain("--overlay");
      const versions = Object.fromEntries(["@anthropic-ai/claude-agent-sdk", "@earendil-works/pi-coding-agent",
        "@schlessera/brain-backend-claude", "@schlessera/brain-backend-pi"].map(name =>
        [name, JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8")).version]));
      const native = Bun.spawnSync([join(ROOT, "node_modules", `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`, "claude"), "--version"],
        { env: {}, stdout: "pipe", stderr: "pipe" });
      expect(native.exitCode).toBe(0);
      versions["claude-code"] = native.stdout.toString().trim();
      const mount = Bun.spawnSync([Bun.which("findmnt")!, "--target", f.brain, "--noheadings", "--output", "FSTYPE"]);
      expect(mount.exitCode).toBe(0);
      const tuple = { architecture: process.arch, kernel: release(), bun: Bun.version,
        bubblewrap: Bun.spawnSync([Bun.which("bwrap")!, "--version"]).stdout.toString().trim(),
        brainFilesystem: statfsSync(f.brain).type.toString(16), brainFilesystemName: mount.stdout.toString().trim(), scratchFilesystem: "1021994", versions,
        proof: "launcher escape/stdio/descriptor/scratch tests and actual configured-brain probe; adapters not moved into workers" };
      console.log("worker-host tuple", JSON.stringify(tuple));
      mkdirSync(join(ROOT, "tmp"), { recursive: true });
      writeFileSync(join(ROOT, "tmp/worker-host-probe.json"), JSON.stringify(tuple, null, 2) + "\n");
    } finally { f.cleanup(); }
  });

  test("closes non-protocol runtime descriptors before fixture code executes", async () => {
    const f = fixture();
    try {
      const python = Bun.which("python3"); expect(python).not.toBeNull();
      const program = "import os,json\nheld=[]\nfor fd in os.listdir('/proc/self/fd'):\n if int(fd)>2:\n  try: held.append(os.readlink('/proc/self/fd/'+fd))\n  except FileNotFoundError: pass\nprint(json.dumps(held))";
      const worker = launchAgentWorker({ brainPath: f.brain, command: [python!, "-c", program], env: {} });
      worker.stdin.end();
      const [code, output, errors] = await Promise.all([worker.exited, collect(worker.stdout), collect(worker.stderr)]);
      expect(errors).toBe(""); expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual([]);
    } finally { f.cleanup(); }
  });

  test("scratch cannot be mounted writable inside the authoritative brain", () => {
    const f = fixture();
    try { mkdirSync(join(f.brain, "scratch")); expect(() => workerCommand({ brainPath: f.brain, scratchPath: join(f.brain, "scratch"),
      command: [process.execPath], env: {} })).toThrow("outside the authoritative brain"); }
    finally { f.cleanup(); }
  });
});
