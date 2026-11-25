/**
 * The standalone Google glue's own rules (#4208): which home is used, where a
 * home may lie, the search cursors and the routing verdict. The commands'
 * envelopes are proven through the real bin in cli-contract.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { googleCursorStore, GOOGLE_CURSOR_FILE, GOOGLE_CURSOR_LIMIT, GOOGLE_CURSOR_TTL_MS } from "../src/lib/google/cursors.ts";
import { gogAuthArgv, GogAuthArgvError } from "../src/lib/google/gog-auth.ts";
import { checkGoogleHome, selectGoogleHome, standaloneGoogleHome } from "../src/lib/google/home.ts";
import { standaloneGoogleRouting } from "../src/lib/google/standalone.ts";

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

const env = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over });
function base() {
  return {
    hostHome: undefined as string | undefined, hostKeyringPassword: undefined as string | undefined, hostGogPath: undefined as string | undefined,
    home: undefined as string | undefined, keyringPassword: "standalone-pass" as string | undefined, gogPath: "/opt/gog/gog" as string | undefined,
    dataHome: "/odysseus/data" as string | undefined, userHome: "/odysseus",
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
    expect(checkGoogleHome(join(root, "state/google"), root)).toMatchObject({ ok: false, reason: "home_inside_brain" });
    expect(checkGoogleHome(root, root)).toMatchObject({ ok: false, reason: "home_inside_brain" });
    // Another brain repository than the current one.
    const other = brain();
    expect(checkGoogleHome(join(other, "google"), root)).toMatchObject({ ok: false, reason: "home_inside_brain" });
    const outside = dir();
    expect(checkGoogleHome(join(outside, "google"), join(outside, "google", "brain"))).toMatchObject({ ok: true });
    const holder = dir();
    const held = join(holder, "brain");
    mkdirSync(held);
    writeFileSync(join(held, "brain.config.json"), "{}\n");
    expect(checkGoogleHome(holder, held)).toMatchObject({ ok: false, reason: "home_holds_brain" });
    const link = join(dir(), "link");
    symlinkSync(root, link);
    expect(checkGoogleHome(join(link, "google"), root)).toMatchObject({ ok: false, reason: "home_inside_brain" });
  });

  test("google home: a working directory that is not a brain does not count as one", () => {
    const cwd = dir();
    expect(checkGoogleHome(join(cwd, ".local/share/brain/google"), cwd)).toEqual({ ok: true, exists: false, path: join(cwd, ".local/share/brain/google") });
  });

  test("google home must be absolute, a directory, this user's and private", () => {
    const root = brain();
    expect(checkGoogleHome("relative/google", root)).toMatchObject({ ok: false, reason: "home_invalid" });
    expect(checkGoogleHome("/odysseus/\ngoogle", root)).toMatchObject({ ok: false, reason: "home_invalid" });
    const parent = dir();
    const file = join(parent, "file");
    writeFileSync(file, "");
    expect(checkGoogleHome(file, root)).toMatchObject({ ok: false, reason: "home_not_directory" });
    const open = join(parent, "open");
    mkdirSync(open);
    chmodSync(open, 0o750);
    expect(checkGoogleHome(open, root)).toMatchObject({ ok: false, reason: "home_permissions" });
    const own = join(parent, "own");
    mkdirSync(own, { mode: 0o700 });
    expect(checkGoogleHome(own, root, statSync(own).uid + 1)).toMatchObject({ ok: false, reason: "home_owner" });
    expect(checkGoogleHome(own, root)).toMatchObject({ ok: true, exists: true });
  });
});

describe("google search cursors", () => {
  test("google cursor stands for one page token of one account and query, and expires", () => {
    const home = dir();
    let clock = 1_783_850_000_000;
    const store = googleCursorStore(home, () => clock);
    const cursor = store.mint("ithaca", "from:penelope", "09876543210987654321");
    expect(cursor).toMatch(/^gc_[A-Za-z0-9_-]{16,64}$/);
    expect(store.resolve("ithaca", "from:penelope", cursor)).toBe("09876543210987654321");
    // Usable again, so a failed page can be retried.
    expect(store.resolve("ithaca", "from:penelope", cursor)).toBe("09876543210987654321");
    expect(store.resolve("sparta", "from:penelope", cursor)).toBeNull();
    expect(store.resolve("ithaca", "from:eumaeus", cursor)).toBeNull();
    expect(store.resolve("ithaca", "from:penelope", "gc_AAAAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
    const file = join(home, GOOGLE_CURSOR_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // The query is kept as its digest, never its text.
    expect(readFileSync(file, "utf8")).not.toContain("penelope");
    clock += GOOGLE_CURSOR_TTL_MS;
    expect(store.resolve("ithaca", "from:penelope", cursor)).toBeNull();
  });

  test("google cursor store keeps the newest cursors and reads a damaged file as empty", () => {
    const home = dir();
    let clock = 1_783_850_000_000;
    const store = googleCursorStore(home, () => clock++);
    const minted = Array.from({ length: GOOGLE_CURSOR_LIMIT + 1 }, (_, index) => store.mint("ithaca", "in:inbox", `token${index}`));
    expect(store.resolve("ithaca", "in:inbox", minted[0]!)).toBeNull();
    expect(store.resolve("ithaca", "in:inbox", minted.at(-1)!)).toBe(`token${GOOGLE_CURSOR_LIMIT}`);
    writeFileSync(join(home, GOOGLE_CURSOR_FILE), "{ not json");
    expect(store.resolve("ithaca", "in:inbox", minted.at(-1)!)).toBeNull();
    expect(() => store.mint("ithaca", "in:inbox", "a token\nwith a line")).toThrow();
  });
});

describe("google standalone routing and account argv", () => {
  test("google routing: provider rules that keep anything from google are unproven without a conversation", () => {
    expect(standaloneGoogleRouting([])).toBe("allowed");
    expect(standaloneGoogleRouting([{ paths: ["me/**"], allow: ["anthropic", "google"] }])).toBe("allowed");
    expect(standaloneGoogleRouting([{ paths: ["me/**"], allow: ["anthropic"] }])).toBe("recipient_unproven");
  });

  test("google account argv: one element per value, positionals after --, no line breaks", () => {
    expect(gogAuthArgv({ command: "auth.alias.set", positionals: ["ithaca", "-odysseus@example.com"] })).toEqual([
      "--no-input", "--json", "--color=never", "--enable-commands-exact=auth.alias.set", "--gmail-no-send", "auth", "alias", "set", "--", "ithaca", "-odysseus@example.com",
    ]);
    expect(() => gogAuthArgv({ command: "auth.add", flags: [["auth-url", "http://127.0.0.1/cb?code=x\n--services=all"]] })).toThrow(GogAuthArgvError);
    expect(() => gogAuthArgv({ command: "auth.add", positionals: ["odysseus@example.com\u2028"] })).toThrow(GogAuthArgvError);
  });
});
