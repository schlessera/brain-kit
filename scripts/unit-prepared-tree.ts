/** Own one fresh build while its private overlay workers execute. */
import { closeSync, constants, existsSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ensureWorkspaceLease } from "./workspace-lease.mjs";
import { clearInvocation, invocationBuild, prepareInvocation, preparedSourceRecord } from "./test-invocation";
import { selectBuildPackages } from "./publishable-packages";
import { runPreparedUnitWorkers, type UnitWorkerOptions } from "./unit-workers";

if (import.meta.main) {
  const [root, caller, reports, rawOptions, rawFiles, chrome, invocation] = process.argv.slice(2);
  if (!root || !caller || !reports || !rawOptions || !rawFiles || !invocation || /[,:\\\n]/.test(root)) throw new Error("Invalid prepared unit tree entry");
  const admission = await ensureWorkspaceLease(root, "write");
  if (admission !== undefined) process.exit(admission);
  clearInvocation();
  let active: Parameters<Parameters<typeof prepareInvocation>[2]>[0] | undefined;
  let cancelled: NodeJS.Signals | undefined;
  let enteredWorkers = false, readonly = false, preparationMs: number | null = null;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const listeners = signals.map(signal => () => { cancelled = signal; if (active) void active.stop(signal); });
  signals.forEach((signal, index) => process.on(signal, listeners[index]!));
  let dispose = () => {}, result = 1;
  type Peer = { input: Buffer; output?: Buffer; sent: number };
  let listener: Bun.UnixSocketListener<Peer> | undefined, socketDirectory: number | undefined;
  const send = (socket: Bun.Socket<Peer>) => {
    const state = socket.data;
    if (!state.output) return;
    const count = socket.write(state.output.subarray(state.sent));
    if (count < 0) return;
    state.sent += count;
    if (state.sent === state.output.length) socket.end();
  };
  const command = (argv: string[]) => {
    const child = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(`Prepared unit mount failed: ${new TextDecoder().decode(child.stderr)}`);
  };
  try {
    command(["mount", "--make-rprivate", "/"]);
    const before = performance.now();
    const preparation = await prepareInvocation(root, undefined, child => { active = child; if (cancelled) void child.stop(cancelled); }, { dropCapabilities: true });
    preparationMs = performance.now() - before; dispose = preparation.dispose;
    if (preparation.code || cancelled || !invocationBuild(root, selectBuildPackages(root).map(pkg => pkg.dir))) throw new Error("Prepared unit build did not attest successfully");
    // Descriptor-relative Unix paths avoid sockaddr_un's short path limit.
    socketDirectory = openSync(join(root, "tmp"), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    listener = Bun.listen<Peer>({ unix: `/proc/self/fd/${socketDirectory}/.p.sock`, socket: {
      open(socket) { socket.data = { input: Buffer.alloc(0), sent: 0 }; socket.timeout(10); },
      data(socket, bytes) {
        const state = socket.data;
        if (state.output) return;
        state.input = Buffer.concat([state.input, bytes]);
        if (state.input.length > 16_384) { socket.end(); return; }
        const end = state.input.indexOf(10); if (end < 0) return;
        try { state.output = Buffer.from(JSON.stringify(preparedSourceRecord(root, JSON.parse(state.input.subarray(0, end).toString())) ?? null) + "\n"); }
        catch { state.output = Buffer.from("null\n"); }
        if (state.output.length > 1_048_576) state.output = Buffer.from("null\n");
        send(socket);
      },
      drain: send,
      error(socket) { socket.end(); },
    } });
    command(["mount", "--bind", root, root]); readonly = true;
    command(["mount", "-o", "remount,bind,ro", root]);
    enteredWorkers = true;
    await runPreparedUnitWorkers(root, JSON.parse(rawFiles) as string[], chrome || undefined, reports,
      JSON.parse(rawOptions) as UnitWorkerOptions, caller, invocation);
    result = 0;
  } catch (error) { console.error(error); }
  finally {
    if (readonly) try { command(["umount", "--", root]); } catch (error) { console.error(error); result = result || 1; }
    listener?.stop(true); if (socketDirectory !== undefined) closeSync(socketDirectory);
    try { dispose(); } catch (error) { console.error(error); result = result || 1; }
    signals.forEach((signal, index) => process.off(signal, listeners[index]!));
    const summary = join(reports, "unit-worker-summary.json");
    const record = existsSync(summary) ? JSON.parse(readFileSync(summary, "utf8")) : undefined;
    const cleanupPassed = !enteredWorkers || (record?.preparedInvocation === invocation && record.cleanupPassed === true);
    await Bun.write(join(reports, "unit-prepared-setup.json"), JSON.stringify({ root: realpathSync(root), invocation, preparationMs, cleanupPassed }, null, 2));
  }
  process.exit(cancelled ? 1 : result);
}
