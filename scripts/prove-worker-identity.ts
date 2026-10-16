/** Real cross-UID broker proof; fixture elevation exists only in this container. */
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { NATIVE_PROOF_IMAGE } from "./prove-native-host.js";
import { WORKER_FILESYSTEM_FILTER_PROGRAM } from "../packages/ui-sdk/src/server/worker-filesystem-filter.js";

if (import.meta.main) {
  try {
    if (process.platform !== "linux" || process.arch !== "x64") throw Error("Identity proof requires qualified Linux x86_64");
    const options = process.argv.slice(2);
    if (options.some(arg => !/^--image=[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(arg) && !/^--mutation=(ignored-signals|supervisor-zombie|sentinel-modes)$/.test(arg)) || new Set(options.map(arg=>arg.split("=")[0])).size!==options.length) throw Error("Usage: prove-worker-identity.ts [--image=<prepared-native-image>] [--mutation=ignored-signals|supervisor-zombie|sentinel-modes]");
    const image = options.find(arg=>arg.startsWith("--image="))?.slice("--image=".length) ?? NATIVE_PROOF_IMAGE;
    const mutation = options.find(arg=>arg.startsWith("--mutation="))?.slice("--mutation=".length);
    const changed = (text: string, before: string, after: string) => { if(!text.includes(before))throw Error("Identity fixture mutation anchor changed");return text.replace(before,after); };
    const source = resolve(import.meta.dir, ".."), output = join(source, "tmp", "worker-identity-proof");
    mkdirSync(output, { recursive: true });
    const artifact = mkdtempSync(join(output, "run-")); chmodSync(artifact, 0o755);
    const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
    const helperSource = join(source, "packages/ui-sdk/tests/fixtures/identity-helper.c");
    const helper = join(artifact, "identity-helper");
    const compile = Bun.spawnSync(["cc", "-O2", "-Wall", "-Wextra", helperSource, "-o", helper], { stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(artifact, "compile.log"), compile.stdout.toString() + compile.stderr.toString());
    if (compile.exitCode !== 0) throw Error(`Identity fixture compilation failed; inspect ${artifact}`);
    chmodSync(helper, 0o755); // Host binary is never setuid; installation is container-only.
    const filter = join(artifact, "filesystem-filter.py"); writeFileSync(filter, WORKER_FILESYSTEM_FILTER_PROGRAM);
    let helperScript=readFileSync(join(source,"packages/ui-sdk/tests/fixtures/identity-helper.py"),"utf8");
    if(mutation==="ignored-signals")helperScript=changed(helperScript,'os.execve("/usr/bin/env", ["env", "--default-signal", *(prefix + argv)], {})','os.execve((prefix + argv)[0], prefix + argv, {})');
    if(mutation==="supervisor-zombie")helperScript=changed(helperScript,'if supervisor["state"] not in ("Z", "X"):', 'if True:');
    const helperScriptPath=join(artifact,"helper.py");writeFileSync(helperScriptPath,helperScript);
    const nonDroppingScript=join(artifact,"non-dropping.py");writeFileSync(nonDroppingScript,changed(helperScript,"SERVER_UID, WORKER_UID, SHARED_GID = 21001, 21002, 21001","SERVER_UID, WORKER_UID, SHARED_GID = 21001, 21001, 21001"));
    const nonDroppingC=join(artifact,"non-dropping.c"),nonDroppingHelper=join(artifact,"identity-helper-non-dropping");
    writeFileSync(nonDroppingC,changed(readFileSync(helperSource,"utf8"),'/usr/local/lib/brain-identity-fixture/helper.py','/usr/local/lib/brain-identity-fixture/non-dropping.py'));
    const nonDroppingCompile=Bun.spawnSync(["cc","-O2","-Wall","-Wextra",nonDroppingC,"-o",nonDroppingHelper],{stdout:"pipe",stderr:"pipe"});
    writeFileSync(join(artifact,"compile-non-dropping.log"),nonDroppingCompile.stdout.toString()+nonDroppingCompile.stderr.toString());
    if(nonDroppingCompile.exitCode!==0)throw Error("Non-dropping fixture compilation failed");chmodSync(nonDroppingHelper,0o755);
    const faultEdits: Record<string, [string, string]> = {
      "malformed-status": ['    send(connection, {})\n    connection.close()', '    os.write(request["statusFd"], b"not-json\\n")\n    send(connection, {})\n    connection.close()'],
      "wrong-pid": ['    send(connection, {})\n    connection.close()', '    os.write(request["statusFd"], json.dumps({"child-pid": 2147483647}).encode() + b"\\n")\n    send(connection, {})\n    connection.close()'],
      "wrong-namespace": ['    # Ensure temporary privileged control handles never enter the payload.', '    argv.remove("--unshare-pid")\n    # Ensure temporary privileged control handles never enter the payload.'],
      "wrong-uid": ['        send(connection, {"workerUid": WORKER_UID, "roots": result["roots"]}, fds)', '        send(connection, {"workerUid": -1, "roots": result["roots"]}, fds)'],
      "wrong-root-identity": ['        send(connection, {"workerUid": WORKER_UID, "roots": result["roots"]}, fds)', '        result["roots"][0]["ino"] += 1\n        send(connection, {"workerUid": WORKER_UID, "roots": result["roots"]}, fds)'],
      "wrong-allowance": ['        send(connection, {"workerUid": WORKER_UID, "roots": result["roots"]}, fds)', '        result["roots"][0]["bytes"] += 4096\n        send(connection, {"workerUid": WORKER_UID, "roots": result["roots"]}, fds)'],
      "wrong-type": ['        send(connection, {"workerUid": WORKER_UID, "roots": result["roots"]}, fds)', '        os.close(fds[0]); fds[0] = os.open("/dev/null", os.O_RDONLY)\n        send(connection, {"workerUid": WORKER_UID, "roots": result["roots"]}, fds)'],
      "extra-fd": ['        send(connection, {"workerUid": WORKER_UID, "roots": result["roots"]}, fds)', '        fds.append(os.dup(fds[0]))\n        send(connection, {"workerUid": WORKER_UID, "roots": result["roots"]}, fds)'],
      "foreign-mount": ['        info = os.stat(source)', '        foreign = source + "/foreign"\n        os.mkdir(foreign, 0o755)\n        foreign_options = ("size=4096,mode=2770,uid=%s,gid=%s" % (SERVER_UID, SHARED_GID)).encode()\n        if libc.mount(b"tmpfs", foreign.encode(), b"tmpfs", 2 | 4, foreign_options): refuse("foreign_fixture_mount")\n        info = os.stat(source)'],
    };
    const faultHashes: Record<string, { script: string; binary: string }> = {};
    for (const [name, [before, after]] of Object.entries(faultEdits)) {
      const script = changed(helperScript, before, after), scriptPath = join(artifact, `fault-${name}.py`);
      writeFileSync(scriptPath, script);
      const parsed = Bun.spawnSync(["python3", "-I", "-S", "-c", "import ast,sys;ast.parse(open(sys.argv[1]).read())", scriptPath], { stdout: "pipe", stderr: "pipe" });
      if (parsed.exitCode !== 0) throw Error(`Invalid fault fixture ${name}: ${parsed.stderr.toString()}`);
      const cPath = join(artifact, `fault-${name}.c`), binary = join(artifact, `identity-helper-fault-${name}`);
      writeFileSync(cPath, changed(readFileSync(helperSource, "utf8"), "/usr/local/lib/brain-identity-fixture/helper.py", `/usr/local/lib/brain-identity-fixture/fault-${name}.py`));
      const built = Bun.spawnSync(["cc", "-O2", "-Wall", "-Wextra", cPath, "-o", binary], { stdout: "pipe", stderr: "pipe" });
      writeFileSync(join(artifact, `compile-fault-${name}.log`), built.stdout.toString() + built.stderr.toString());
      if (built.exitCode !== 0) throw Error(`Fault fixture compilation failed: ${name}`);
      chmodSync(binary, 0o755);
      faultHashes[name] = { script: hash(script), binary: hash(readFileSync(binary)) };
    }
    const nativeFixturePath = join(artifact, "identity-fixture.py");
    writeFileSync(nativeFixturePath, changed(readFileSync(join(source, "scripts/native-proof/fixture.py"), "utf8"),
      'run(["/usr/local/bin/bun", "run", "test", str(pathlib.Path(__file__).with_name("hosted-app.test.ts"))], timeout=180)',
      'run(["/usr/local/bin/bun", "--preload", "/repo/scripts/test-network-child-preload.ts", "/repo/scripts/native-proof/identity-manager.native.ts"], timeout=180)'));
    const setup = join(artifact, "setup.sh");
    writeFileSync(setup, `set -eu
mkdir -p /usr/local/lib/brain-identity-fixture /run/brain-identity-fixture
chmod 700 /run/brain-identity-fixture
cp /fixture-helper /usr/local/bin/identity-helper
chown root:root /usr/local/bin/identity-helper
chmod 4755 /usr/local/bin/identity-helper
cp /helper.py /usr/local/lib/brain-identity-fixture/helper.py
for fault in ${Object.keys(faultEdits).join(" ")}; do
  cp "/fixture-variants/fault-$fault.py" "/usr/local/lib/brain-identity-fixture/fault-$fault.py"
  chmod 755 "/usr/local/lib/brain-identity-fixture/fault-$fault.py"
  cp "/fixture-variants/identity-helper-fault-$fault" "/usr/local/bin/identity-helper-fault-$fault"
  chown root:root "/usr/local/bin/identity-helper-fault-$fault"
  chmod 4755 "/usr/local/bin/identity-helper-fault-$fault"
done
cp /fixture-variants/non-dropping.py /usr/local/lib/brain-identity-fixture/non-dropping.py
cp /fixture-variants/identity-helper-non-dropping /usr/local/bin/identity-helper-non-dropping
chown root:root /usr/local/bin/identity-helper-non-dropping
chmod 4755 /usr/local/bin/identity-helper-non-dropping
printf '#!/bin/sh\nexit 125\n' > /usr/local/bin/identity-helper-refuses
chmod 755 /usr/local/bin/identity-helper-refuses
cp /filter.py /usr/local/lib/brain-identity-fixture/filesystem-filter.py
chmod 755 /usr/local/lib/brain-identity-fixture/helper.py /usr/local/lib/brain-identity-fixture/non-dropping.py /usr/local/lib/brain-identity-fixture/filesystem-filter.py
# Root invocation must load the host-built binary and reach its bootstrap refusal,
# rather than fail with an incompatible ELF/GLIBC loader.
set +e
/usr/local/bin/identity-helper 2>/tmp/helper-link-check
code=$?
set -e
[ "$code" = 125 ]
grep -q 'identity fixture helper refused bootstrap' /tmp/helper-link-check
mkdir -p /identity-fixture /identity-server-private
chown 21001:21001 /identity-fixture /identity-server-private
chmod 2775 /identity-fixture
chmod ${mutation==="sentinel-modes"?"750":"700"} /identity-server-private
/usr/bin/python3 -I -S - <<'PY_EGRESS_IPC'
import os,socket
os.mkdir('/identity-fixture/egress-setgid-temp',0o3777)
os.chown('/identity-fixture/egress-setgid-temp',0,21002)
previous_gid=os.getegid()
os.setegid(21002)
try: os.chmod('/identity-fixture/egress-setgid-temp',0o3777)
finally: os.setegid(previous_gid)
for name,uid,gid in [('owner',21002,21001),('group',21001,21002)]:
    path='/identity-fixture/egress-foreign-'+name
    os.mkdir(path,0o750)
    channel=socket.socket(socket.AF_UNIX)
    channel.bind(path+'/proxy.sock')
    channel.close()
    os.chown(path,uid,gid)
    os.chmod(path,0o750)
    os.chown(path+'/proxy.sock',uid,gid)
    os.chmod(path+'/proxy.sock',0o660)
PY_EGRESS_IPC
printf 'Odysseus private server sentinel' > /identity-server-private/sentinel
chown 21001:21001 /identity-server-private/sentinel
chmod ${mutation==="sentinel-modes"?"640":"600"} /identity-server-private/sentinel
set +e
setpriv --reuid 21001 --regid 21001 --clear-groups env BRAIN_UI_WORKER_IDENTITY_HELPER=/usr/local/bin/identity-helper /usr/local/bin/bun --preload /repo/scripts/test-network-child-preload.ts /repo/packages/ui-sdk/tests/identity-broker-qualification.native.ts
case_code=$?
set -e
if [ "$case_code" = 0 ]; then
  set +e
  /usr/bin/python3 -I -S /repo/scripts/native-proof/checkpoint-reader-controls.py
  case_code=$?
  if [ "$case_code" = 0 ]; then
    /usr/bin/python3 -I -S /fixture-variants/identity-fixture.py claude 1000
    case_code=$?
  fi
  set -e
fi
/usr/bin/python3 -I -S - <<'PY_CLEANUP'
import json,os,pathlib,time
records=pathlib.Path('/run/brain-identity-fixture')
mounts=pathlib.Path('/run/brain-identity-mounts')
for attempt in range(250):
    held=list(records.iterdir())
    sources=list(mounts.iterdir()) if mounts.exists() else []
    workers=[]
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdecimal():continue
        try:
            status=(entry/'status').read_text()
            uid=next(line for line in status.splitlines() if line.startswith('Uid:')).split()[1]
            state=next(line for line in status.splitlines() if line.startswith('State:')).split()[1]
            if uid=='21002' and state!='Z':workers.append(entry.name)
        except (FileNotFoundError,ProcessLookupError):pass
    if not held and not sources and not workers:
        print(json.dumps(dict(identityOwnedCleanup='pass',records=0,sourceDirectories=0,workers=0)),flush=True)
        break
    time.sleep(.02)
else:raise RuntimeError('IDENTITY_OWNED_RESOURCES_REMAIN: '+repr(dict(records=held,sources=sources,workers=workers)))
PY_CLEANUP
exit "$case_code"
`);
    const inspect = Bun.spawnSync(["docker", "image", "inspect", image, "--format", "{{.Id}}"], { stdout: "pipe", stderr: "pipe" });
    if (inspect.exitCode !== 0) throw Error("Prepared pinned native proof image is unavailable; prepare scripts/native-proof/Dockerfile before offline proof");
    const security = Bun.spawnSync(["docker", "info", "--format", "{{json .SecurityOptions}}"], { stdout: "pipe", stderr: "pipe" });
    if (security.exitCode !== 0) throw Error("Cannot inspect Docker security prerequisites");
    const apparmor = (JSON.parse(security.stdout.toString()) as string[]).some(value => value.startsWith("name=apparmor"));
    const capabilities = ["SYS_ADMIN", "SYS_CHROOT", "MKNOD", "DAC_OVERRIDE", "FOWNER", "KILL", "CHOWN", "SETUID", "SETGID"];
    const metadata = { image, mutation: mutation ?? null, imageId: inspect.stdout.toString().trim(), capabilities, apparmor,
      outerNoNewPrivileges: false, reason: "test-only setuid identity fixture; actual worker asserts NoNewPrivs=1 and CapEff=0",
      helperSourceSha256: hash(readFileSync(helperSource)), helperSha256: hash(readFileSync(helper)),
      faultHashes, helperScriptSha256: hash(helperScript), nonDroppingScriptSha256: hash(readFileSync(nonDroppingScript)), nonDroppingHelperSha256: hash(readFileSync(nonDroppingHelper)), filterSha256: hash(WORKER_FILESYSTEM_FILTER_PROGRAM) };
    writeFileSync(join(artifact, "environment.json"), JSON.stringify(metadata, null, 2));
    writeFileSync(join(artifact, "native-environment.json"), JSON.stringify({ apparmor }));
    const container = `brain-kit-identity-proof-${crypto.randomUUID()}`;
    const argv = ["docker", "run", "--name", container, "--rm", "--pull=never", "--network=none", "--cap-drop=ALL", ...capabilities.map(cap => `--cap-add=${cap}`),
      `--security-opt=seccomp=${join(source, "scripts/native-proof/seccomp.json")}`,
      ...(apparmor ? ["--security-opt=apparmor=brain-kit-native-proof"] : []), "--security-opt=systempaths=unconfined", "--device=/dev/loop-control", "--device-cgroup-rule=b 7:1790 rwm",
      "--mount", `type=bind,source=${artifact},target=/proof`,
      "--mount", `type=bind,source=${source},target=/repo,readonly`, "--mount", `type=bind,source=${realpathSync(process.execPath)},target=/usr/local/bin/bun,readonly`,
      "--mount", `type=bind,source=${helper},target=/fixture-helper,readonly`, "--mount", `type=bind,source=${helperScriptPath},target=/helper.py,readonly`, "--mount", `type=bind,source=${filter},target=/filter.py,readonly`,
      "--mount", `type=bind,source=${setup},target=/setup.sh,readonly`, "--mount", `type=bind,source=${artifact},target=/fixture-variants,readonly`, "--workdir=/repo", "--entrypoint=/bin/sh", image, "/setup.sh"];
    console.log(`Worker identity proof artifacts: ${artifact}`);
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, forward);
    let code: number | undefined, cleanupFailure: Error | undefined, captureFailure: unknown;
    const timeout = setTimeout(() => child.kill("SIGTERM"), 240000);
    const capture = async (stream: ReadableStream<Uint8Array>, channel: "stdout" | "stderr") => {
      let text = "";
      for await (const chunk of stream) { const current = new TextDecoder().decode(chunk); text += current; if (channel === "stdout") process.stdout.write(current); else process.stderr.write(current); writeFileSync(join(artifact, channel + ".log"), text); }
    };
    try {
      const [, , exit] = await Promise.all([capture(child.stdout, "stdout"), capture(child.stderr, "stderr"), child.exited]); code = exit;
    } catch (error) { captureFailure = error; }
    finally {
      clearTimeout(timeout);
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.off(signal, forward);
      const removed = Bun.spawnSync(["docker", "rm", "--force", container], { stdout: "pipe", stderr: "pipe" });
      if (removed.exitCode !== 0 && !/No such container/.test(removed.stderr.toString())) cleanupFailure = Error("Identity proof owned container cleanup unconfirmed");
      writeFileSync(join(artifact, "cleanup.json"), JSON.stringify({ container, removed: cleanupFailure === undefined }));
    }
    if (cleanupFailure) throw cleanupFailure;
    if (captureFailure) throw captureFailure;
    if (code !== 0) throw Error(`Worker identity qualification failed (${code}); inspect ${artifact}. No skip is passing proof.`);
    writeFileSync(join(artifact, "receipt.json"), JSON.stringify({ ...metadata, result: "pass", exitCode: code }, null, 2));
  } catch (error) { console.error(error); process.exit(1); }
}
