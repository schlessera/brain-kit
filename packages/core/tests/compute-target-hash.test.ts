/**
 * The compute canonicaliser's rule (#4772), through the narrowest thing that
 * exposes it: the target hash (`configHash`) a job record stores. The
 * canonicaliser is private to the service, so the test admits one job and
 * reads its record. Running jobs are driven only while their instance still
 * hashes the same, so these literals must never change; the options carry the
 * inputs on which the repository's three `canonicalJson` functions differ.
 */
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { PENELOPE, jobDirs, sandbox, service, type Sandbox } from "./helpers/compute/fixture";
import { memoryCompute } from "./helpers/compute/memory-provider";

let box: Sandbox | undefined;
afterEach(() => box?.dispose());

/** The stored target hash of one job admitted on an instance with these options. */
async function targetHash(options: unknown): Promise<string> {
  box?.dispose();
  box = sandbox();
  // The memory provider's own schema is strict; this one passes the options through untouched.
  const provider = { ...memoryCompute().provider, configSchema: z.unknown() };
  const svc = service(box, { providers: { ithaca: { provider, options, lease: { maxSeconds: 600 }, maxConcurrent: 4 } } } as never);
  const run = await svc.run(PENELOPE, { instance: "ithaca", argv: ["sleep", "60"] });
  if (!run.ok) throw new Error(run.code);
  const [dir] = jobDirs(box.state);
  return (JSON.parse(readFileSync(join(box.state, "jobs", dir!, "job.json"), "utf8")) as { configHash: string }).configHash;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

test("pins the target hash on the inputs where the three canonicalisers differ", async () => {
  const options = {
    member: { b: 1, a: undefined },
    array: [1, undefined, 2],
    nan: Number.NaN,
    inf: Number.POSITIVE_INFINITY,
    negZero: -0,
    date: new Date(0),
    nested: { z: { y: 1, x: [{ b: 2, a: 1 }] }, a: "s" },
  };
  const canonical = `{"keyEnv":null,"options":{"array":[1,null,2],"date":{},"inf":null,"member":{"b":1},"nan":null,"negZero":0,"nested":{"a":"s","z":{"x":[{"a":1,"b":2}],"y":1}}},"provider":"memory"}`;
  const hash = await targetHash(options);
  expect(hash).toBe(sha256(canonical));
  expect(hash).toBe("2bfae35f3a7f7ea82dcbe49c8424a108cd928f116edd52fd6ef5277302fb27c3");
});
