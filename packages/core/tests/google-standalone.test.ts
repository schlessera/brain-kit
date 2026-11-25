/**
 * The standalone Google glue's own rules (#4208): which home is used, where a
 * home may lie, the search cursors and the routing verdict. The commands'
 * envelopes are proven through the real bin in cli-contract.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleCursorStale, googleCursorStore, GOOGLE_CURSOR_FILE, GOOGLE_CURSOR_LIMIT, GOOGLE_CURSOR_TTL_MS, GOOGLE_GENERATION_FILE } from "../src/lib/google/cursors.ts";
import { gogAuthArgv, GogAuthArgvError } from "../src/lib/google/gog-auth.ts";
import { checkGoogleHome, selectGoogleHome, standaloneGoogleHome, type GoogleHomeOwners } from "../src/lib/google/home.ts";
import { createStandaloneGoogle, GOOGLE_SCOPE_PATTERN, standaloneGoogleRouting } from "../src/lib/google/standalone.ts";
import { createFakeGog } from "../../common/tests/support/fake-gog.ts";
import { watchdogMs } from "../../../scripts/test-deadlines";

const dirs: string[] = [];
function dir(prefix = "brain-google-unit-"): string {
  const made = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(made, 0o700);
  dirs.push(made);
  return made;
}
afterEach(() => {
  for (const made of dirs.splice(0)) rmSync(made, { recursive: true, force: true });
});

// Root's directories show as uid 0, or as the overflow uid inside the user namespace CI's unit
// workers run in. The tests know which, and declare it as an owner would with BRAIN_GOOGLE_ROOT_UID.
const ROOT_UID = statSync("/").uid;
const check = (home: string, brainRoot: string, owners: GoogleHomeOwners = {}) => checkGoogleHome(home, brainRoot, { rootUid: ROOT_UID, ...owners });

const env = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over });
function base() {
  return {
    hostHome: undefined as string | undefined, hostKeyringPassword: undefined as string | undefined, hostGogPath: undefined as string | undefined,
    home: undefined as string | undefined, keyringPassword: "standalone-pass" as string | undefined, gogPath: "/opt/gog/gog" as string | undefined,
    dataHome: "/odysseus/data" as string | undefined, userHome: "/odysseus", rootUid: undefined as number | undefined,
  };
}

describe("google home selection", () => {
  test("google home: BRAIN_UI_GOOGLE_HOME with the host's credential, else BRAIN_GOOGLE_HOME, else an absolute XDG_DATA_HOME, else ~/.local/share", () => {
    const host = selectGoogleHome(env({ hostHome: "/srv/ithaca/gog", hostKeyringPassword: "host-pass", hostGogPath: "/usr/local/bin/gog", home: "/odysseus/own" }));
    expect(host).toMatchObject({ kind: "host", source: "BRAIN_UI_GOOGLE_HOME", path: "/srv/ithaca/gog", keyringPassword: "host-pass", gogPath: "/usr/local/bin/gog" });
    expect(selectGoogleHome(env({ home: "/odysseus/own" }))).toMatchObject({ kind: "standalone", source: "BRAIN_GOOGLE_HOME", path: "/odysseus/own", keyringPassword: "standalone-pass" });
    expect(selectGoogleHome(env())).toMatchObject({ source: "XDG_DATA_HOME", path: "/odysseus/data/brain/google" });
    // The XDG spec ignores a relative base directory.
    expect(selectGoogleHome(env({ dataHome: "relative/data" }))).toMatchObject({ source: "HOME", path: "/odysseus/.local/share/brain/google" });
    expect(selectGoogleHome(env({ dataHome: undefined }))).toMatchObject({ source: "HOME", path: "/odysseus/.local/share/brain/google" });
    // What brain doctor checks is the standalone home, whatever the host's variable says.
    expect(standaloneGoogleHome(env({ hostHome: "/srv/ithaca/gog" }))).toMatchObject({ kind: "standalone", source: "XDG_DATA_HOME" });
  });
});

describe("google home placement", () => {
  function brain(): string {
    const root = dir("brain-google-brain-");
    writeFileSync(join(root, "brain.config.ts"), "export default {};\n");
    return root;
  }

  test("google home inside or holding a brain repository is refused, through a symlink too", () => {
    const root = brain();
    expect(check(join(root, "state/google"), root)).toMatchObject({ ok: false, reason: "home_inside_brain" });
    expect(check(root, root)).toMatchObject({ ok: false, reason: "home_inside_brain" });
    // Another brain repository than the current one.
    const other = brain();
    expect(check(join(other, "google"), root)).toMatchObject({ ok: false, reason: "home_inside_brain" });
    const outside = dir();
    expect(check(join(outside, "google"), join(outside, "google", "brain"))).toMatchObject({ ok: true });
    const holder = dir();
    const held = join(holder, "brain");
    mkdirSync(held);
    writeFileSync(join(held, "brain.config.json"), "{}\n");
    expect(check(holder, held)).toMatchObject({ ok: false, reason: "home_holds_brain" });
    const link = join(dir(), "link");
    symlinkSync(root, link);
    expect(check(join(link, "google"), root)).toMatchObject({ ok: false, reason: "home_inside_brain" });
  });

  test("google home: a working directory that is not a brain does not count as one", () => {
    const cwd = dir();
    expect(check(join(cwd, ".local/share/brain/google"), cwd)).toEqual({ ok: true, exists: false, path: join(cwd, ".local/share/brain/google") });
  });

  test("google home must be absolute, a directory, this user's and private", () => {
    const root = brain();
    expect(check("relative/google", root)).toMatchObject({ ok: false, reason: "home_invalid" });
    expect(check("/odysseus/\ngoogle", root)).toMatchObject({ ok: false, reason: "home_invalid" });
    const parent = dir();
    const file = join(parent, "file");
    writeFileSync(file, "");
    expect(check(file, root)).toMatchObject({ ok: false, reason: "home_not_directory" });
    const open = join(parent, "open");
    mkdirSync(open);
    chmodSync(open, 0o750);
    expect(check(open, root)).toMatchObject({ ok: false, reason: "home_permissions" });
    const own = join(parent, "own");
    mkdirSync(own, { mode: 0o700 });
    // A directory root owns, below directories root owns: only the home itself is another user's.
    expect(check("/usr", root)).toMatchObject({ ok: false, reason: statSync("/usr").uid === process.getuid?.() ? "home_permissions" : "home_owner" });
    expect(check(own, root)).toMatchObject({ ok: true, exists: true });
  });
});

describe("google home ancestry", () => {
  test("google home below a directory another user could rename an entry in is refused; a sticky one is not", () => {
    const root = dir("brain-google-brain-");
    writeFileSync(join(root, "brain.config.ts"), "export default {};\n");
    const shared = dir();
    chmodSync(shared, 0o777);
    expect(check(join(shared, "google"), root)).toMatchObject({ ok: false, reason: "home_ancestor_unsafe" });
    expect(check(join(shared, "deeper", "google"), root)).toMatchObject({ ok: false, reason: "home_ancestor_unsafe" });
    chmodSync(shared, 0o1777);
    expect(check(join(shared, "google"), root)).toMatchObject({ ok: true, exists: false });
    chmodSync(shared, 0o700);
    // Owned by someone else: told apart by the uid the check is given. A directory uid 0 owns is root's
    // whoever asks, so this needs a caller that is not uid 0 (it is under `--map-root-user`).
    const own = dir();
    if (statSync(own).uid !== 0) {
      const another = check(join(own, "google"), root, { uid: statSync(own).uid + 1 });
      expect(another).toMatchObject({ ok: false, reason: "home_ancestor_unsafe", detail: expect.stringContaining(`owned by uid ${statSync(own).uid}`) });
      // A user's uid is not the overflow uid, so the refusal points at no variable.
      expect(JSON.stringify(another).includes("BRAIN_GOOGLE_ROOT_UID")).toBe(false);
    }
    chmodSync(own, 0o777);
    expect(check(join(own, "google"), root)).toMatchObject({ ok: false, reason: "home_ancestor_unsafe", detail: expect.stringContaining("writable by another user") });
    chmodSync(own, 0o700);
  });

  // Where `/` is the caller's own (real root), `--map-current-user` maps its owner and nothing shows the overflow uid.
  test.skipIf(ROOT_UID === process.getuid?.())("google home in a user namespace: root's directories show the overflow uid, which refuses until BRAIN_GOOGLE_ROOT_UID declares it root's", async () => {
    const root = dir("brain-google-brain-");
    writeFileSync(join(root, "brain.config.ts"), "export default {};\n");
    const home = join(dir(), "google");
    const script = `
      const { checkGoogleHome } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/google/home.ts"))});
      const { resolveEnv } = await import(${JSON.stringify(join(import.meta.dir, "../src/config/env.ts"))});
      const { readFileSync, statSync } = await import("node:fs");
      const home = ${JSON.stringify(home)}, root = ${JSON.stringify(root)};
      const overflow = Number(readFileSync("/proc/sys/kernel/overflowuid", "utf8").trim());
      console.log(JSON.stringify({
        overflow, slash: statSync("/").uid,
        strict: checkGoogleHome(home, root),
        declared: checkGoogleHome(home, root, { rootUid: resolveEnv({ BRAIN_GOOGLE_ROOT_UID: String(overflow) }).google.rootUid }),
        declaredHome: checkGoogleHome("/usr", root, { rootUid: overflow }),
      }));`;
    // Unprivileged, as CI's unit workers run: root is not mapped, so `/` and `/tmp` show the overflow uid.
    const child = Bun.spawn(["unshare", "--user", "--map-current-user", process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
    const seen = JSON.parse(out);
    expect(seen.slash).toBe(seen.overflow);
    // The overflow uid also stands for every other unmapped user: unknown, so it refuses, and says how to declare it.
    expect(seen.strict).toMatchObject({ ok: false, reason: "home_ancestor_unsafe", detail: expect.stringContaining(`BRAIN_GOOGLE_ROOT_UID=${seen.overflow}`) });
    expect(seen.declared).toEqual({ ok: true, exists: false, path: home });
    // A declared root counts above the home only: a home it owns is another user's.
    expect(seen.declaredHome).toMatchObject({ ok: false, reason: "home_owner" });
  }, watchdogMs(30_000));
});

describe("google search cursors", () => {
  test("google cursor stands for one page token of one account and query, and expires", () => {
    const home = dir();
    let clock = 1_783_850_000_000;
    const store = googleCursorStore(home, () => clock);
    const cursor = store.mint("ithaca", "from:penelope", "09876543210987654321", store.begin());
    expect(cursor).toMatch(/^gc_[A-Za-z0-9_-]{16,64}$/);
    expect(store.resolve("ithaca", "from:penelope", cursor, store.begin())).toBe("09876543210987654321");
    // Usable again, so a failed page can be retried.
    expect(store.resolve("ithaca", "from:penelope", cursor, store.begin())).toBe("09876543210987654321");
    expect(store.resolve("sparta", "from:penelope", cursor, store.begin())).toBeNull();
    expect(store.resolve("ithaca", "from:eumaeus", cursor, store.begin())).toBeNull();
    expect(store.resolve("ithaca", "from:penelope", "gc_AAAAAAAAAAAAAAAAAAAAAAAA", store.begin())).toBeNull();
    const file = join(home, GOOGLE_CURSOR_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // The query is kept as its digest, never its text.
    expect(readFileSync(file, "utf8")).not.toContain("penelope");
    clock += GOOGLE_CURSOR_TTL_MS;
    expect(store.resolve("ithaca", "from:penelope", cursor, store.begin())).toBeNull();
  });

  test("google cursor store keeps the newest cursors and reads a damaged file as empty", () => {
    const home = dir();
    let clock = 1_783_850_000_000;
    const store = googleCursorStore(home, () => clock++);
    const minted = Array.from({ length: GOOGLE_CURSOR_LIMIT + 1 }, (_, index) => store.mint("ithaca", "in:inbox", `token${index}`, store.begin()));
    expect(store.resolve("ithaca", "in:inbox", minted[0]!, store.begin())).toBeNull();
    expect(store.resolve("ithaca", "in:inbox", minted.at(-1)!, store.begin())).toBe(`token${GOOGLE_CURSOR_LIMIT}`);
    writeFileSync(join(home, GOOGLE_CURSOR_FILE), "{ not json");
    expect(store.resolve("ithaca", "in:inbox", minted.at(-1)!, store.begin())).toBeNull();
    expect(() => store.mint("ithaca", "in:inbox", "a token\nwith a line", store.begin())).toThrow();
  });

  test("google cursors die with their connection generation: a connect during a search keeps none of its pages", () => {
    const home = dir();
    const store = googleCursorStore(home, () => 1_783_850_000_000);
    const kept = store.mint("ithaca", "in:inbox", "first", store.begin());
    const during = store.begin();
    store.clear();
    expect(() => store.mint("ithaca", "in:inbox", "second", during)).toThrow(GoogleCursorStale);
    // Nor does a search that took the old generation resolve the old cursor.
    expect(store.resolve("ithaca", "in:inbox", kept, during)).toBeNull();
    expect(store.resolve("ithaca", "in:inbox", kept, store.begin())).toBeNull();
    expect(store.begin()).not.toBe(during);
    const fresh = store.mint("ithaca", "in:inbox", "third", store.begin());
    expect(store.resolve("ithaca", "in:inbox", fresh, store.begin())).toBe("third");
  });

  test("google cursors: a generation that cannot be read is replaced by a fresh one, never a value an earlier one had", () => {
    const home = dir();
    const store = googleCursorStore(home, () => 1_783_850_000_000);
    expect(store.generation()).toBeNull();
    const first = store.begin();
    expect(store.generation()).toBe(first);
    const cursor = store.mint("ithaca", "in:inbox", "old-account", first);
    store.clear();
    const generation = join(home, GOOGLE_GENERATION_FILE);
    for (const damage of [() => chmodSync(generation, 0o644), () => writeFileSync(generation, "not a generation!\n", { mode: 0o600 }), () => rmSync(generation)]) {
      damage();
      expect(store.generation()).toBeNull();
      const next = store.begin();
      expect(next).not.toBe(first);
      expect(store.resolve("ithaca", "in:inbox", cursor, next)).toBeNull();
    }
  });

  test("google cursors: a cursor file written back by a search that began before a connect brings no old cursor back", () => {
    const home = dir();
    const store = googleCursorStore(home, () => 1_783_850_000_000);
    const old = store.mint("ithaca", "in:inbox", "old-account", store.begin());
    // A search that read the cursor file before the connect renames its snapshot over it afterwards.
    const snapshot = readFileSync(join(home, GOOGLE_CURSOR_FILE));
    store.clear();
    rmSync(join(home, GOOGLE_CURSOR_FILE));
    writeFileSync(join(home, GOOGLE_CURSOR_FILE), snapshot, { mode: 0o600 });
    expect(store.resolve("ithaca", "in:inbox", old, store.begin())).toBeNull();
  });
});

describe("google cursor file", () => {
  test("google cursors are read only from a small private regular file: a link, a FIFO, a shared or a large file reads as none", () => {
    const home = dir();
    const store = googleCursorStore(home, () => 1_783_850_000_000);
    const cursor = store.mint("ithaca", "in:inbox", "09876543210987654321", store.begin());
    const file = join(home, GOOGLE_CURSOR_FILE);
    const saved = readFileSync(file);
    chmodSync(file, 0o644);
    expect(store.resolve("ithaca", "in:inbox", cursor, store.begin())).toBeNull();
    rmSync(file);
    const elsewhere = join(dir(), "cursors.json");
    writeFileSync(elsewhere, saved, { mode: 0o600 });
    symlinkSync(elsewhere, file);
    expect(store.resolve("ithaca", "in:inbox", cursor, store.begin())).toBeNull();
    rmSync(file);
    expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
    // Opened without waiting for a writer, so this returns at once.
    expect(store.resolve("ithaca", "in:inbox", cursor, store.begin())).toBeNull();
    rmSync(file);
    writeFileSync(file, Buffer.concat([saved, Buffer.alloc(300 * 1024, 0x20)]), { mode: 0o600 });
    expect(store.resolve("ithaca", "in:inbox", cursor, store.begin())).toBeNull();
    rmSync(file);
    writeFileSync(file, saved, { mode: 0o600 });
    expect(store.resolve("ithaca", "in:inbox", cursor, store.begin())).toBe("09876543210987654321");
    store.clear();
    expect(store.resolve("ithaca", "in:inbox", cursor, store.begin())).toBeNull();
  });
});

describe("google standalone routing and account argv", () => {
  test("google routing: provider rules that keep anything from google are unproven without a conversation", () => {
    expect(standaloneGoogleRouting([])).toBe("allowed");
    expect(standaloneGoogleRouting([{ paths: ["me/**"], allow: ["anthropic", "google"] }])).toBe("allowed");
    expect(standaloneGoogleRouting([{ paths: ["me/**"], allow: ["anthropic"] }])).toBe("recipient_unproven");
  });

  test("google scope names: whole OAuth scopes only", () => {
    for (const scope of ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly", "https://mail.google.com/"]) expect(GOOGLE_SCOPE_PATTERN.test(scope), scope).toBe(true);
    for (const scope of ["openid\n", "xopenid", "openidx", "https://evil.example/https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.readonly?login_hint=odysseus@example.com", "https://www.googleapis.com/auth/", ""]) {
      expect(GOOGLE_SCOPE_PATTERN.test(scope), scope).toBe(false);
    }
  });

  test("google account argv: one element per value, positionals after --, no line breaks", () => {
    expect(gogAuthArgv({ command: "auth.alias.set", positionals: ["ithaca", "-odysseus@example.com"] })).toEqual([
      "--no-input", "--json", "--color=never", "--enable-commands-exact=auth.alias.set", "--gmail-no-send", "auth", "alias", "set", "--", "ithaca", "-odysseus@example.com",
    ]);
    expect(() => gogAuthArgv({ command: "auth.add", flags: [["auth-url", "http://127.0.0.1/cb?code=x\n--services=all"]] })).toThrow(GogAuthArgvError);
    expect(() => gogAuthArgv({ command: "auth.add", positionals: ["odysseus@example.com\u2028"] })).toThrow(GogAuthArgvError);
  });
});

describe("google connect timeout", () => {
  test("google connect: an authorization that outlives its limit is killed with everything it started, and says the step may have taken effect", async () => {
    const root = dir("brain-google-brain-");
    writeFileSync(join(root, "brain.config.ts"), "export default {};\n");
    mkdirSync(join(root, "context/policies"), { recursive: true });
    writeFileSync(join(root, "context/policies/governance.md"), "---\nschema_version: 1\ngoogle: {\"enabled\":true,\"account\":\"ithaca\",\"services\":[\"gmail\"]}\n---\n");
    const fake = createFakeGog({ "auth.add": { grandchild: true, delay_ms: watchdogMs(30_000) } });
    try {
      const google = createStandaloneGoogle({
        root, binary: fake.binary, connectTimeoutMs: 300,
        env: { BRAIN_GOOGLE_HOME: join(dir(), "home"), BRAIN_GOOGLE_KEYRING_PASSWORD: "penelope-weaves-by-day", XDG_DATA_HOME: dir(), BRAIN_GOOGLE_ROOT_UID: String(ROOT_UID) },
      });
      const started = Date.now();
      const result = await google.connect({ address: "odysseus@example.com", write: false, remote: false });
      expect(Date.now() - started).toBeLessThan(watchdogMs(20_000));
      expect(result).toMatchObject({ ok: false, operation: "connect", error: { code: "unavailable", reason: "authorization_timeout" } });
      expect(result.ok ? "" : result.error.message).toMatch(/may or may not have taken effect/);
      const [call] = fake.callsOf("auth.add");
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const deadline = Date.now() + watchdogMs(10_000);
      while ((alive(call!.pid) || alive(call!.grandchild_pid!)) && Date.now() < deadline) await Bun.sleep(20);
      expect(call!.grandchild_pid).toBeGreaterThan(0);
      expect(alive(call!.pid)).toBe(false);
      expect(alive(call!.grandchild_pid!)).toBe(false);
    } finally {
      // Whatever this test started, if the guard under test failed to.
      for (const call of fake.callsOf("auth.add")) {
        for (const pid of [call.pid, call.grandchild_pid]) {
          if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
        }
      }
      fake.dispose();
    }
  }, watchdogMs(60_000));
});
