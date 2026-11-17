---
"@schlessera/brain-backend-pi": patch
---
A pi worker torn down by an inactive abort or a failed startup now closes its turn temp once per teardown attempt. Its exit no longer starts a competing close, which could turn one refused cleanup into two attempts, as seen when the losing worker of a concurrent duplicate resume was torn down.
