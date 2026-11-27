---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-backend-claude": patch
---

A launch refused because host private state is reachable in its namespace (#4301) keeps its cause end to end. The server registers its private-state layout for launch qualification (`createHostBoundary`, so the server and cron alike), and every site that wraps or flattens a launch error keeps the typed refusal: the admission's maintenance probe answers that one admission with the governed unavailability reason `private_state_exposed` and stores nothing, so governed and strict turns are refused alike and the next admission probes again; `brainGitSteps` and the private index build rethrow it instead of answering 127 or a build failure; Claude and Pi turns reach the client as `PRIVATE_STATE_EXPOSED` with `failure.errorClass: "private_state_exposed"`.

An exposure never refuses boot. A host with a declared minimum CLI version used to refuse boot when the CLI's version could not be asked; when that is because of an exposure, the version check is deferred and repeated before every later preparation and execution through the boundary, and enforced then. Authenticated status gains optional `governed.stateBoundary` (`mode: "walk"` on every host for now, with the last refusal and owner-only names) and `runtime.privateStateLastExposure`, retained across restart and written off the launch path; `runtime.operationalStateLastFailure` is unchanged.
