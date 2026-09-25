---
"@schlessera/brain": patch
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-scrape": patch
---

Each of the nine extension seams (`EmbeddingProvider`, `CompletionProvider`, `AgentRunner`, `SkillEmitter`, `AgentBackend`, `SpeechProvider`, `AsrClient`, `ToolRenderer`, `SiteAdapter`) now carries its own `@experimental` tag, as do `BackendBridge`, `BackendCapabilities`, `StartTurnRequest`, `RendererPack`, `SpeechSession`, `AsrClientOptions`, `AdapterResult` and `ScrapeContext`, so an editor tooltip and the published declarations say what the docs already did. No shape changes. The ui-sdk README now states protocol rev 4.
