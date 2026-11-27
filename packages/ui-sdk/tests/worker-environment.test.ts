/**
 * Which variables reach a worker (#4827), decided without a sandbox: the
 * function runs on any platform and needs no bubblewrap.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { INFERENCE_RELAY_PLACEHOLDER, WITHHELD_KEYS_ENV } from "@schlessera/brain-common/internal/provider-unavailable";
import { PROVIDER_RELAY_SOCKET_ENV } from "@schlessera/brain-common/internal/provider-relay";
import { HOST_GIT_CREDENTIAL_ENV, WORKER_PROVIDER_CREDENTIAL_ENV } from "../src/server/subprocess-env.js";
import { MODULE_GITHUB_SOCKET_ENV, workerEnvironmentArgs, type WorkerEnvironmentInput } from "../src/server/worker-environment.js";

/** The host's own provider keys decide part of the withheld list: each test starts with none. */
const saved = new Map<string, string | undefined>();
beforeEach(() => { for (const name of WORKER_PROVIDER_CREDENTIAL_ENV) { saved.set(name, process.env[name]); delete process.env[name]; } });
afterEach(() => { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } saved.clear(); });

/** The `--setenv` arguments as a name → value map, in their order. */
function variables(input: Partial<WorkerEnvironmentInput> & Pick<WorkerEnvironmentInput, "env">): Map<string, string> {
  const args = workerEnvironmentArgs({ turnProfile: false, transport: false, relayedKeyNames: [], ...input });
  const result = new Map<string, string>();
  for (let at = 0; at < args.length; at += 3) {
    expect(args[at]).toBe("--setenv");
    result.set(args[at + 1]!, args[at + 2]!);
  }
  return result;
}

const ANTHROPIC = "ANTHROPIC_API_KEY", GEMINI = "GEMINI_API_KEY";

describe("workerEnvironmentArgs", () => {
  test("the provider keys used here are ones the worker host withholds", () => {
    expect(WORKER_PROVIDER_CREDENTIAL_ENV).toContain(ANTHROPIC);
    expect(WORKER_PROVIDER_CREDENTIAL_ENV).toContain(GEMINI);
    expect(HOST_GIT_CREDENTIAL_ENV).toContain("GITHUB_TOKEN");
  });

  test("a governed or strict turn worker keeps only the provider credentials it was given in credentialEnv", () => {
    const env = { PATH: "/usr/bin:/bin", [ANTHROPIC]: "sk-odysseus-kept", [GEMINI]: "odysseus-withheld" };
    const seen = variables({ env, turnProfile: true, credentialEnv: [ANTHROPIC] });
    expect(seen.get(ANTHROPIC), "TURN_WORKER_KEEPS_ADMITTED_KEY").toBe("sk-odysseus-kept");
    expect(seen.has(GEMINI), "TURN_WORKER_WITHHOLDS_OTHER_KEY").toBe(false);
    expect(seen.get(WITHHELD_KEYS_ENV), "WITHHELD_NAMES_REPORTED").toBe(GEMINI);
    expect(seen.get("PATH")).toBe("/usr/bin:/bin");
  });

  test.each([["restricted", false], ["maintenance", false], ["transport", true]] as const)(
    "a %s worker receives the environment it was given, host Git credentials only for transport", (_kind, transport) => {
      const env = { PATH: "/usr/bin:/bin", [GEMINI]: "odysseus-gemini", GITHUB_TOKEN: "odysseus-git" };
      const seen = variables({ env, transport });
      expect(seen.get(GEMINI), "NON_TURN_WORKER_KEEPS_PROVIDER_KEY").toBe("odysseus-gemini");
      expect(seen.get("GITHUB_TOKEN"), "HOST_GIT_CREDENTIALS_ONLY_FOR_TRANSPORT").toBe(transport ? "odysseus-git" : undefined);
      expect(seen.has(WITHHELD_KEYS_ENV)).toBe(false);
    });

  test("the provider relay socket is never carried from the input, and is set only when a relay is mounted", () => {
    const env = { [PROVIDER_RELAY_SOCKET_ENV]: "/tmp/odysseus-forged.sock" };
    expect(variables({ env }).has(PROVIDER_RELAY_SOCKET_ENV), "INPUT_RELAY_SOCKET_DROPPED").toBe(false);
    expect(variables({ env, turnProfile: true }).has(PROVIDER_RELAY_SOCKET_ENV)).toBe(false);
    expect(variables({ env, providerRelaySocket: "/run/odysseus/relay.sock" }).get(PROVIDER_RELAY_SOCKET_ENV), "MOUNTED_RELAY_SOCKET_SET")
      .toBe("/run/odysseus/relay.sock");
  });

  test("the withheld names list a relay placeholder and an unseen relayed key, sorted, and are absent when nothing is withheld", () => {
    process.env[ANTHROPIC] = "sk-odysseus-host";
    const env = { [ANTHROPIC]: INFERENCE_RELAY_PLACEHOLDER, ITHACA_SEEN_KEY: "odysseus-given" };
    const seen = variables({ env, turnProfile: true, credentialEnv: [ANTHROPIC], relayedKeyNames: ["ZACYNTHOS_KEY", "ITHACA_SEEN_KEY", "AEOLUS_KEY"] });
    expect(seen.get(WITHHELD_KEYS_ENV), "WITHHELD_NAMES_SORTED").toBe(["AEOLUS_KEY", ANTHROPIC, "ZACYNTHOS_KEY"].sort().join(","));
    delete process.env[ANTHROPIC];
    expect(variables({ env: { [ANTHROPIC]: "sk-odysseus-kept" }, turnProfile: true, credentialEnv: [ANTHROPIC] }).has(WITHHELD_KEYS_ENV),
      "NOTHING_WITHHELD_NO_VARIABLE").toBe(false);
    expect(variables({ env: { [WITHHELD_KEYS_ENV]: "FORGED" }, turnProfile: true }).has(WITHHELD_KEYS_ENV), "HOST_WITHHELD_NAMES_DROPPED").toBe(false);
  });

  test("a data tree sets the brain, data and configuration roots; a GitHub relay its socket", () => {
    const seen = variables({ env: {}, dataTree: { root: "/run/odysseus-data", configRoot: "/brain/ithaca" }, githubSocket: "/run/odysseus-github/github.sock" });
    expect([...seen]).toEqual([["BRAIN_ROOT", "/run/odysseus-data"], ["BRAIN_WORKER_DATA_ROOT", "/run/odysseus-data"],
      ["BRAIN_WORKER_CONFIG_ROOT", "/brain/ithaca"], [MODULE_GITHUB_SOCKET_ENV, "/run/odysseus-github/github.sock"]]);
  });
});
