# Isolated CI build output reuse

The [2026-10-20 maintainer ruling on #2319](https://github.com/schlessera/brain-kit/issues/2319#issuecomment-6284109466)
defers activation and retains the dormant operation and producer-context fix.
It narrows the earlier [fixed-operation ruling](https://github.com/schlessera/brain-kit/issues/2319#issuecomment-6237827676)
to an independently reviewable delivery under `Refs #2319`. Production
qualification remains unqualified and CI intent stays off. Ordinary local builds and
unsupported contexts rebuild without requiring Docker. This is build output
reuse, not reuse of test results or authority to omit selected proof.

The original optimization, ambient-input, native-provenance and comparable
hosted-cost acceptance criteria remain open in #2319 after a dormant delivery.
The ruling neither waives those criteria nor authorizes a stronger deterministic
runtime/native-build boundary; that would require a separate specification and
maintainer ruling. Required selected hosted proof of the dormant slice remains
separate from activation qualification.

Finite local controls exposed concrete limits: direct vDSO clock reads bypass
the diagnostic libc interposition, kernel/device and hardware inputs remain
unqualified, and registry integrity for the consumed LightningCSS archive does
not establish its source-to-binary provenance. Equal output samples and a bound
producer context cannot close those gaps. Measured capture and lookup overhead
also lacks a comparable hosted baseline. These limits motivate deferral, not
a speedup or completed optimization claim.

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
Unreadable, aliased or malformed qualification policy also falls back before
Docker access; parsing JSON alone does not establish a valid policy shape.

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
Every eligible lookup observes the fixed daemon through a fresh, bounded,
session-owned context container. Its actual boot, kernel release/version, CPU
affinity and Node bytes join the lookup identity with the daemon identity. The
compiling container independently reports its context; a mismatch refuses
publication. A repeat still starts a context reader, even when it starts no
compiler or stylesheet children. Unavailable context refuses reuse; unconfirmed
context-container cleanup is a failure. Caller host boot data and socket inode
equality cannot substitute for this observation. These are necessary context
bindings, not proof of clock, entropy, hardware or other ambient independence.

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

File capture traverses Linux directory descriptors without following aliases,
opens regular files with no-follow and nonblocking flags, and checks descriptor
and ancestor bindings before and after bounded reads. Captured bytes, rather
than a later pathname read, become the operation input. Mutable receipt and
policy files use the same capture rule; kernel process-status files have fixed
kernel-owned origins and are not repository inputs.

The fixed operation requires non-root UID and GID. Each local daemon control
has a ten-second limit; the image-owned entry has a 300-second TERM deadline
with five-second KILL grace, and its host client has a 330-second limit. These
operation bounds require real qualification on all nineteen packages before
activation. They do not alter ordinary builds or test deadlines. A session label and immutable container ID are verified before any stop, wait
or removal, including interruption handling. Subsequent mutations and the
absence check address that ID, so replacement of a name grants no authority.
Session-owned container removal and confirmed absence precede output publication and reuse
stamps. Unconfirmed cleanup fails, records the incomplete cleanup and retains
owned state; it never grants successful reuse authority.

## Private qualification operation

The fixed `--qualify-private` controller creates one fresh private workspace
and exercises the same capture, necessary receipt predicates, derived-output
capture, compiler scheduler, cleanup and publication implementation. Its
operation name, receipt purpose and random workspace domain differ from
production. Copying a qualification receipt into the production cache cannot
make it eligible. Only this fixed controller creates that private context;
there is no caller-selected executor or output-root option.

Qualification runs never update the production policy. The controller checks
real unchanged child omission and output identities, per-package recovery,
source/config/installed-compiler/nested-stylesheet changes and the existing
nineteen-package packed consumer assertions. Each observation retains actual
phase costs. Producer failures remain failures; unsupported inputs use the
ordinary private-workspace builder. Real interruption, browser consumers and
comparable hosted costs remain separate required evidence before activation.

The trace arm adds a captured diagnostic executable and its libraries through
read-only mounts, without network, extra capabilities or seccomp relaxation.
It is a different observed arm: exact output identity is compared to the
unobserved operation, and its receipts cannot seed ordinary repeat reuse.
Syscall observation cannot establish vDSO or hardware independence. Kernel,
device, time, randomness, unresolved paths and incomplete traces remain
unqualified until a finite source-specific audit and causal controls explain
the actual output dependency. An image hash or a sample output match cannot
remove those unknowns.

Packed consumers use the existing `ciPack` assertions. Dependency acquisition
happens only as separate preparation before the closed operation: a fixed
private catalog records exact registry tarball integrity and transitive
packages, with reviewed integrity from the workspace lock or explicit consumer
records. The operation itself uses Bun's native offline mode, a fresh private
cache and no install scripts. Before consumer imports, installed payload bytes
must equal verified archived bytes. Missing cache artifacts, integrity or
unsupported install shapes fail; they do not fall back to an online installer.
Preparation does not change project dependencies or the workspace lock.

The private packed-consumer policy supports physical hoisted package trees,
including independently verified package-root dependencies. Hidden install
stores such as `.bun`, package aliases, unknown sidecars and archive payload
links are unsupported. Hidden package files and every bundled or vendor
`node_modules` byte remain part of the verified archive payload; there is no
blanket directory-name exclusion. Installed `.bin` aliases must resolve to
verified bytes declared by a package manifest. This policy does not add direct
dependencies or overrides to flatten the consumer graph.

The pinned Bun's native binlink optimization redirects esbuild's alias into an
optional platform package without a `bin` declaration. Consumer installers
disable that optimization with its fixed native-linker feature flag, retaining
the declared wrapper and unchanged dependency graph and payloads. Actual offline
controls compare both layouts and execute both entrypoints; the strict verified
alias rule still applies before every consumer import.

Consumer cache, archive extraction and installer scratch use the private
disk-backed diagnostics child, bound at fixed `/consumer-work` outside the
captured repository. This preserves the authoritative outside-repo consumer
ancestry: missing dependencies cannot climb into captured `/repo/node_modules`.
The mount is consumer-only and session-owned. These paths do not enlarge the producer's `/tmp` tmpfs,
memory allowance or deadline. The outer qualification harness must also
kernel-isolate networking for ordinary fallback compiler children; the Docker
producer boundary alone does not cover those host-side children. Registry
prefill is a separate preparation step outside that proof harness.

Bun's packing and workspace-pin probes temporarily write package manifests
and a probe tarball. Those unchanged probes run against a physical private
repository copy under the consumer mount, excluding diagnostics scratch. The
captured `/repo` remains read-only, and the installed consumers occupy a sibling
directory so missing dependencies cannot resolve from that repository copy.
