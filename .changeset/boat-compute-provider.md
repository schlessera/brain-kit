---
"@schlessera/brain-compute-boat": minor
"@schlessera/brain": minor
---

Ship Boat as the first external compute provider (#3106). The new `@schlessera/brain-compute-boat` package implements the `ComputeProvider` seam over Boat's public API with plain `fetch`, no vendor SDK and no install script, and passes both shared conformance suites against a fake transport. Core declares it as an optional peer and loads it only when a `compute.providers` instance names `provider: "boat"`; without it installed the instance is `provider_unavailable` with the install it needs. A `boat` instance reads `BRAIN_COMPUTE_BOAT_API_KEY` unless it names `apiKeyEnv`, accepts the options `machine`, `from`, `environment` and `org`, creates credential-free (`noEnv`) sandboxes unless an environment is named, treats readiness apart from setup, never represents a stop as a pause, reports retention of at most 14 days and takes actual cost from Boat's usage report, unknown otherwise.
