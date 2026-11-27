---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

A new conversation can choose the provider's fast output mode with `chat_message.outputSpeed: "fast"`. The host stores the speed with the session and runs every turn at it, resumes included, so a session's request shape and cache never change. A fast run is recorded as real spend at the fast rate, on a subscription too, priced from the pinned runtime's fast-rate table and never from standard rates; live budgets use the same rates, so every dollar cap holds. A fast turn that the runtime dropped to standard speed mid-turn ends with `fast_output_unavailable` instead of a plain success. A backend, profile, account or upstream that cannot serve fast output refuses the turn with `fast_output_unavailable` before any model request, instead of running it at standard speed. The Claude backend serves it through a first-party upstream only. The pi backend refuses it. The SDK adds `OutputSpeed`, `StartTurnRequest.outputSpeed`, `BackendCapabilities.fastOutput` and `FastOutputUnavailableError`.
