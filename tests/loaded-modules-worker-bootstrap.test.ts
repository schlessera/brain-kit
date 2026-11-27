/**
 * What the trusted worker bootstraps load before they refuse or `execve`
 * (#4796). Every worker launch starts `worker-entry.ts`, every egress launch
 * `egress-worker-entry.ts`, and every SSH connection a worker opens
 * `egress-connect.ts`: none of them may load the protocol module, the safety
 * schemas, the host-side egress proxy or zod. Observed with
 * `tests/helpers/loaded-modules.ts`; each case first proves a module the run
 * must have loaded is listed, so an absence is evidence.
 */
import { describe, expect, test } from "bun:test";
import { runLoadedModules } from "./helpers/loaded-modules";

const cwd = `${import.meta.dir}/..`;
const env = { PATH: process.env.PATH ?? "" };
const SDK = "packages/ui-sdk/src/";

const zod = (modules: string[]) => modules.filter((path) => path.includes("node_modules/zod/"));
const run = (argv: string[]) => runLoadedModules(argv, { cwd, env });
const imported = (file: string) => run(["-e", `await import(${JSON.stringify(`./${file}`)})`]);

describe("worker bootstraps load no protocol, safety schema or zod", () => {
  test("worker-entry.ts refuses a launch without a payload having loaded none of them", async () => {
    // The helper's standard streams are not FIFOs, so the bootstrap refuses at
    // its descriptor check, after its static imports, and writes nothing.
    const result = await run([`${SDK}server/worker-entry.ts`]);
    expect(result.code).toBe(1);
    expect(result.modules).toContain(`${SDK}config/env.ts`);
    for (const file of ["protocol.ts", "schemas.ts", "safety.ts", "server/backend.ts", "server/egress-proxy.ts"]) expect(result.modules).not.toContain(`${SDK}${file}`);
    expect(zod(result.modules)).toEqual([]);
  });

  test("egress-worker-entry.ts and egress-connect.ts refuse without arguments having loaded no proxy, safety schema or zod", async () => {
    const entry = await run([`${SDK}server/egress-worker-entry.ts`]);
    expect(entry.code).toBe(1);
    expect(entry.stderr).toContain("Egress bootstrap requires an absolute executable");
    const connect = await run([`${SDK}server/egress-connect.ts`]);
    expect(connect.code).toBe(2);
    expect(connect.stderr).toContain("usage: egress-connect <host> <port>");
    for (const result of [entry, connect]) {
      for (const file of ["server/egress-proxy.ts", "safety.ts"]) expect(result.modules).not.toContain(`${SDK}${file}`);
      expect(zod(result.modules)).toEqual([]);
      expect(result.modules).toContain(`${SDK}server/egress-paths.ts`);
    }
  });

  test("the module that defines attachMaintenanceTemp loads no protocol, safety schema or zod", async () => {
    const result = await imported(`${SDK}server/maintenance-temp-budget.ts`);
    expect(result.code).toBe(0);
    expect(result.modules).toContain(`${SDK}server/maintenance-temp-budget.ts`);
    for (const file of ["protocol.ts", "schemas.ts", "safety.ts"]) expect(result.modules).not.toContain(`${SDK}${file}`);
    expect(zod(result.modules)).toEqual([]);
  });

  test("protocol.ts loads neither the safety schemas nor zod", async () => {
    const result = await imported(`${SDK}protocol.ts`);
    expect(result.code).toBe(0);
    expect(result.modules).toContain(`${SDK}protocol.ts`);
    expect(result.modules).not.toContain(`${SDK}safety.ts`);
    expect(zod(result.modules)).toEqual([]);
  });
});
