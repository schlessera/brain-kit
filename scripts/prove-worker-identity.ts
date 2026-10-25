/** Real cross-UID broker proof; fixture elevation exists only in this container. */
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { applicationQualificationSelected, applicationQualificationScenario, APPLICATION_SKIPPED_CONTROLS } from "../packages/ui-sdk/tests/fixtures/application-qualification.js";
import { ordinaryIdentityPhases, IDENTITY_PHASE_TIMEOUT_MS, IDENTITY_CLEANUP_TIMEOUT_MS } from "../packages/ui-sdk/tests/fixtures/ordinary-identity-phases.js";
import { SDK_RELAY_PROFILE_TIMEOUT_MS, SDK_RELAY_SINGLE_TURN_TIMEOUT_MS } from "../packages/ui-backend-claude/tests/fixtures/sdk-host-relay-limits.js";
import { ownedPruneVariant, ownedPruneDiagnosticSelected, bootPruneCaptureVariant, bootPruneCaptureSelected } from "./native-proof/owned-prune-variant.js";
import { dbRepeatStageVariant } from "./native-proof/db-repeat-variant.js";
import { NATIVE_PROOF_IMAGE } from "./prove-native-host.js";
import { WORKER_FILESYSTEM_FILTER_PROGRAM } from "../packages/ui-sdk/src/server/worker-filesystem-filter.js";

/** Fixed, diagnostic-only source variant; never changes the checked-out product files. */
export function collectorInventoryVariant(collectorSource: string, hostSource: string) {
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const collectorHash = digest(collectorSource);
  const shim = `import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
const original = "/repo/packages/ui-server/src/brain/maintenance-git-source.ts";
const expectedHash = ${JSON.stringify(collectorHash)};
if (createHash("sha256").update(readFileSync(original)).digest("hex") !== expectedHash) throw Error("FIXTURE_COLLECTOR_BYTES_CHANGED");
const root = process.cwd(), fd = openSync(".", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
try {
  const info = fstatSync(fd), identity = String(info.dev) + ":" + String(info.ino);
  if (identity !== process.argv[4]) throw Error("FIXTURE_COLLECTOR_ROOT_IDENTITY_CHANGED");
  const names = readdirSync("/proc/self/fd/" + fd);
  if (names.length > 512) throw Error("FIXTURE_COLLECTOR_INVENTORY_ENTRY_BOUND");
  const entries = names.sort().map(name => {
    const entry = lstatSync("/proc/self/fd/" + fd + "/" + name);
    return { name, uid: entry.uid, gid: entry.gid, mode: entry.mode & 0o7777, dev: String(entry.dev), ino: String(entry.ino),
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other" };
  });
  const receipt = JSON.stringify({ collectorHash: expectedHash, rootIdentity: identity, entries });
  if (Buffer.byteLength(receipt) > 65536) throw Error("FIXTURE_COLLECTOR_INVENTORY_BYTE_BOUND");
  console.error("LOCAL_FIXTURE_GIT_ROOT " + receipt);
} finally { closeSync(fd); }
const child = Bun.spawn([process.execPath, "--config=/dev/null", "--no-env-file", original, ...process.argv.slice(2)],
  { cwd: root, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
const code = await child.exited;
process.exitCode = code;
`;
  const replace = (text: string, before: string, after: string) => {
    if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw Error("Collector inventory fixture anchor changed");
    return text.replace(before, after);
  };
  let host = replace(hostSource, 'const entry = Bun.resolveSync("./maintenance-git-source", import.meta.dir), maximum = storage.allowanceBytes;',
    'const entry = "/fixture-variants/maintenance-git-source-inventory.ts", maximum = storage.allowanceBytes;');
  host = replace(host, '  if (result.exitCode !== 0 || result.killed) {', `  // Diagnostic variant only: local artifact, never product logs or a receipt contract.
  for (const line of result.stderr.split("\\n")) {
    if (!line.startsWith("LOCAL_FIXTURE_GIT_ROOT ") || Buffer.byteLength(line) > 65536 + 32) continue;
    try {
      const value = JSON.parse(line.slice("LOCAL_FIXTURE_GIT_ROOT ".length));
      const uint = (n: unknown, max: number) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;
      if (!value || value.collectorHash !== ${JSON.stringify(collectorHash)} || value.rootIdentity !== expectedRoot || !Array.isArray(value.entries)
        || value.entries.length > 512 || Object.keys(value).sort().join(",") !== "collectorHash,entries,rootIdentity") continue;
      if (value.entries.some((item: any) => !item || Object.keys(item).sort().join(",") !== "dev,gid,ino,mode,name,type,uid"
        || typeof item.name !== "string" || Buffer.byteLength(item.name) > 1024 || item.name.includes("/")
        || !uint(item.uid, 0xffffffff) || !uint(item.gid, 0xffffffff) || !uint(item.mode, 0o7777)
        || typeof item.dev !== "string" || !/^[0-9]{1,24}$/.test(item.dev) || typeof item.ino !== "string" || !/^[0-9]{1,24}$/.test(item.ino)
        || !["directory", "file", "symlink", "other"].includes(item.type))) continue;
      console.error("LOCAL_FIXTURE_GIT_ROOT " + JSON.stringify(value));
    } catch { /* Malformed diagnostic stderr is never forwarded. */ }
  }
  if (result.exitCode !== 0 || result.killed) {`);
  return { shim, host, hashes: { originalCollector: collectorHash, originalHost: digest(hostSource), shim: digest(shim), variantHost: digest(host) } };
}

export function workerIdentityDockerArgs(source: string, artifact: string, container: string, image: string, apparmor: boolean, variants: { db: boolean; boot: boolean; prune: boolean; inventory: boolean; scratch: boolean }, bun: string): string[] {
  const capabilities = ["SYS_ADMIN", "SYS_CHROOT", "MKNOD", "DAC_OVERRIDE", "FOWNER", "KILL", "CHOWN", "SETUID", "SETGID"];
  return ["docker", "run", "--name", container, "--rm", "--pull=never", "--network=none", "--cap-drop=ALL", ...capabilities.map(cap => `--cap-add=${cap}`),
    `--security-opt=seccomp=${join(source, "scripts/native-proof/seccomp.json")}`,
    ...(apparmor ? ["--security-opt=apparmor=brain-kit-native-proof"] : []), "--security-opt=systempaths=unconfined", "--device=/dev/loop-control", "--device-cgroup-rule=b 7:1790 rwm",
    "--mount", `type=bind,source=${dirname(artifact)},target=/proof-runs`,
    "--mount", `type=bind,source=${dirname(artifact)},target=/fixture-runs,readonly`,
    "--mount", `type=bind,source=${source},target=/repo,readonly`,
    "--mount", `type=bind,source=${bun},target=/usr/local/bin/bun,readonly`,
    "--workdir=/repo", "--entrypoint=/bin/sh", image, "/repo/scripts/native-proof/stable-run.sh", basename(artifact), "identity",
    ...(variants.db ? ["db"] : []), ...(variants.boot ? ["boot"] : []), ...(variants.prune ? ["prune"] : []), ...(variants.inventory ? ["inventory"] : []), ...(variants.scratch ? ["scratch"] : []), "--", "/bin/sh", "/setup.sh"];

}

if (import.meta.main) {
  try {
    if (process.platform !== "linux" || process.arch !== "x64") throw Error("Identity proof requires qualified Linux x86_64");
    const options = process.argv.slice(2);
    if (options.some(arg => !/^--image=[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(arg) && !/^--mutation=(ignored-signals|supervisor-zombie|sentinel-modes)$/.test(arg) && arg !== "--shared-git" && arg !== "--private-git-inputs" && arg !== "--native-phase-only" && arg !== "--collector-inventory" && arg !== "--probe-state-placement" && arg !== "--omit-probe-state-placement" && arg !== "--scratch-mask" && arg !== "--application-qualification" && arg !== "--owned-prune-diagnostic" && arg !== "--boot-prune-capture" && !/^--application-scenario=(governed|strict|db-repeat)$/.test(arg)) || new Set(options.map(arg=>arg.split("=")[0])).size!==options.length) throw Error("Usage: prove-worker-identity.ts [--image=<prepared-native-image>] [--mutation=ignored-signals|supervisor-zombie|sentinel-modes] [--shared-git] [--private-git-inputs] [--native-phase-only] [--collector-inventory] [--probe-state-placement] [--omit-probe-state-placement] [--application-qualification] [--scratch-mask] [--owned-prune-diagnostic] [--boot-prune-capture] [--application-scenario=governed|strict|db-repeat]");
    const applicationQualification = applicationQualificationSelected(options);
    const ownedPruneDiagnostic = ownedPruneDiagnosticSelected(options, applicationQualification);
    const bootPruneCapture = bootPruneCaptureSelected(options, applicationQualification);
    const applicationScenario = applicationQualificationScenario(options, applicationQualification);
    if (applicationScenario === "db-repeat" && ownedPruneDiagnostic) throw Error("DB repeat qualification forbids extra diagnostic variants");
    const image = options.find(arg=>arg.startsWith("--image="))?.slice("--image=".length) ?? NATIVE_PROOF_IMAGE;
    const sharedGit = options.includes("--shared-git");
    const privateGitInputs = options.includes("--private-git-inputs");
    if (privateGitInputs && !sharedGit) throw Error("Private Git input proof requires the separate shared Git composition");
    const nativePhaseOnly = options.includes("--native-phase-only");
    const scratchMask = options.includes("--scratch-mask");
    if (scratchMask && (!applicationQualification || !bootPruneCapture || applicationScenario || ownedPruneDiagnostic)) throw Error("Scratch mask proof requires boot-captured application qualification without other variants");
    const probeStatePlacement = options.includes("--probe-state-placement");
    const omitProbeStatePlacement = options.includes("--omit-probe-state-placement");
    if (probeStatePlacement && (!nativePhaseOnly || !sharedGit || privateGitInputs || options.includes("--collector-inventory"))) throw Error("Probe-state proof requires its separate shared native composition");
    if (omitProbeStatePlacement && !probeStatePlacement) throw Error("Probe-state omission requires the bounded probe-state composition");
    const collectorInventory = options.includes("--collector-inventory");
    const mutation = options.find(arg=>arg.startsWith("--mutation="))?.slice("--mutation=".length);
    if (nativePhaseOnly && (!sharedGit || mutation)) throw Error("Native-phase-only proof requires shared Git composition and forbids mutations");
    if (collectorInventory && (!nativePhaseOnly || !sharedGit || !privateGitInputs || mutation)) throw Error("Collector inventory requires the separate private native-phase diagnostic composition");
    const changed = (text: string, before: string, after: string) => { if(!text.includes(before))throw Error("Identity fixture mutation anchor changed");return text.replace(before,after); };
    const source = resolve(import.meta.dir, ".."), output = join(source, "tmp", "worker-identity-proof");
    mkdirSync(output, { recursive: true });
    const artifact = mkdtempSync(join(output, "run-")); chmodSync(artifact, 0o755);
    const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
    const inventoryVariant = collectorInventory ? collectorInventoryVariant(
      readFileSync(join(source, "packages/ui-server/src/brain/maintenance-git-source.ts"), "utf8"),
      readFileSync(join(source, "packages/ui-server/src/brain/maintenance-git.ts"), "utf8")) : undefined;
    if (inventoryVariant) {
      writeFileSync(join(artifact, "maintenance-git-source-inventory.ts"), inventoryVariant.shim);
      writeFileSync(join(artifact, "maintenance-git.fixture.ts"), inventoryVariant.host);
    }
    const pruneVariant = ownedPruneDiagnostic ? ownedPruneVariant(
      readFileSync(join(source, "packages/ui-server/src/cron/scratch-prune.ts"), "utf8"),
      readFileSync(join(source, "packages/ui-server/src/brain/host-boundary.ts"), "utf8")) : undefined;
    if (pruneVariant) {
      writeFileSync(join(artifact, "scratch-prune.fixture.ts"), pruneVariant.cron);
      writeFileSync(join(artifact, "host-boundary.fixture.ts"), pruneVariant.boundary);
      writeFileSync(join(artifact, "owned-prune-substitutions.json"), JSON.stringify(pruneVariant.substitutions, null, 2));
    }
    const bootVariant = bootPruneCapture ? bootPruneCaptureVariant(pruneVariant?.cron ?? readFileSync(join(source, "packages/ui-server/src/cron/scratch-prune.ts"), "utf8")) : undefined;
    if (bootVariant) {
      writeFileSync(join(artifact, "boot-scratch-prune.fixture.ts"), bootVariant.cron);
      writeFileSync(join(artifact, "boot-prune-substitution.json"), JSON.stringify(bootVariant.substitution, null, 2));
    }
    if (scratchMask) writeFileSync(join(artifact, "scratch-mask-identity-ws.fixture.ts"), readFileSync(join(source, "packages/ui-sdk/tests/fixtures/scratch-mask-identity-ws.ts")));
    const dbVariant = applicationScenario === "db-repeat" ? dbRepeatStageVariant(readFileSync(join(source, "packages/ui-sdk/src/server/worker-native-output.ts"), "utf8")) : undefined;
    if (dbVariant) {
      writeFileSync(join(artifact, "db-repeat-output.fixture.ts"), dbVariant.source);
      writeFileSync(join(artifact, "db-repeat-stage-substitution.json"), JSON.stringify(dbVariant.substitution, null, 2));
    }
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
      "no-view": ['        elif operation == "view":\n            view(connection, request, token, record)', '        elif operation == "view":\n            refuse("operation")'],
      "host-view": ['            fd = os.open("/proc/%s/root%s" % (value["pid"], record["view"]), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)', '            fd = os.open(record["view"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)'],
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
    const applicationPhases = ordinaryIdentityPhases({ applicationScenario, applicationQualification,
      probeStatePlacement, sharedGit, privateGitInputs });
    const applicationTimeoutMs = applicationPhases.length * IDENTITY_PHASE_TIMEOUT_MS + IDENTITY_CLEANUP_TIMEOUT_MS;
    // Preserve the existing allowance for other work; account for the additional
    // sequential application phases and both complete SDK profiles when selected.
    const containerTimeoutMs = 240_000 + Math.max(0, applicationTimeoutMs - 180_000)
      + (nativePhaseOnly ? 0 : 2 * (SDK_RELAY_PROFILE_TIMEOUT_MS - SDK_RELAY_SINGLE_TURN_TIMEOUT_MS));
    const nativeFixturePath = join(artifact, "identity-fixture.py");
    writeFileSync(nativeFixturePath, changed(readFileSync(join(source, "scripts/native-proof/fixture.py"), "utf8"),
      'run(["/usr/local/bin/bun", "run", "test", str(pathlib.Path(__file__).with_name("hosted-app.test.ts"))], timeout=HOSTED_TIMEOUT)',
      `run(["/usr/local/bin/bun", "--preload", "/repo/scripts/test-network-child-preload.ts", "/repo/scripts/native-proof/identity-manager.native.ts"], timeout=180)\n    run(["/usr/local/bin/bun", "--preload", "/repo/scripts/test-network-child-preload.ts", "/repo/packages/ui-sdk/tests/fixtures/ordinary-identity-root.ts"], timeout=${applicationTimeoutMs / 1000})\n    run(["/usr/local/bin/bun", "--preload", "/repo/scripts/test-network-child-preload.ts", "/repo/packages/ui-backend-claude/tests/fixtures/prepared-consumer-native-root.ts"], timeout=180)\n    run(["/usr/local/bin/bun", "--preload", "/repo/scripts/test-network-child-preload.ts", "/repo/packages/ui-backend-claude/tests/fixtures/prepared-consumer-native-root.ts", "--cleanup-failure"], timeout=180)`));
    if (sharedGit) {
      // A separate fresh-brain composition: the original default retains the
      // prior worker-private journal/recovery mutations and its failure evidence.
      const fresh = changed(readFileSync(nativeFixturePath, "utf8"),
        '    run(["/usr/local/bin/bun", "--preload", "/repo/scripts/test-network-child-preload.ts", "/repo/scripts/native-proof/identity-manager.native.ts"], timeout=180)\n', "");
      writeFileSync(nativeFixturePath, changed(fresh,
        "/repo/packages/ui-sdk/tests/fixtures/ordinary-identity-root.ts", applicationQualification ? "/repo/packages/ui-sdk/tests/fixtures/application-identity-root.ts" : probeStatePlacement ? "/repo/packages/ui-sdk/tests/fixtures/probe-state-identity-root.ts" : privateGitInputs ? "/repo/packages/ui-sdk/tests/fixtures/private-git-identity-root.ts" : "/repo/packages/ui-sdk/tests/fixtures/shared-git-identity-root.ts"));
    }
    if (applicationScenario) writeFileSync(nativeFixturePath, changed(readFileSync(nativeFixturePath, "utf8"),
      '"/repo/packages/ui-sdk/tests/fixtures/application-identity-root.ts"', `"/repo/packages/ui-sdk/tests/fixtures/application-identity-root.ts", "--application-scenario=${applicationScenario}"`));
    if (bootPruneCapture) writeFileSync(nativeFixturePath, changed(readFileSync(nativeFixturePath, "utf8"),
      '"/repo/packages/ui-sdk/tests/fixtures/application-identity-root.ts"', '"/repo/packages/ui-sdk/tests/fixtures/application-identity-root.ts", "--boot-prune-capture"'));
    if (omitProbeStatePlacement) writeFileSync(nativeFixturePath, changed(readFileSync(nativeFixturePath, "utf8"),
      '"/repo/packages/ui-sdk/tests/fixtures/probe-state-identity-root.ts"', '"/repo/packages/ui-sdk/tests/fixtures/probe-state-identity-root.ts", "--omit-probe-state-placement"'));
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
    if (nativePhaseOnly) {
      // Separately named partial proof; the complete default setup stays intact.
      const complete = readFileSync(setup, "utf8");
      const begin = "setpriv --reuid 21001 --regid 21001 --clear-groups env BRAIN_UI_WORKER_IDENTITY_HELPER=/usr/local/bin/identity-helper";
      const end = "/usr/bin/python3 -I -S - <<'PY_CLEANUP'";
      const first = complete.indexOf(begin), last = complete.indexOf(end, first);
      if (first < 0 || last < first || complete.indexOf(begin, first + 1) !== -1) throw Error("Native phase selector anchors changed");
      writeFileSync(setup, complete.slice(0, first) + "/usr/bin/python3 -I -S /fixture-variants/identity-fixture.py claude 1000\ncase_code=$?\nset -e\n" + complete.slice(last));
    }
    const inspect = Bun.spawnSync(["docker", "image", "inspect", image, "--format", "{{.Id}}"], { stdout: "pipe", stderr: "pipe" });
    if (inspect.exitCode !== 0) throw Error("Prepared pinned native proof image is unavailable; prepare scripts/native-proof/Dockerfile before offline proof");
    const security = Bun.spawnSync(["docker", "info", "--format", "{{json .SecurityOptions}}"], { stdout: "pipe", stderr: "pipe" });
    if (security.exitCode !== 0) throw Error("Cannot inspect Docker security prerequisites");
    const apparmor = (JSON.parse(security.stdout.toString()) as string[]).some(value => value.startsWith("name=apparmor"));
    const capabilities = ["SYS_ADMIN", "SYS_CHROOT", "MKNOD", "DAC_OVERRIDE", "FOWNER", "KILL", "CHOWN", "SETUID", "SETGID"];
    const metadata = { image, applicationPhases, applicationTimeoutMs, containerTimeoutMs,
      applicationScenario: applicationScenario ?? null, skippedAppPhases: applicationScenario === "governed" || applicationScenario === "db-repeat" ? ["strict"] : applicationScenario === "strict" ? ["fresh-app", "warm"] : [],
      skippedGitPhases: applicationScenario === "db-repeat" ? ["fresh-standalone", "warm-standalone"] : [],
      proofScope: scratchMask ? "scratch-mask-application-qualification-boot-prune-capture-variant" : applicationScenario === "db-repeat" ? "application-scenario-db-repeat-boot-prune-capture-stage-observation-variant" : applicationScenario ? `application-scenario-${applicationScenario}-boot-prune-capture${ownedPruneDiagnostic ? "-diagnostic" : ""}-variant` : bootPruneCapture ? (ownedPruneDiagnostic ? "application-qualification-boot-prune-capture-diagnostic-variant" : "application-qualification-boot-prune-capture-variant") : ownedPruneDiagnostic ? "application-qualification-owned-prune-variant" : applicationQualification ? "application-qualification-only" : probeStatePlacement ? (omitProbeStatePlacement ? "probe-state-checkpoint-omission-mutant" : "probe-state-checkpoint-causal") : collectorInventory ? "native-phase-only-collector-inventory-variant" : nativePhaseOnly ? "native-phase-only" : "complete", privateGitInputs,
      collectorInventoryHashes: inventoryVariant?.hashes ?? null, ownedPruneHashes: pruneVariant?.hashes ?? null, bootPruneHashes: bootVariant?.hashes ?? null, dbRepeatStageHashes: dbVariant?.hashes ?? null,
      skippedCategories: nativePhaseOnly ? ["identity-broker-and-sdk", "checkpoint-reader-controls", ...(applicationQualification ? APPLICATION_SKIPPED_CONTROLS : []), ...(probeStatePlacement ? ["private-git-inputs", "fresh-controls", "fresh-app", "warm-app", "strict-app"] : [])] : [], gitFixture: sharedGit ? "documented-shared-group-fresh-without-prior-journal-mutations" : "original-private-metadata", mutation: mutation ?? null, imageId: inspect.stdout.toString().trim(), capabilities, apparmor,
      outerNoNewPrivileges: false, reason: "test-only setuid identity fixture; actual worker asserts NoNewPrivs=1 and CapEff=0",
      helperSourceSha256: hash(readFileSync(helperSource)), helperSha256: hash(readFileSync(helper)),
      faultHashes, helperScriptSha256: hash(helperScript), nonDroppingScriptSha256: hash(readFileSync(nonDroppingScript)), nonDroppingHelperSha256: hash(readFileSync(nonDroppingHelper)), filterSha256: hash(WORKER_FILESYSTEM_FILTER_PROGRAM) };
    writeFileSync(join(artifact, "environment.json"), JSON.stringify(metadata, null, 2));
    writeFileSync(join(artifact, "native-environment.json"), JSON.stringify({ apparmor }));
    const container = `brain-kit-identity-proof-${crypto.randomUUID()}`;
    const argv = workerIdentityDockerArgs(source, artifact, container, image, apparmor, { db: !!dbVariant, boot: !!bootVariant, prune: !!pruneVariant, inventory: !!inventoryVariant, scratch: scratchMask }, realpathSync(process.execPath));
    console.log(`Worker identity proof artifacts: ${artifact}`);
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, forward);
    let code: number | undefined, cleanupFailure: Error | undefined, captureFailure: unknown;
    const timeout = setTimeout(() => child.kill("SIGTERM"), containerTimeoutMs);
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
