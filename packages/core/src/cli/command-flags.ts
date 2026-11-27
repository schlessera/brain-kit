/**
 * The flags each core command reads (#4834). A declaration changes nothing at
 * run time: `parseArgs` still validates every command against one vocabulary
 * (`BOOLEAN_FLAGS` and `VALUE_FLAGS`, io.ts), so a flag that belongs to
 * another command is accepted and ignored. Whether that becomes a usage error
 * is the ruling #4832 holds. `packages/core/tests/cli-flags.test.ts` checks
 * each declaration against that vocabulary, the command's source, its help
 * block, the documented invocations and the first-party hosts that build a
 * core command's arguments.
 */
export interface CommandFlags {
  /** Flags that never take a value. */
  readonly boolean: readonly string[];
  /** Flags that take a value. */
  readonly value: readonly string[];
}

/** Read by the bin entry for every command before dispatch (output mode, help); no command declares them again. */
export const GLOBAL_FLAGS: CommandFlags = { boolean: ["help", "human", "json"], value: [] };
