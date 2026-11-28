/** The pure half of launch qualification (#4301): parser, completeness, the kernel's walk, the verdict. */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveDescendantMounts, routeDirectory } from "../src/server/worker-private-state";
import { evaluateNamespace, namespaceComplete, overlayLayers, parseMountinfo, resolveMount, WORKER_NAMESPACE_SEAL, type MountRow, type NamespaceInspector, type RouteDirectory, type StateRootObservation } from "../src/server/namespace-qualification";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** One mountinfo line: id parent sb root point options - fstype source superOptions. */
const line = (id: number, parent: number, sb: string, root: string, point: string, fstype = "ext4", options = "rw", superOptions = "rw") =>
  `${id} ${parent} ${sb} ${root.replace(/ /g, "\\040")} ${point.replace(/ /g, "\\040")} ${options} master:1 - ${fstype} /dev/odysseus ${superOptions}`;
const table = (...lines: string[]) => parseMountinfo(lines.join("\n"))!;
const seal = (id: number, parent: number) => line(id, parent, "0:90", "/", WORKER_NAMESPACE_SEAL, "tmpfs", "ro,nosuid");
const STATE: StateRootObservation = { setting: "turn journal", path: "/srv/ithaca/state/brain-ui.db.journal", sb: "8:1", fspath: "/state/brain-ui.db.journal" };
const serverOwned: NamespaceInspector = { owner: () => ({ uid: 1000, mode: 0o40700 }), layer: () => undefined };
const open: NamespaceInspector = { owner: () => ({ uid: 1000, mode: 0o40755 }), layer: () => undefined };
const idOf = (rows: MountRow[], name: string) => { const reached = resolveMount(rows, name); return "row" in reached ? reached.row.id : reached.ambiguous; };

describe("parseMountinfo", () => {
  test("decodes escaped paths and the fields after the separator; an empty read is undefined", () => {
    const [row] = table(line(7, 1, "8:1", "/@home/penelope loom", "/home/penelope loom", "btrfs", "ro,relatime", "rw,subvol=/@home"));
    expect(row).toMatchObject({ id: 7, parent: 1, sb: "8:1", root: "/@home/penelope loom", point: "/home/penelope loom", fstype: "btrfs", options: ["ro", "relatime"] });
    expect(parseMountinfo(" \n")).toBeUndefined();
    expect(() => parseMountinfo("7 1 8:1 / /")).toThrow("invalid worker mount record 1");
  });
});

describe("namespaceComplete never judges an unfinished sandbox (A25)", () => {
  test("only the fourth read of empty, seal absent, seal with the old root stacked at /, complete is complete", () => {
    const reads = [
      "",
      [line(1, 0, "8:1", "/@", "/"), line(2, 1, "0:80", "/", "/tmp", "tmpfs")].join("\n"),
      [line(1, 0, "8:1", "/@", "/"), line(9, 1, "0:70", "/newroot", "/"), line(2, 9, "0:80", "/", "/tmp", "tmpfs"), seal(3, 2)].join("\n"),
      [line(9, 0, "0:70", "/newroot", "/"), line(2, 9, "0:80", "/", "/tmp", "tmpfs"), seal(3, 2)].join("\n"),
    ];
    expect(reads.map(text => { const rows = parseMountinfo(text); return rows ? namespaceComplete(rows) : false; }), "SEAL_AND_SINGLE_ROOT_ONLY").toEqual([false, false, false, true]);
  });
  test("a seal that is not yet remounted read-only is not complete", () => {
    expect(namespaceComplete(table(line(9, 0, "0:70", "/", "/"), line(3, 9, "0:90", "/", WORKER_NAMESPACE_SEAL, "tmpfs", "rw")))).toBe(false);
  });
});

describe("resolveMount follows parent ids as the kernel does (A8)", () => {
  // The host view: `--ro-bind / /` replicates the host's mounts, then a tmpfs masks the state directory's parent.
  const masked = table(
    line(1, 0, "8:1", "/@", "/"),
    line(2, 1, "8:1", "/state", "/srv/ithaca/state"),
    line(3, 2, "8:1", "/state/brain-ui.db.journal", "/srv/ithaca/state/brain-ui.db.journal"),
    line(4, 1, "0:50", "/", "/srv/ithaca", "tmpfs", "ro"),
    seal(5, 1));
  test("masked replicas stay rows of the table but are never entered", () => {
    expect(idOf(masked, "/srv/ithaca/state/brain-ui.db.journal"), "MASKED_REPLICA_NOT_LIVE").toBe(4);
    expect(evaluateNamespace(masked, [STATE], [1000], open).result).toBe("hidden");
  });
  test("stacked mounts on one point: the top of the stack wins, even when a longer point sits below", () => {
    const stacked = table(line(1, 0, "8:1", "/@", "/"), line(2, 1, "0:60", "/", "/srv", "tmpfs"),
      line(3, 2, "0:61", "/", "/srv", "tmpfs"), line(4, 1, "8:1", "/state", "/srv/ithaca/state"), seal(5, 1));
    expect(idOf(stacked, "/srv/ithaca/state"), "STACKED_TOP_WINS").toBe(3);
    expect(idOf(stacked, "/srv"), "STACKED_POINT_ITSELF").toBe(3);
  });
  test("a descendant mount under a state root is reached through its parent", () => {
    const descendant = table(line(1, 0, "8:1", "/@", "/"), line(2, 1, "8:1", "/state", "/srv/ithaca/state"),
      line(3, 2, "8:2", "/objects", "/srv/ithaca/state/brain-ui.db.journal/objects"), seal(4, 1));
    expect(idOf(descendant, "/srv/ithaca/state/brain-ui.db.journal/objects/odysseus"), "DESCENDANT_REACHED").toBe(3);
    const objects = { setting: "turn journal", path: "/srv/ithaca/state/brain-ui.db.journal/objects", sb: "8:2", fspath: "/objects" };
    expect(evaluateNamespace(descendant, [STATE, objects], [1000], open)).toMatchObject({ result: "exposed", name: "/srv/ithaca/state/brain-ui.db.journal" });
  });
  test("/ as the root mount and as a mount point, and whole-component prefixes", () => {
    const rows = table(line(1, 0, "8:1", "/@", "/"), line(2, 1, "0:60", "/", "/srv/ith", "tmpfs"), seal(3, 1));
    expect(idOf(rows, "/"), "ROOT_IS_ROOT").toBe(1);
    expect(idOf(rows, "/srv/ithaca/state"), "NO_PARTIAL_COMPONENT").toBe(1);
    expect(idOf(rows, "/srv/ith/x")).toBe(2);
  });
  test("two children of one parent on one point, or a deleted mount point, make the table unknown", () => {
    const twins = table(line(1, 0, "8:1", "/@", "/"), line(2, 1, "0:60", "/", "/srv", "tmpfs"), line(3, 1, "0:61", "/", "/srv", "tmpfs"),
      line(4, 3, "8:1", "/state", "/srv/ithaca/state"), seal(5, 1));
    expect(evaluateNamespace(twins, [STATE], [1000], open), "TWINS_UNKNOWN").toMatchObject({ result: "unknown" });
    const deleted = table(line(1, 0, "8:1", "/@", "/"), line(2, 1, "8:1", "/state", "/srv (deleted)"), seal(3, 1));
    expect(resolveMount(deleted, "/srv (deleted)/x")).toMatchObject({ ambiguous: expect.stringContaining("deleted") });
  });
});

describe("evaluateNamespace", () => {
  test("a state root bound at an unmasked second name is exposed, by name and row", () => {
    const alias = table(line(1, 0, "8:1", "/@", "/"), line(2, 1, "0:50", "/", "/srv/ithaca", "tmpfs", "ro"),
      line(3, 1, "8:1", "/state", "/opt/aeolus"), seal(4, 1));
    expect(evaluateNamespace(alias, [STATE], [1000], open), "BIND_ALIAS_EXPOSED").toMatchObject({ result: "exposed", setting: "turn journal",
      name: "/opt/aeolus/brain-ui.db.journal", row: expect.stringContaining("/opt/aeolus") });
  });
  test("a mount of part of a state root shows that part: its own owner decides", () => {
    const part = table(line(1, 0, "8:1", "/@", "/"), line(2, 1, "0:50", "/", "/srv/ithaca", "tmpfs", "ro"),
      line(3, 1, "8:1", "/state/brain-ui.db.journal/objects", "/opt/aeolus"), seal(4, 1));
    const seen: string[] = [];
    const verdict = evaluateNamespace(part, [STATE], [1000], { owner: path => { seen.push(path); return { uid: 1000, mode: 0o40755 }; }, layer: () => undefined });
    expect(verdict).toMatchObject({ result: "exposed", name: "/opt/aeolus" });
    expect(seen).toEqual(["/srv/ithaca/state/brain-ui.db.journal/objects"]);
  });
  test("a filesystem the sandbox does not mount at all hides the root", () => {
    expect(evaluateNamespace(table(line(9, 0, "0:70", "/newroot", "/"), seal(3, 9)), [STATE], [1000], open).result).toBe("hidden");
  });

  describe("ownership rule, keyed on the sandbox's own UIDs (A17)", () => {
    const live = table(line(1, 0, "8:1", "/@", "/"), line(2, 1, "8:1", "/state", "/srv/ithaca/state"), seal(3, 1));
    test("owner-only state of another UID is reported and released", () => {
      expect(evaluateNamespace(live, [STATE], [21003], serverOwned), "OWNER_ONLY_OTHER_UID").toMatchObject({ result: "ownership_only",
        entries: [{ setting: "turn journal", name: STATE.path }] });
    });
    test("any group or other bit, or a sandbox running as the owner, is exposed", () => {
      for (const mode of [0o40750, 0o40705, 0o100640, 0o100604])
        expect(evaluateNamespace(live, [STATE], [21003], { owner: () => ({ uid: 1000, mode }), layer: () => undefined }).result, `MODE_${mode.toString(8)}`).toBe("exposed");
      expect(evaluateNamespace(live, [STATE], [1000, 1000, 1000, 1000], serverOwned).result, "SERVER_UID_JUDGED_AS_SERVER").toBe("exposed");
      expect(evaluateNamespace(live, [STATE], [21003, 1000], serverOwned).result, "ANY_SANDBOX_UID_MATCHES").toBe("exposed");
    });
    test("state below an owner-only directory of another UID is reported and released, whatever its own mode (#5051)", () => {
      // A separate worker identity sees the host's root, where the server's
      // 0700 state directory holds a database the default umask left 0644.
      const root = table(line(709, 680, "0:46", "/", "/", "overlay", "ro"), seal(3, 709));
      const DB: StateRootObservation = { setting: "DB_PATH", path: "/identity-server-private/server-ws/ui.db", sb: "0:46", fspath: "/identity-server-private/server-ws/ui.db" };
      const modes: Record<string, { uid: number; mode: number }> = {
        "/identity-server-private/server-ws/ui.db": { uid: 21001, mode: 0o100644 }, "/identity-server-private/server-ws": { uid: 21001, mode: 0o40755 },
        "/identity-server-private": { uid: 21001, mode: 0o40700 }, "/": { uid: 0, mode: 0o40755 } };
      // Every host path here is the backing path itself: the route is certain.
      const host: NamespaceInspector = { owner: path => modes[path], layer: () => undefined,
        route: path => modes[path] ? { sb: "0:46", fspath: path, idmapped: false, owner: modes[path] } : undefined };
      expect(evaluateNamespace(root, [DB], [21002, 21002, 21002, 21002], host), "OWNER_ONLY_ANCESTOR_RELEASES").toMatchObject({ result: "ownership_only",
        entries: [{ setting: "DB_PATH", name: DB.path }] });
      // The server's own UID traverses its directory: exposed.
      expect(evaluateNamespace(root, [DB], [21001, 21001, 21001, 21001], host).result, "OWNER_ANCESTOR_TRAVERSED_BY_ITS_OWNER").toBe("exposed");
      // A directory others may enter protects nothing.
      modes["/identity-server-private"] = { uid: 21001, mode: 0o40711 };
      expect(evaluateNamespace(root, [DB], [21002, 21002, 21002, 21002], host).result, "TRAVERSABLE_ANCESTOR_EXPOSED").toBe("exposed");
      // A directory the host cannot open proves nothing: the open object is judged alone.
      delete modes["/identity-server-private"];
      expect(evaluateNamespace(root, [DB], [21002, 21002, 21002, 21002], host).result, "UNOPENED_ANCESTOR_RELEASES_NOTHING").toBe("exposed");
    });

    describe("a proven route directory decides only with a host owner it can trust (#5055)", () => {
      const root = table(line(709, 680, "0:46", "/", "/", "overlay", "ro"), seal(3, 709));
      const DB: StateRootObservation = { setting: "DB_PATH", path: "/identity-server-private/server-ws/ui.db", sb: "0:46", fspath: "/identity-server-private/server-ws/ui.db" };
      const owners: Record<string, { uid: number; mode: number } | undefined> = {
        "/identity-server-private/server-ws/ui.db": { uid: 21001, mode: 0o100644 }, "/identity-server-private/server-ws": { uid: 21001, mode: 0o40755 },
        "/identity-server-private": { uid: 21001, mode: 0o40700 }, "/": { uid: 0, mode: 0o40755 } };
      // Main's separate lookups (layer, then owner) see the same layout, so the cases run against either.
      const inspector = (directory: Partial<RouteDirectory>): NamespaceInspector => ({
        owner: path => path === "/identity-server-private" && "owner" in directory ? directory.owner : owners[path],
        layer: path => path in owners ? { sb: "0:46", fspath: path } : undefined,
        route: path => path in owners ? { sb: "0:46", fspath: path, idmapped: false, owner: owners[path], ...(path === "/identity-server-private" ? directory : {}) } : undefined });
      const uids = [21002, 21002, 21002, 21002];
      test("the incident's route releases, as before", () => {
        expect(evaluateNamespace(root, [DB], uids, inspector({})).result).toBe("ownership_only");
      });
      test("F2: an idmapped host mount under the owner-only directory makes the route unproven: exposed", () => {
        expect(evaluateNamespace(root, [DB], uids, inspector({ idmapped: true })).result, "F2_IDMAPPED_ROUTE_EXPOSED").toBe("exposed");
      });
      test("F4: a proven directory whose owner the host cannot read releases nothing", () => {
        expect(evaluateNamespace(root, [DB], uids, inspector({ owner: undefined })).result, "F4_UNREADABLE_OWNER_ON_A_PROVEN_ROUTE_EXPOSED").toBe("exposed");
      });
    });

    test("an owner-only directory on a host alias the worker never crosses releases nothing (#5053 r1 F1)", () => {
      // The host names the database through a bind alias below its own 0700
      // directory; the worker's mount reaches the original file through
      // traversable directories, never through that alias.
      const worker = table(line(1, 0, "0:70", "/newroot", "/", "tmpfs"), line(2, 1, "8:1", "/", "/data", "ext4", "rw"), seal(3, 1));
      const DB: StateRootObservation = { setting: "DB_PATH", path: "/srv/penelope/alias/ui.db", sb: "8:1", fspath: "/open/state/ui.db" };
      const owners: Record<string, { uid: number; mode: number }> = {
        "/srv/penelope/alias/ui.db": { uid: 21001, mode: 0o100644 }, "/srv/penelope/alias": { uid: 21001, mode: 0o40700 },
        "/srv/penelope": { uid: 21001, mode: 0o40700 }, "/srv": { uid: 0, mode: 0o40755 } };
      // The alias directories back onto another filesystem path than the worker's route.
      const backing: Record<string, { sb: string; fspath: string }> = { "/srv/penelope/alias": { sb: "8:2", fspath: "/alias" }, "/srv/penelope": { sb: "8:2", fspath: "/" } };
      const host: NamespaceInspector = { owner: path => owners[path], layer: () => undefined,
        route: path => backing[path] ? { ...backing[path], idmapped: false, owner: owners[path] } : undefined };
      expect(evaluateNamespace(worker, [DB], [21002, 21002, 21002, 21002], host).result, "ALIAS_ANCESTOR_RELEASES_NOTHING").toBe("exposed");
    });
    test("an owner the host cannot read is unknown, never released", () => {
      expect(evaluateNamespace(live, [STATE], [21003], { owner: () => undefined, layer: () => undefined }).result).toBe("unknown");
    });
  });

  describe("overlay rule (A19)", () => {
    const overlay = (superOptions: string) => table(line(1, 0, "8:1", "/@", "/"), line(2, 1, "0:50", "/", "/srv/ithaca", "tmpfs", "ro"),
      line(3, 1, "0:99", "/", "/opt/aeolus", "overlay", "ro", superOptions), seal(4, 1));
    const layers: Record<string, { sb: string; fspath: string }> = {
      "/srv/ithaca/state/brain-ui.db.journal": { sb: "8:1", fspath: "/state/brain-ui.db.journal" },
      "/var/lib/odysseus/journal-link": { sb: "8:1", fspath: "/state/brain-ui.db.journal" },
      "/opt/bind-alias/state": { sb: "8:1", fspath: "/state" },
      "/var/empty": { sb: "8:1", fspath: "/var/empty" },
    };
    const inspect: NamespaceInspector = { owner: () => ({ uid: 1000, mode: 0o40755 }), layer: path => layers[path] };
    test("a lowerdir that is a state root, named directly, through a symlink or through a bind alias, is exposed", () => {
      for (const lower of ["/srv/ithaca/state/brain-ui.db.journal", "/var/lib/odysseus/journal-link", "/opt/bind-alias/state"])
        expect(evaluateNamespace(overlay(`ro,lowerdir=/var/empty:${lower}`), [STATE], [1000], inspect), `OVERLAY_${lower}`).toMatchObject({ result: "exposed", name: "/opt/aeolus" });
    });
    test("a layer given as a relative path is not detected and is named as non-coverage", () => {
      expect(evaluateNamespace(overlay("ro,lowerdir=state/brain-ui.db.journal"), [STATE], [1000], inspect), "RELATIVE_LAYER_NOT_COVERED")
        .toEqual({ result: "hidden", nonCoverage: ["overlay layer state/brain-ui.db.journal at /opt/aeolus"] });
    });
  });
});

describe("review round 1 (#4301)", () => {
  test("F3: one-layer overlay options keep their colons; lowerdir splits only on unescaped colons, before decoding", () => {
    expect(overlayLayers("ro,lowerdir+=/srv/ithaca:state,datadir+=/srv/aeolus:bag"), "F3_SINGLE_LAYER_OPTIONS_NOT_SPLIT").toEqual(["/srv/ithaca:state", "/srv/aeolus:bag"]);
    expect(overlayLayers("ro,lowerdir=/srv/a\\:b:/srv/c,upperdir=/srv/up:per,workdir=/srv/work"), "F3_ESCAPED_COLONS").toEqual(["/srv/a:b", "/srv/c", "/srv/up:per", "/srv/work"]);
    // Linux shows the legacy lowerdir as given, backslashes octal-escaped: `\\134:` is an escaped colon (F33).
    expect(overlayLayers("ro,lowerdir=/srv/ithaca\\134:state:/srv/oar"), "F33_ESCAPED_COLON_DECODED_BEFORE_SPLIT").toEqual(["/srv/ithaca:state", "/srv/oar"]);
    // Backslashes pair up, as the kernel consumes them: after an even run a colon still separates layers (#4973 r4 F44).
    expect(overlayLayers("ro,lowerdir=/srv/ithaca\\134\\134:/srv/oar"), "F44_PAIRED_BACKSLASHES_SPLIT").toEqual(["/srv/ithaca\\", "/srv/oar"]);
    expect(overlayLayers("ro,lowerdir=/srv/ithaca\\134\\134\\134:state:/srv/oar"), "F44_ODD_RUN_ESCAPES").toEqual(["/srv/ithaca\\:state", "/srv/oar"]);
  });
  test("F4: a host mount stacked under another below a state root is not what that path shows", () => {
    const rows = table(line(1, 0, "8:1", "/@", "/"), line(2, 1, "8:1", "/state", "/srv/state"),
      line(3, 2, "8:2", "/objects", "/srv/state/objects"), line(4, 3, "0:60", "/", "/srv/state/objects", "tmpfs"), line(5, 2, "8:3", "/cache", "/srv/state/cache"));
    expect(liveDescendantMounts(rows, "/srv/state").map(row => row.id), "F4_ONLY_LIVE_DESCENDANTS").toEqual([4, 5]);
  });
});

describe("review round 2 (#4301)", () => {
  test("F31: an idmapped covering mount never gets the ownership rule: its host owner is not the worker's", () => {
    const rows = table(line(1, 0, "8:1", "/@", "/"), line(2, 1, "8:1", "/state", "/srv/ithaca/state", "ext4", "rw,idmapped"), seal(3, 1));
    const ownerOnly = { owner: () => ({ uid: 1000, mode: 0o40700 }), layer: () => undefined };
    expect(evaluateNamespace(rows, [STATE], [21003], ownerOnly).result, "F31_IDMAPPED_IS_EXPOSED").toBe("exposed");
    const plain = table(line(1, 0, "8:1", "/@", "/"), line(2, 1, "8:1", "/state", "/srv/ithaca/state"), seal(3, 1));
    expect(evaluateNamespace(plain, [STATE], [21003], ownerOnly).result, "F31_PLAIN_OWNER_ONLY_STAYS").toBe("ownership_only");
  });
});

describe("review round 3 (#4301)", () => {
  test("F41: a row with no super-options field is malformed, so the table is unknown", () => {
    expect(() => parseMountinfo("31 1 8:1 / /srv/ithaca rw - overlay odysseus"), "F41_MISSING_SUPER_OPTIONS_MALFORMED").toThrow("invalid worker mount record 1");
  });
  test("F34: state the host reads through an idmapped mount never gets the ownership exception", () => {
    const rows = table(line(1, 0, "8:1", "/@", "/"), line(2, 1, "8:1", "/state", "/srv/ithaca/state"), seal(3, 1));
    expect(evaluateNamespace(rows, [{ ...STATE, hostIdmapped: true }], [21003], { owner: () => ({ uid: 1000, mode: 0o40700 }), layer: () => undefined }).result,
      "F34_HOST_IDMAPPED_IS_EXPOSED").toBe("exposed");
  });
  test("F36: an ambiguous host table below a state root is unknown, never fewer roots", () => {
    const rows = table(line(1, 0, "8:1", "/@", "/"), line(2, 1, "8:1", "/state", "/srv/state"),
      line(3, 2, "8:2", "/a", "/srv/state/objects"), line(4, 2, "8:3", "/b", "/srv/state/objects"));
    expect(() => liveDescendantMounts(rows, "/srv/state"), "F36_AMBIGUOUS_HOST_TABLE_THROWS").toThrow("ambiguous");
  });
});

describe("routeDirectory: one descriptor per route directory (#5055 F3)", () => {
  const rows = () => parseMountinfo(readFileSync("/proc/self/mountinfo", "utf8"))!;
  const place = () => {
    const base = mkdtempSync(join(tmpdir(), "odysseus-route-")); cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const dir = join(base, "ithaca"); mkdirSync(dir, { mode: 0o700 });
    symlinkSync(dir, join(base, "ogygia")); writeFileSync(join(base, "raft"), "Calypso's raft");
    return { base: realpathSync(base), dir: join(realpathSync(base), "ithaca") };
  };
  test("a directory's coordinates, owner and mode come from one open descriptor, never a second lookup of its path", () => {
    const { dir } = place();
    const table = rows();
    const lookups = [spyOn(fs, "statSync"), spyOn(fs, "lstatSync"), spyOn(fs, "realpathSync")];
    const opens = spyOn(fs, "openSync");
    let seen: RouteDirectory | undefined;
    try { seen = routeDirectory(dir, table); }
    finally { for (const spy of lookups) cleanups.push(() => spy.mockRestore()); cleanups.push(() => opens.mockRestore()); }
    expect(lookups.map(spy => spy.mock.calls.length), "F3_NO_SECOND_PATH_LOOKUP").toEqual([0, 0, 0]);
    expect(opens.mock.calls.length, "F3_ONE_DESCRIPTOR").toBe(1);
    const info = fs.lstatSync(dir);
    expect(seen).toMatchObject({ idmapped: false, owner: { uid: info.uid, mode: info.mode } });
  });
  test("a symlink, a name through a symlink, or a file is not a route directory", () => {
    const { base } = place();
    const table = rows();
    expect(routeDirectory(join(base, "ogygia"), table), "SYMLINK_IS_NOT_A_ROUTE").toBeUndefined();
    mkdirSync(join(base, "ithaca", "inner"));
    expect(routeDirectory(join(base, "ogygia", "inner"), table), "NAME_THROUGH_A_SYMLINK_IS_NOT_A_ROUTE").toBeUndefined();
    expect(routeDirectory(join(base, "raft"), table), "FILE_IS_NOT_A_ROUTE").toBeUndefined();
  });
});
