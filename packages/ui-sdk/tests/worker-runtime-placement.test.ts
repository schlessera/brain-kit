/** Owned native bytes remain executable without restoring host temporary storage. */
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { workerCommand, type WorkerLaunch } from "../src/server/worker-launcher.js";

const ROOT = resolve(import.meta.dir, "../../..");
const ALLOWANCE = 8 * 1024 * 1024;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/odysseus-runtime-"));
  const temporary = mkdtempSync(join(tmpdir(), "odysseus-runtime-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(temporary, { recursive: true, force: true }));
  const brain = join(root, "brain"), relay = join(root, "relay"), mirror = join(root, "mirror");
  mkdirSync(brain); mkdirSync(relay, { mode: 0o700 }); mkdirSync(mirror);
  writeFileSync(join(brain, "identity.txt"), "Odysseus");
  writeFileSync(join(temporary, "host-secret.txt"), "Polyphemus: never exposed.");
  return { root, temporary, brain, relay, mirror };
}
const modes = ["bare", "governed", "strict", "restricted", "maintenance", "transport"] as const;
function input(f: ReturnType<typeof fixture>, mode: typeof modes[number], runtime: string, command = [join(runtime, "native-cli")]): WorkerLaunch {
  const common = { brainPath: f.brain, command, env: { PATH: "/usr/bin:/bin" } };
  if (mode === "maintenance") return { ...common, maintenance: { network: false, credentials: false, tempBytes: ALLOWANCE, readPaths: [runtime] } };
  if (mode === "transport") return { ...common, transport: { mirror: f.mirror, tempBytes: ALLOWANCE, readPaths: [runtime] } };
  return { ...common, turnTempBytes: ALLOWANCE, ...(mode === "restricted" ? { restricted: { readPaths: [runtime], inferenceDir: f.relay } }
    : mode === "bare" ? {} : { sandbox: { brain: f.brain, restricted: false, profile: mode, areas: [], scratchAliasesRemoved: [],
      ...(mode === "governed" ? { protection: { paths: [], ancestors: [] } } : {}) } }) };
}

test("same owned native runtime works inside/outside /tmp in every applicable launcher mode", () => {
  const f = fixture();
  for (const directory of [f.root, f.temporary]) {
    const runtime = join(directory, "runtime"); mkdirSync(runtime);
    writeFileSync(join(runtime, "package.json"), '{"name":"odysseus-runtime-control"}\n');
    copyFileSync(realpathSync("/bin/sh"), join(runtime, "native-cli"));
    writeFileSync(join(runtime, "readonly.txt"), "Odysseus immutable runtime bytes");
  }
  expect(readFileSync(join(f.root, "runtime/native-cli"))).toEqual(readFileSync(join(f.temporary, "runtime/native-cli")));
  const alias = join(f.temporary, "aliased-runtime"); symlinkSync(join(f.root, "runtime"), alias);
  for (const mode of modes) for (const runtime of [join(f.root, "runtime"), join(f.temporary, "runtime"), alias]) {
    const program = `printf 'sidecar='; cat '${runtime}/readonly.txt'; printf '\\n';
      if (printf changed >> '${runtime}/readonly.txt') 2>/dev/null; then echo readonly=no; else echo readonly=yes; fi;
      if test -e '${f.temporary}/host-secret.txt'; then echo hostTemp=visible; else echo hostTemp=hidden; fi;
      if test -e /tmp/odysseus-worker-marker; then echo prior=visible; else echo prior=absent; fi;
      printf Odysseus > /tmp/odysseus-worker-marker;
      printf 'capacity='; stat -f -c '%b %S' /tmp;
      printf 'capabilities='; sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status;
      if test -r '${f.brain}/identity.txt'; then echo brain=visible; else echo brain=hidden; fi;
      if (printf changed > '${f.brain}/worker.txt') 2>/dev/null; then echo brainWrite=yes; else echo brainWrite=no; fi`;
    const result = Bun.spawnSync(workerCommand(input(f, mode, runtime, [join(runtime, "native-cli"), "-c", program])),
      { stdin: Buffer.from("go\n"), stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(result.exitCode, `OWNED_RUNTIME_LAUNCH_${mode}_${runtime.startsWith(f.temporary) ? "inside" : "outside"}: ${result.stderr}`).toBe(0);
    const observed = Object.fromEntries(result.stdout.toString().trim().split("\n").map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
    expect(observed.sidecar).toBe("Odysseus immutable runtime bytes");
    expect(observed.readonly, "OWNED_RUNTIME_IS_READ_ONLY").toBe("yes");
    expect(observed.hostTemp, "OWNED_RUNTIME_DOES_NOT_EXPOSE_HOST_TMP").toBe("hidden");
    expect(observed.prior, "OWNED_RUNTIME_WORKERS_REMAIN_ISOLATED").toBe("absent");
    const [blocks, size] = observed.capacity!.split(" ").map(Number);
    expect(blocks! * size!, "OWNED_RUNTIME_PRESERVES_TEMP_ALLOWANCE").toBe(ALLOWANCE);
    expect(observed.capabilities).toBe("0000000000000000");
    expect(observed.brain).toBe(mode === "transport" ? "hidden" : "visible");
    expect(observed.brainWrite).toBe(["governed", "maintenance"].includes(mode) ? "yes" : "no");
  }
});

test("runtime paths cannot shadow reserved private worker mounts through names or aliases", () => {
  const f = fixture(), alias = join(f.root, "temporary-alias"); symlinkSync("/tmp", alias);
  const reserved = ["/tmp", "/proc/self/exe", "/dev/shm/odysseus", "/tmp/brain-worker-state/odysseus", "/tmp/brain-worker-scratch/odysseus",
    "/tmp/brain-worker-home/cache/odysseus", "/tmp/brain-worker-areas/scratch/odysseus", "/run/brain-inference/odysseus",
    "/run/brain-egress/odysseus", "/tmp/brain-maintenance-home/odysseus", "/tmp/brain-maintenance-state/odysseus",
    "/tmp/brain-maintenance-output/odysseus", join(alias, "brain-worker-state/odysseus")];
  for (const mode of modes) for (const path of reserved) {
    expect(() => workerCommand(input(f, mode, path, [path])),
      `OWNED_RUNTIME_RESERVED_COLLISION_${mode}_${path}`).toThrow("reserved private worker path");
  }
});

test("owned runtime restoration cannot resurrect explicitly masked files or subdirectories through an alias", () => {
  const f = fixture(), runtime = join(f.root, "runtime"); mkdirSync(runtime);
  writeFileSync(join(runtime, "package.json"), '{"name":"odysseus-runtime-control"}\n');
  copyFileSync(realpathSync("/bin/sh"), join(runtime, "native-cli"));
  writeFileSync(join(runtime, "public.txt"), "Odysseus public runtime");
  writeFileSync(join(runtime, "secret.txt"), "Polyphemus private runtime file");
  mkdirSync(join(runtime, "private")); writeFileSync(join(runtime, "private/secret.txt"), "Polyphemus private directory");
  const alias = join(f.temporary, "runtime"); symlinkSync(runtime, alias);
  for (const mode of ["governed", "strict", "maintenance"] as const) {
    const launch = input(f, mode, alias, [join(alias, "native-cli"), "-c", `cat '${alias}/public.txt'; cat '${alias}/secret.txt' 2>/dev/null; cat '${alias}/private/secret.txt' 2>/dev/null; true`]);
    const maskPaths = [join(runtime, "secret.txt"), join(runtime, "private")];
    const masked = launch.maintenance ? { ...launch, maintenance: { ...launch.maintenance, maskPaths } }
      : { ...launch, sandbox: { ...launch.sandbox!, maskPaths } };
    const result = Bun.spawnSync(workerCommand(masked), { stdin: Buffer.from("go\n"), stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString(), "OWNED_RUNTIME_MASKS_SURVIVE_ALIASES").toBe("Odysseus public runtime");
  }
});
