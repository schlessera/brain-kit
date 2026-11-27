import type { z } from "zod";

/**
 * Counts a schema's `safeParse` calls. Zod defines `safeParse` as an accessor
 * on the prototype, which `spyOn` cannot wrap, so the counter is an own
 * property that shadows it until `restore()` deletes it again.
 */
export function countSafeParse(schema: z.ZodType) {
  const original = schema.safeParse.bind(schema);
  const counter = {
    calls: 0,
    restore: () => {
      delete (schema as { safeParse?: unknown }).safeParse;
    },
  };
  Object.defineProperty(schema, "safeParse", {
    configurable: true,
    value: (...args: Parameters<typeof original>) => {
      counter.calls++;
      return original(...args);
    },
  });
  return counter;
}
