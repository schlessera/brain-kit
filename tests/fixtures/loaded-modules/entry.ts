/**
 * The self-test fixture of `tests/helpers/loaded-modules.ts`. The first
 * argument picks what the entry does after its static imports evaluate:
 * none prints and returns, `lazy` also imports `lazy-dep.ts`, `exit` calls
 * `process.exit(1)` before the entry's own evaluation completes, and `hang`
 * never exits.
 */
import { z } from "zod";
import type { Greeting } from "./type-only-dep.ts";
import { Shape } from "./type-used-dep.ts";
import { greeting } from "./static-dep.ts";

const mode = process.argv[2];
const value: Greeting = { text: z.string().parse(greeting) };
const shape: Shape | undefined = undefined;

if (mode === "exit") process.exit(1);
if (mode === "hang") setInterval(() => {}, 1_000);
if (mode === "lazy") {
  const { lazyGreeting } = await import("./lazy-dep.ts");
  value.text += ` ${lazyGreeting}`;
}
console.log(value.text, shape === undefined);
