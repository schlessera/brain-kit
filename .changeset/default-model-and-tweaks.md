---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-backend-pi": minor
---

Configurable default model, user-managed OpenRouter models, auto-collapsing
thinking.

- **Default model** (Settings → Models): the profile used when a turn names
  none — a fresh device's first conversation, a share filed into the brain,
  host-initiated actions. Stored server-side; "Auto" prefers a CONNECTED
  subscription account (pi's `openai-codex` — probed via the new
  `hasStoredCredential()` export, a cheap read of pi's auth store) and falls
  back to the built-in default. The resolved default also leads
  `/api/providers`, so a fresh picker lands on it.
- **OpenRouter models** (Settings → Models): add or remove models by id
  (e.g. `z.ai/glm-5.3-flash`) with no env edit or redeploy. Stored ids join
  the Claude roster as declared OpenRouter profiles (api-billed via
  `OPENROUTER_API_KEY`); removing the model behind the stored default resets
  the default to auto.
- **Thinking sections auto-collapse** when their streaming completes,
  leaving the "Thought for ~N tokens" affordance to reopen them.
