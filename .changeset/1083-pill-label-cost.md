---
"@schlessera/brain-ui-server": minor
---

Record what the pill labeller spends. Every label call that reaches the host's label model is now an Activity run named `pill label` (`LABEL_RUN_NAME`) on the session whose pill it labels. A provider can report the call's usage and model through a new optional `LabelCompletionProvider.completeWithUsage`, which the labeller prefers to `complete()`, and the host declares how those calls are billed with `createApp({ labeller: { provider, billing: "api" | "subscription" } })`. A run is priced only when the call reported usage and a model and `billing` is set. Every other run counts as unpriced and is never shown as $0; that includes every call from a core `CompletionProvider`, which still satisfies the interface unchanged.
