/**
 * The trusted web executor's configuration and pin (#3686). The executor
 * running end to end is `packages/ui-server/tests/web-pi-executor.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PINNED_WEB_EXTENSION, prepareWebExecutorState, sanitizeWebExecutorConfig, webExecutorCommand } from "../src/internal.js";
import { pinnedWebExtensionEntry } from "../src/web-executor.js";

const REPO = join(import.meta.dir, "../../..");

describe("sanitizeWebExecutorConfig", () => {
  test("removes every credential command, wherever it is, and keeps literal and environment keys", () => {
    const { config, removed } = sanitizeWebExecutorConfig({
      exaApiKey: "odysseus-literal", braveApiKey: "!pass show brave", tavilyApiKey: "$TAVILY_API_KEY", kagiApiKey: "$!literal-bang",
      tavily: { keys: ["first", " !op read tavily", "second"] }, nested: { deeper: { perplexityApiKey: "!security find-generic-password" } },
    });
    expect(config.exaApiKey).toBe("odysseus-literal");
    expect(config.tavilyApiKey).toBe("$TAVILY_API_KEY");
    expect(config.kagiApiKey, "an escaped literal is not a command").toBe("$!literal-bang");
    expect(config).not.toHaveProperty("braveApiKey");
    expect(config.tavily).toEqual({ keys: ["first", "second"] });
    expect(config.nested).toEqual({ deeper: {} });
    expect(JSON.stringify(config), "WEB_CONFIG_NO_CREDENTIAL_COMMAND").not.toMatch(/"\s*!/);
    expect(removed).toEqual(expect.arrayContaining(["braveApiKey", "tavily.keys[1]", "nested.deeper.perplexityApiKey"]));
  });

  test("turns off every deferred workflow and excluded mode and keeps the four tools under their own names", () => {
    const { config, removed } = sanitizeWebExecutorConfig({
      workflow: "summary-review", summaryModel: "anthropic/claude", curatorRemote: true, allowBrowserCookies: true,
      browserCookies: { profile: "Default" }, chromeProfile: "Default", toolNames: { webSearch: "search_everything" },
      tools: { fetchContent: { enabled: false } }, commands: { curator: { enabled: true } }, shortcuts: { curate: "ctrl+k" },
      video: { enabled: true }, youtube: { enabled: true }, image: { enabled: true }, githubClone: { enabled: true, clonePath: "/srv/clones" },
      searchRouting: { providers: ["exa", "brave"], fallbackOn: ["transient"] }, exaBaseUrl: "https://exa.example", ssrf: { allowRanges: [] },
    });
    expect(config, "WEB_CONFIG_FORCED").toMatchObject({
      workflow: "none", allowBrowserCookies: false,
      tools: { webSearch: { enabled: true }, fetchContent: { enabled: true }, getSearchContent: { enabled: true }, sourceCheck: { enabled: true } },
      commands: { websearch: { enabled: false }, curator: { enabled: false }, search: { enabled: false }, "google-account": { enabled: false } },
      image: { enabled: false }, video: { enabled: false }, youtube: { enabled: false }, githubClone: { enabled: false },
    });
    for (const key of ["summaryModel", "curatorRemote", "browserCookies", "chromeProfile", "toolNames", "shortcuts"]) expect(config).not.toHaveProperty(key);
    // Host-owned provider routing and endpoints are the executor's to use.
    expect(config.searchRouting).toEqual({ providers: ["exa", "brave"], fallbackOn: ["transient"] });
    expect(config.exaBaseUrl).toBe("https://exa.example");
    // The egress route resolves and checks destinations; the executor never looks names up itself (#3687).
    expect(config.ssrf, "WEB_CONFIG_TRUSTS_THE_ROUTE").toEqual({ trustEnvProxy: true });
    expect(removed).toEqual(expect.arrayContaining(["workflow", "allowBrowserCookies", "toolNames", "tools", "commands", "githubClone"]));
  });

  test("a non-object configuration becomes the forced defaults alone", () => {
    for (const host of [null, [], "provider", 3]) expect(Object.keys(sanitizeWebExecutorConfig(host).config).sort())
      .toEqual(["allowBrowserCookies", "commands", "githubClone", "image", "ssrf", "tools", "video", "workflow", "youtube"]);
  });
});

describe("prepareWebExecutorState", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "odysseus-web-state-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test("creates a private directory whose environment names nothing of the host but the catalog keys", () => {
    const hostConfig = join(root, "web-search.json");
    writeFileSync(hostConfig, JSON.stringify({ exaApiKey: "odysseus-key", braveApiKey: "!cat /etc/shadow" }));
    const before = readFileSync(hostConfig, "utf8");
    const state = prepareWebExecutorState({ root: join(root, "sessions"), hostConfigPath: hostConfig,
      credentialEnv: { EXA_API_KEY: "odysseus-env-key", BRAVE_API_KEY: "  ", KAGI_API_KEY: undefined }, path: "/usr/bin:/bin" });
    expect(statSync(state.dir).mode & 0o777, "WEB_STATE_PRIVATE_DIR").toBe(0o700);
    const copy = join(state.dir, "agent", "web-search.json");
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(copy, "utf8"))).not.toHaveProperty("braveApiKey");
    expect(state.removed).toContain("braveApiKey");
    expect(state.env, "WEB_STATE_ENV_IS_PRIVATE").toEqual({
      PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: state.dir, XDG_CONFIG_HOME: join(state.dir, "xdg"), PI_CODING_AGENT_DIR: join(state.dir, "agent"),
      PI_WEB_ACCESS_CACHE_ROOT: join(state.dir, "cache"), TMPDIR: join(state.dir, "tmp"), PI_OFFLINE: "1", EXA_API_KEY: "odysseus-env-key",
    });
    expect(readFileSync(hostConfig, "utf8"), "WEB_STATE_HOST_CONFIG_UNCHANGED").toBe(before);
    const command = webExecutorCommand("/usr/bin/bun", state.dir, { proxyDir: join(root, "egress") });
    const [entry, dir] = command.slice(-2);
    expect(existsSync(entry!)).toBe(true);
    expect(dir).toBe(state.dir);
    // The executor's network is its egress route alone (#3687).
    expect(command, "WEB_EXECUTOR_NETWORK_NAMESPACE").toContain("--unshare-net");
    expect(command.slice(command.indexOf(join(root, "egress")) - 1, command.indexOf(join(root, "egress")) + 2)).toEqual(["--ro-bind", join(root, "egress"), "/run/brain-egress"]);
    state.cleanup();
    expect(existsSync(state.dir)).toBe(false);
  });

  test("an absent or unparseable host configuration runs with the forced defaults only", () => {
    const missing = prepareWebExecutorState({ root, hostConfigPath: join(root, "absent.json"), credentialEnv: {}, path: "/bin" });
    writeFileSync(join(root, "broken.json"), "{ not json");
    const broken = prepareWebExecutorState({ root, hostConfigPath: join(root, "broken.json"), credentialEnv: {}, path: "/bin" });
    for (const state of [missing, broken]) expect(JSON.parse(readFileSync(join(state.dir, "agent", "web-search.json"), "utf8")).workflow).toBe("none");
  });
});

describe("the pinned upstream extension", () => {
  test("is the reviewed artifact: exact version, registry integrity and published entry", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
    expect(manifest.dependencies["pi-web-access"], "WEB_PIN_EXACT_VERSION").toBe(PINNED_WEB_EXTENSION.version);
    const lock = readFileSync(join(REPO, "bun.lock"), "utf8");
    expect(lock, "WEB_PIN_LOCK_INTEGRITY").toContain(`"pi-web-access": ["pi-web-access@${PINNED_WEB_EXTENSION.version}", "", `);
    expect(lock).toContain(`"${PINNED_WEB_EXTENSION.integrity}"]`);
    const installed = JSON.parse(readFileSync(join(dirname(pinnedWebExtensionEntry()), "..", "package.json"), "utf8"));
    expect(installed.version, "WEB_PIN_INSTALLED_VERSION").toBe(PINNED_WEB_EXTENSION.version);
    expect(installed.pi?.extensions, "WEB_PIN_PUBLISHED_ENTRY").toEqual(["./dist"]);
    expect(existsSync(pinnedWebExtensionEntry())).toBe(true);
  });

  test("declares Pi SDK peers the backend's own exact pins satisfy", () => {
    const installed = JSON.parse(readFileSync(join(dirname(pinnedWebExtensionEntry()), "..", "package.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
    for (const peer of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"]) {
      expect(installed.peerDependencies[peer], `${peer} peer range`).toBe("*");
      expect(manifest.dependencies[peer]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
