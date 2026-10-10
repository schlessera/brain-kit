# Reproducing the #550 measurement

The JSON evidence records the executed comparison. `*.txt` files retain parameterized source copies of its external harness; copy each to scratch without the final `.txt` suffix. These copies are not the same bytes as the host-specific executed files. `provenance.json` and `executed-manifest.json` retain their actual hashes. No credential or account identity is included.

Use a dedicated checkout at the source commit recorded in the report and install its dependencies locally. Use Linux with bubblewrap, Bun, RTK, and a locally installed Claude CLI at the reported version (set its resolved executable path, not a symlink outside the mounted runtime). Set `BRAIN_MEASUREMENT_CHECKOUT`, `BRAIN_MEASUREMENT_SCRATCH` (an empty owned directory), `BRAIN_MEASUREMENT_BUN`, `BRAIN_MEASUREMENT_CLAUDE`, and `BRAIN_MEASUREMENT_RTK` to absolute paths. Copy `executed-manifest.json` and `input-review-snapshot.json` into scratch too. The launcher obtains the existing Claude OAuth access token from the caller's credential store and passes it only into the isolated child environment. Keep each Claude subscription invocation serial.

`freeze.py` verifies the original source and corpus hashes, hashes the parameterized copies and creates a fresh snapshot and cap plan. Its locally generated billing ledger reserves the full issue allowance; it is not the original aggregate-session billing ledger and does not establish authorization for a new spend. The review command needs a fresh independent approval on those new hashes; old successful receipts cannot admit changed files.

From the checkout, with the above environment set, the command sequence is:

```sh
rtk proxy python 3 "$BRAIN_MEASUREMENT_SCRATCH/freeze.py"
rtk proxy python 3 "$BRAIN_MEASUREMENT_SCRATCH/launch.py" preflight
rtk proxy bun "$BRAIN_MEASUREMENT_SCRATCH/capture-probe.ts"
rtk proxy bun "$BRAIN_MEASUREMENT_SCRATCH/auth-probe.ts" valid
rtk proxy bun "$BRAIN_MEASUREMENT_SCRATCH/auth-probe.ts" api-init
rtk proxy bun "$BRAIN_MEASUREMENT_SCRATCH/auth-probe.ts" missing-init
rtk proxy bun "$BRAIN_MEASUREMENT_SCRATCH/auth-probe.ts" api-env
rtk proxy bun "$BRAIN_MEASUREMENT_SCRATCH/auth-probe.ts" missing-account
rtk proxy bun "$BRAIN_MEASUREMENT_SCRATCH/auth-probe.ts" api-account
rtk proxy env TMPDIR="$BRAIN_MEASUREMENT_SCRATCH" bun --preload "$BRAIN_MEASUREMENT_SCRATCH/raw-capture-preload.ts" "$BRAIN_MEASUREMENT_SCRATCH/server-smoke.ts"
rtk proxy bun "$BRAIN_MEASUREMENT_SCRATCH/pi-api-smoke.ts"
# Run each documented mode in pi-api-controls.ts; its delegate is offline.
rtk proxy bun "$BRAIN_MEASUREMENT_SCRATCH/pi-api-controls.ts" valid
rtk proxy python 3 "$BRAIN_MEASUREMENT_SCRATCH/launch.py" stage
rtk proxy python 3 "$BRAIN_MEASUREMENT_SCRATCH/matrix-controller.py" review
rtk proxy python 3 "$BRAIN_MEASUREMENT_SCRATCH/matrix-controller.py" sdk
rtk proxy python 3 "$BRAIN_MEASUREMENT_SCRATCH/matrix-controller.py" claude
rtk proxy python 3 "$BRAIN_MEASUREMENT_SCRATCH/matrix-controller.py" pi
```

The controller stops on missing/changed input hashes, unapproved review, unknown usage, auth/model mismatch, errors or observed subscription overage. Review every final accepted call's kept items against its answer. No automatic quality score follows from the drop predicate. Before rerunning provider calls, retain the offline seam receipt and obtain the corresponding independent protocol review for the chosen inputs.

For the Pi API phase, provide the authorized `ANTHROPIC_API_KEY` to the parent environment; the isolated launcher removes OAuth and admits the key only to instrumented Pi requests. The counter command can use subscription credentials: `rtk proxy python 3 "$BRAIN_MEASUREMENT_SCRATCH/launch.py" run scripts/measure-show-block.ts --suggestions --tokens`. Original execution hashes remain immutable even when parameterized helpers are improved.
