/**
 * Compile-time structural equality, shared by the `.test-d.ts` files.
 *
 * `satisfies z.ZodType<T>` only proves ASSIGNABILITY — a schema missing an
 * optional key, or adding one, still satisfies it. These helpers compare the
 * two shapes in both directions, which is what catches drift.
 */
import type { z } from "zod";

/** Remove z.looseObject's catch-all index signature without losing named keys. */
export type StripIndexSignature<T> = {
  [K in keyof T as string extends K
    ? never
    : number extends K
      ? never
      : symbol extends K
        ? never
        : K]: T[K];
};

/**
 * Canonical recursive shape used for comparison. Arrays recurse through their
 * elements. Objects with named keys lose z.looseObject's catch-all signature;
 * pure record types retain their index signature and value type.
 */
export type DeepShape<T> = T extends readonly unknown[]
  ? // Homomorphic for tuples AND variable-length arrays, which is what keeps
    // the readonly modifier: rewriting an array as `Array<DeepShape<...>>`
    // would erase it, and `readonly AskUserOption[]` versus `AskUserOption[]`
    // would then compare equal.
    { [K in keyof T]: DeepShape<T[K]> }
  : T extends object
    ? keyof StripIndexSignature<T> extends never
      ? { [K in keyof T]: DeepShape<T[K]> }
      : {
          [K in keyof StripIndexSignature<T>]: DeepShape<StripIndexSignature<T>[K]>;
        }
    : T;

export type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? (<T>() => T extends Right ? 1 : 2) extends <T>() => T extends Left ? 1 : 2
      ? true
      : false
    : false;

export type SchemaEqualsProtocol<Schema extends z.ZodType, Protocol> = Equal<
  DeepShape<z.infer<Schema>>,
  DeepShape<Protocol>
>;

export type Assert<Condition extends true> = Condition;
