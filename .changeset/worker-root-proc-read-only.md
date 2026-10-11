---
"@schlessera/brain-ui-sdk": patch
---

When the server runs as root, an agent worker's `/proc` is now read-only. A worker runs as the server's kernel uid without capabilities, but for uid 0 most host-global `/proc` files check only the file mode. A root-run server's worker could therefore write host kernel settings, such as sysctls, through its fresh procfs. Root servers still qualify, and workers of non-root servers are unchanged. Running the server as a non-root user is still recommended.
