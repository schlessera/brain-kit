---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-sdk": patch
---

A governed or strict turn now runs only on the turn egress proxy and the host inference relay. The server already refused to boot without managed native storage, so every supported host had the relay, but admission still had a fallback that would have run such a turn on its own network, without the proxy or the relay. Admission now refuses a turn whose startup view the native manager did not acquire on managed native storage, with an explicit error. On a brain that is not on managed native storage, worker-host status (`runtime.workerHost.governed.egress`) still reports `active: false`, and its detail now says those turns are refused. On every running server it reports `active: true`. The response shape is unchanged, and the agent-worker docs no longer describe hosts without managed native storage as supported.
