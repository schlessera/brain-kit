/**
 * #4206: the host's Google masks under a separate worker identity, run by
 * `google-credential.test.ts` in a namespace of its own: `/opt` is a fresh
 * tmpfs and this process is its root (uid 0 maps to the test's own user), so
 * the layouts below lie outside every host mask (`HOST_MASKS`) and the
 * launcher's widening runs for real, with no second user. The identity helper
 * is only qualified, never run. Prints one JSON line.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { workerCommand } from "../../../ui-sdk/src/server/worker-launcher.js";
import { operationalStateMasks } from "../../src/brain/operational-state.js";
import { checkGoogleHome, googleHomeAreas, googleHostLayout, googleWorkerMasks } from "../../src/google/home.js";

const serverHome = "/opt/server-home", dbPath = "/opt/state/ui.db";
// Odysseus's brain and gog home sit under a server-owned 0700 directory the
// worker identity cannot pass; Ithaca's under a searchable one. In the
// server's HOME, gog's configuration is reachable and its data is not.
const directories: [path: string, mode: number][] = [
  ["/opt/odysseus", 0o700], ["/opt/odysseus/brain", 0o755], ["/opt/odysseus/gog-home", 0o700],
  ["/opt/ithaca", 0o755], ["/opt/ithaca/brain", 0o755], ["/opt/ithaca/gog-home", 0o700],
  [serverHome, 0o755], [join(serverHome, ".config"), 0o755], [join(serverHome, ".config/gogcli"), 0o700],
  [join(serverHome, ".local"), 0o700], [join(serverHome, ".local/share"), 0o755], [join(serverHome, ".local/share/gogcli"), 0o700],
  ["/opt/state", 0o755],
];
for (const [path, mode] of directories) { mkdirSync(path, { recursive: true }); chmodSync(path, mode); }

/** A credentialed maintenance worker's launch plan, as the host boundary builds it: refused, or the directories it lays an empty tmpfs over. */
function plan(brain: string, maskPaths: readonly string[]) {
  try {
    const argv = workerCommand({ brainPath: brain, command: [process.execPath, "-e", "0"], env: { PATH: "/usr/bin:/bin" },
      maintenance: { network: false, credentials: true, home: { path: serverHome, overlay: false }, readPaths: [process.execPath], maskPaths } });
    return { ok: true as const, tmpfs: argv.flatMap((arg, index) => arg === "--tmpfs" ? [argv[index + 1]!] : []) };
  } catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
}

function boot(root: string) {
  const brain = join(root, "brain"), home = join(root, "gog-home");
  const layout = googleHostLayout({ brainPath: brain, dbPath, serverHome });
  const masks = googleWorkerMasks(home, layout, { hold: true });
  // What the app hands every maintenance worker: its operational state's masks, then the Google masks.
  const list = [...operationalStateMasks({ brainPath: brain, dbPath, privateStatePaths: [] }), ...masks.paths];
  return { layout, masks, result: {
    home, masks: masks.paths, unreachable: masks.home.unreachable === true, held: typeof masks.home.descriptor === "number",
    check: checkGoogleHome(home, googleHomeAreas(layout), { mask: masks.home }),
    plan: plan(brain, list),
    // The control: the same list with the home's mask, which the launcher must widen over the brain.
    control: plan(brain, [...list, home]),
  } };
}

const closed = boot("/opt/odysseus"), open = boot("/opt/ithaca");
// Opened to the worker identity after boot: the home boot left unmasked is reachable now.
chmodSync("/opt/odysseus", 0o755);
const reopened = checkGoogleHome(closed.result.home, googleHomeAreas(closed.layout), { mask: closed.masks.home });
closed.masks.close(); open.masks.close();
console.log(JSON.stringify({ uid: process.getuid?.(), closed: closed.result, open: open.result, reopened }));
