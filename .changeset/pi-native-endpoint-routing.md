---
"@schlessera/brain-backend-pi": minor
---

Routing migration (breaking): new ordinary and autonomous turns with explicitly
declared built-in pi profiles now honor native configured model endpoints through
the same ModelRuntime used for inference. Previously a raw catalog model could
ignore a models.json endpoint. Native authentication's endpoint still takes
precedence on each request, including changed/refreshed credentials, so a
configured proxy is conditional on native authentication supplying no endpoint.
Review existing native routing/auth configuration when upgrading. Credential,
subscription and billing ownership, model identity, saved-model fallback refusal,
tool authority and autonomous nonpersistence remain intact.
