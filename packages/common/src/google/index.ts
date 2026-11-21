/**
 * The Google operations (#4203, plan [`docs/plans/google-workspace.md`](../../../../docs/plans/google-workspace.md)
 * §3 to §6): the catalog, the strict input schemas, limits and error codes,
 * the effect classifier, the strict mailbox parser and allow-list matcher,
 * the raw-draft parser and the structured and content projections; and
 * (#4204, §5 and §6) the `google` policy block's schema and the pure
 * decision function every front door decides a call with.
 *
 * Internal to brain-kit: reached through
 * `@schlessera/brain-common/internal/google-operations`, with no
 * compatibility promise for the module itself. The names and schemas become
 * contract when the host tools expose them (#4207).
 *
 * One definition serves every front door: the hosted host tools, both chat
 * backends' bridge tools and the standalone `brain google` CLI validate the
 * same schemas and classify through the same function. Pure: it imports no
 * Node built-in, spawns nothing and reaches no network (WHATWG globals only),
 * so the browser can read the same definitions.
 */
export * from "./catalog.js";
export * from "./ids.js";
export * from "./classify.js";
export * from "./address.js";
export * from "./mime.js";
export type * from "./records.js";
export * from "./projection.js";
export * from "./policy.js";
export * from "./decision.js";
