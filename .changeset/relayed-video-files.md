---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-module-video": patch
---
`brain video watch` works in a governed or strict worker that holds no Gemini key: the host's provider relay now carries the Gemini Files lifecycle a local video needs. The relay hands the worker a token URL in place of the provider's upload URL, accepts a provider upload URL only on the authorized origin's `/upload/` path, and polls, deletes or names in a generation only the files its own uploads created. A blocked budget refuses the upload before any byte is sent; polling and deletion never wait on a budget, and files a cancelled or killed worker leaves behind are deleted when the turn's relay stops. Each step is a relay attempt with operation `files`, priced at zero because the Files API is free. A relayed worker no longer reports `capability=video`.
