---
"@schlessera/brain-ui-server": patch
---

Internal: no ui-server source file imports another in a runtime cycle any more (#4818). Five stores and their write-procedure modules now share leaf modules instead of importing each other; declarations moved unchanged and no route, response or stored row changes.
