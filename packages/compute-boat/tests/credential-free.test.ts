/**
 * A sandbox is created credential-free unless the operator names a Boat
 * environment: `noEnv` keeps the owner's environment variables, model and
 * GitHub logins and the in-sandbox Boat key out of it, and nothing of the
 * instance key reaches it.
 */

import { describe, expect, test } from "bun:test";

import { computeProvider } from "../src/index";
import { fakeBoat, OWNER_ENV } from "./helpers/fake-boat";
import { contextFor, KEY } from "./helpers/context";

async function create(options: Record<string, unknown>) {
  const fake = fakeBoat({ apiKey: KEY, readyAfterGets: 0 });
  const outcome = await computeProvider.allocate({ key: "job-penelope-1", leaseSeconds: 600, retain: false }, contextFor(fake, { options }));
  const post = fake.requests.find((r) => r.route === "create")!;
  return { fake, outcome, body: JSON.parse(post.body) as Record<string, unknown> };
}

describe("credential-free sandboxes", () => {
  test("the default create sends noEnv and no environment, env, setup script or files", async () => {
    const { outcome, body } = await create({ machine: "small" });
    expect(outcome.kind).toBe("ok");
    expect(body.noEnv).toBe(true);
    expect(Object.keys(body).filter((k) => ["environment", "env", "setupScript", "files", "hostedPorts"].includes(k))).toEqual([]);
    expect(body.type).toBe("small");
  });

  test("a sandbox from a saved snapshot is still created with noEnv", async () => {
    const { body } = await create({ from: "odysseus-ci" });
    expect([body.from, body.noEnv]).toEqual(["odysseus-ci", true]);
  });

  test("only an operator-named environment attaches one", async () => {
    const { body } = await create({ environment: "ithaca-safe" });
    expect([body.environment, body.noEnv]).toEqual(["ithaca-safe", false]);
  });

  test("a command sees its allowlist and none of the owner's credentials or the instance key", async () => {
    const { fake, outcome } = await create({});
    if (outcome.kind !== "ok") throw new Error(outcome.kind);
    const started = await computeProvider.exec(outcome.sandbox, { argv: ["printenv"], env: { VOYAGE: "ithaca" } }, contextFor(fake));
    if (started.kind !== "ok") throw new Error(started.kind);
    const status = await computeProvider.poll(started.handle, contextFor(fake));
    const stdout = status.kind === "exited" ? status.stdout ?? "" : "";
    expect(stdout).toContain("VOYAGE=ithaca");
    for (const [name, value] of Object.entries(OWNER_ENV)) expect([name, stdout.includes(value)]).toEqual([name, false]);
    expect(stdout).not.toContain(KEY);
    const exec = fake.requests.find((r) => r.route === "exec")!;
    expect(exec.body).not.toContain(KEY);
  });
});
