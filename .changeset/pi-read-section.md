---
"@schlessera/brain": minor
"@schlessera/brain-backend-pi": minor
---

The pi backend's `brain_read` takes the same optional `section` and `max_tokens` as the MCP tool and `brain read`, so a pi agent can read one section of a long document, or get its outline, instead of the whole file. Called with only a path, it returns what it did before. `@schlessera/brain` now exports the shared reader, `readDocumentPart`, together with `SectionNotFoundError` and `ReadPartOptions`.
