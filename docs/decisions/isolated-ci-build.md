# Isolated CI build output reuse

The [maintainer ruling on #2319](https://github.com/schlessera/brain-kit/issues/2319#issuecomment-6237827676)
selects one fixed first-party CI build operation. Ordinary local builds and
unsupported contexts rebuild without requiring Docker. This is build output
reuse, not reuse of test results or authority to omit selected proof.

The previous stamp could authorize a skip after an effective compiler config
target or installed emitter changed. Package versions, link strings and a
larger code manifest do not establish everything an active producer reads.
The [completed #1837 investigation](https://github.com/schlessera/brain-kit/issues/1837#issuecomment-6236303704)
measured conditional duplicate work; its 606.090 seconds are executed builder
work, not measured saved elapsed time or cache eligibility.

## Authority and fallback

CI intent only requests the fixed operation. Positive reuse requires an exact
reviewed producer/configuration/installation/runtime qualification, a complete
captured input identity, a previous successful drained execution of that same
operation, and a matching current output tree including modes and bytes.
Changing source invalidates the input identity. Unsupported effective aliases,
changed executable configuration or installed producers, unavailable context
and ambiguous state require ordinary compilation. A real producer failure
propagates; it is not retried as an ordinary build to manufacture success.

The fixed operation consumes captured bytes through read-only mounts, a fixed
environment and local-only executable resolution, without network acquisition.
Source and dependency snapshots, fresh writable state and outputs have separate
ownership. The original checkout, host scratch, credentials and Docker socket
are not producer mounts. The image identity covers its immutable filesystem;
it does not by itself qualify kernel interfaces, devices, clocks or random
sources. Output-sensitive ambient reads must be bounded by actual operation
qualification. Unknowns cannot become supported inputs through a hash or a
successful output sample.

Workspace leases continue coordinating cooperating writers. They do not
restrict compiler reads. A private container operation has its own explicit
input boundary; the diagram export operation grants it no inherited authority.
Normal and isolated builds share the concrete compiler/copy/bin scheduler,
without an extension or plugin interface. The isolated entry receives only
validated manifest-selected pending packages. No public CLI or environment
bypass changes ordinary package selection.

## Publication and evidence

Only checked bytes from a completed, drained operation may replace workspace
outputs. Stamps live outside shipped package paths and follow verified
publication. Missing, modified, extra, aliased or mode-changed outputs refuse a
skip. Interrupted or failed execution cannot issue a successful receipt.
Records distinguish unsupported fallback, unqualified evidence, compilation and
reuse; an intent flag or synthetic fixture is never production qualification.

Activation requires causal offline boundary and output controls, actual
unchanged child omission, config/installed-compiler/stylesheet invalidation,
source-marker/default-export freshness, all nineteen packed consumer inventories
and comparable hosted setup/critical-path measurements including identity and
publication overhead. The operation remains unqualified until those concrete
identities and evidence are reviewed. This requirement also binds later
producer, runtime, installed-input and configuration changes.
