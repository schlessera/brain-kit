/**
 * A maintenance output refused because it changes tier A inputs (#4256).
 * Publication is refused exactly as before; the error also names every
 * protected path the output changed and, while the output still exists, lets
 * the host read one of those files so it can decide what to do with an
 * incoming change. It never writes anything and grants nothing.
 */
export class ProtectedMaintenanceOutputError extends Error {
  constructor(
    /** Every changed path the tier A rule refuses, sorted. */
    readonly paths: readonly string[],
    /**
     * The output's bytes of one refused path: null when it is absent or not a
     * regular file, a refusal when larger than `bound`. Valid only until the
     * output is cleaned up.
     */
    readonly read: (rel: string, bound: number) => Promise<Uint8Array | null>,
  ) {
    super(`maintenance output cannot change protected input ${paths[0]}`);
    this.name = "ProtectedMaintenanceOutputError";
  }
}
