/** Diagnostic-only control: canonical offline envelope, one owned minor, never product proof. */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readlinkSync, chmodSync, realpathSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { nativeHostDockerArgs, NATIVE_PROOF_IMAGE } from "../prove-native-host";

export function heldVariant(source: string): string {
  const replace = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw Error("Held control fixture anchor changed");
    source = source.replace(before, after);
  };
  replace('control = loop = image = None', 'exec(compile(pathlib.Path("/repo/scripts/native-proof/held-loop-control.py").read_text(), "held-loop-control", "exec"))\ncontrol = loop = image = None');
  replace('run(["/usr/local/bin/bun", "run", "test", str(pathlib.Path(__file__).with_name("hosted-app.test.ts"))], timeout=HOSTED_TIMEOUT)', 'held_begin()');
  replace('            remove_evidence(error)', '            remove_evidence(error)\n            try: held_busy(error); created = False\n            except BaseException as diagnostic: errors.append("Held control: " + type(diagnostic).__name__)');
  replace('    if control is not None: os.close(control)', '    try: held_abort()\n    except BaseException as diagnostic: errors.append("Held abort: " + type(diagnostic).__name__)\n    if control is not None: os.close(control)');
  return source;
}

export function heldDockerArgs(root: string, artifact: string, bun: string, name: string): string[] {
  const args = nativeHostDockerArgs(root, artifact, "1000", "claude", true, false, bun);
  args.splice(2, 0, "--name", name, "--label", `brain-kit.held-owner=${name}`, "-i");
  args[args.indexOf("/repo/scripts/native-proof/fixture.py")] = "/proof/control-fixture.py";
  return args;
}

async function command(args: string[], timeoutMs = 5000): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([new Response(child.stdout).text(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Owned command deadline")), timeoutMs); })]);
    if (await Promise.race([child.exited, new Promise<number>(resolve => setTimeout(() => resolve(-1), 1000))]) !== 0) throw Error("Owned command failed");
    return output;
  } finally { if (timer) clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../.."), parent = join(root, "tmp/native-host-proof");
  mkdirSync(parent, { recursive: true });
  const artifact = mkdtempSync(join(parent, "run-held-control-")); chmodSync(artifact, 0o755);
  const name = "brain-held-" + basename(artifact).slice("run-held-control-".length).toLowerCase();
  let child: Bun.Subprocess<"pipe", "pipe", "inherit"> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let original: unknown, witnessed = false, invoked = false;
  try {
    const image = JSON.parse(await command(["docker", "image", "inspect", NATIVE_PROOF_IMAGE]));
    const security = JSON.parse(await command(["docker", "info", "--format", "{{json .SecurityOptions}}"]));
    if (!security.some((value: string) => value.startsWith("name=apparmor"))) throw Error("Named AppArmor required for this control");
    writeFileSync(join(artifact, "native-environment.json"), JSON.stringify({ backend: "claude", appUid: 1000, apparmor: true }));
    writeFileSync(join(artifact, "control-image.json"), JSON.stringify({ imageId: image[0].Id, repoDigests: image[0].RepoDigests, tag: NATIVE_PROOF_IMAGE }));
    writeFileSync(join(artifact, "control-fixture.py"), heldVariant(readFileSync(join(root, "scripts/native-proof/fixture.py"), "utf8")));
    mkdirSync(join(root, "tmp/workspace-operation"), { recursive: true });
    const args = heldDockerArgs(root, artifact, realpathSync(process.execPath), name);
    child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    invoked = true;
    const running = child;
    const consume = (async () => {
      let pending = "", count = 0;
      const log = Bun.file(join(artifact, "control.stdout.log")).writer();
      try {
        for await (const bytes of running.stdout as ReadableStream<Uint8Array>) {
          count += bytes.length; if (count > 2 * 1024 * 1024) throw Error("Control output bound"); log.write(bytes);
          pending += new TextDecoder().decode(bytes);
          if (pending.length > 65536) throw Error("Control framing bound");
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            if (!line.startsWith("{")) continue;
            const row = JSON.parse(line);
            if (row.kind !== "held-control" || row.phase !== "holder-ready") continue;
            if (witnessed || !/^OdH[0-9a-f]{12}$/.test(row.comm)) throw Error("Holder witness identity");
            const top = await command(["docker", "top", name, "-eo", "pid,comm"]);
            const matches = top.split("\n").map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === row.comm);
            if (matches.length !== 1 || !/^\d+$/.test(matches[0]![0]!)) throw Error("Owned container holder PID missing or ambiguous");
            const hostPid = Number(matches[0]![0]), proc = `/proc/${hostPid}`;
            const start = readFileSync(`${proc}/stat`, "utf8").split(")").at(-1)!.trim().split(/\s+/)[19];
            const status = readFileSync(`${proc}/status`, "utf8");
            const nsPids = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
            const init = (await command(["docker", "inspect", "--format", "{{.State.Pid}}", name])).trim();
            if (start !== row.start || nsPids?.at(-1) !== row.pid || readlinkSync(`${proc}/ns/pid`) !== readlinkSync(`/proc/${init}/ns/pid`)) throw Error("Owned PID/start/namespace witness mismatch");
            const ack = { hostPid, containerPid: row.pid, start, comm: row.comm, witnessMonoNs: String(process.hrtime.bigint()) };
            writeFileSync(join(artifact, "holder-host-witness.json"), JSON.stringify(ack));
            witnessed = true; running.stdin.write(JSON.stringify(ack) + "\n"); await running.stdin.flush();
          }
        }
        if (pending) throw Error("Control output unterminated");
      } finally { await log.end(); }
    })();
    const done = Promise.all([running.exited, consume]);
    const [code] = await Promise.race([done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Held control 60-second deadline")), 60000); })]);
    const rows = JSON.parse(readFileSync(join(artifact, "native-fixture.json"), "utf8"));
    const phases = rows.filter((row: any) => row.kind === "held-control").map((row: any) => row.phase);
    const cleanup = rows.at(-1);
    if (code !== 1 || !witnessed || ["holder-ready", "host-witness", "expected-remove-ebusy", "holder-reaped", "post-release-unbound", "owned-entry-removed"].some(phase => !phases.includes(phase)) || rows.some((row: any) => row.kind === "failure") || cleanup?.kind !== "cleanup" || cleanup.mounted || cleanup.attached || cleanup.loopCreated || cleanup.backingExists || cleanup.errors?.length !== 1 || !cleanup.errors[0].includes("[Errno 16]")) throw Error("Held control receipt mismatch; original failure retained");
    writeFileSync(join(artifact, "control-verdict.json"), JSON.stringify({ kind: "CONTROL_EXPECTED_REMOVE_FAILURE_VERIFIED", qualification: false, originalFixtureExit: code }));
  } catch (error) { original = error; console.error(error); }
  finally {
    if (timer) clearTimeout(timer);
    if (child?.exitCode === null) child.kill("SIGKILL");
    // Only a container bearing this invocation's exact ownership label may be removed.
    let absent: boolean | null = null;
    if (invoked) {
      try {
        const names = (await command(["docker", "ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"])).trim();
        if (names) {
          const owned = JSON.parse(await command(["docker", "inspect", name]));
          if (owned[0]?.Config?.Labels?.["brain-kit.held-owner"] !== name) throw Error("Refuse foreign container cleanup");
          await command(["docker", "rm", "--force", name]);
        }
        absent = (await command(["docker", "ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"])).trim() === "";
      } catch (cleanup) { original ??= cleanup; }
    } else absent = true;
    writeFileSync(join(artifact, "control-container-cleanup.json"), JSON.stringify({ absent }));
    if (absent !== true) original ??= Error("Owned control container absence unproved");
  }
  if (original) process.exitCode = 1;
}
