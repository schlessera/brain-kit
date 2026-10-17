/** Test-only, non-evaluating engine instrumentation; always restore in finally. */
import matter from "gray-matter";

export function frontmatterEngineSentinel(value: Record<string, unknown> = { schema_version: 1 }) {
  const engines = (matter as unknown as { engines: Record<string, unknown> }).engines;
  const saved = Object.getOwnPropertyDescriptors(engines);
  const dispatched: string[] = [];
  for (const name of ["javascript", "js", "json", "coffee", "coffeescript", "cson", "odyssey"]) {
    Object.defineProperty(engines, name, { configurable: true, writable: true, enumerable: true,
      value: { parse: () => { dispatched.push(name); return structuredClone(value); } } });
  }
  return { dispatched, restore() {
    for (const name of Object.keys(engines)) if (!Object.hasOwn(saved, name)) delete engines[name];
    Object.defineProperties(engines, saved);
  } };
}
