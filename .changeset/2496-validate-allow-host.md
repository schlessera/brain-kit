---
"@schlessera/brain-render-puppeteer": patch
"@schlessera/brain-render-template": patch
"@schlessera/brain": patch
---

`brain render --allow-host` and the renderer's `allowHosts` now refuse any value that is not a plain host name or IP address. Before, `--allow-host '*'` exempted every host from the renderer's DNS blackhole, and a value with a comma could inject another resolver rule. A wildcard, comma, space, scheme, port or path is now a usage error that names the value, before anything renders. An allowed host also admits only its `http:` and `https:` requests.
