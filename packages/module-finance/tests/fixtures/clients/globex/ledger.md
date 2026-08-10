---
type: finance
client: globex
display_name: Globex
currency: USD
status: active
terms_days: 30
created: 2026-01-01
updated: 2026-01-01
invoices:
  - number: 2026-globex-01
    period: 2026-01
    issued: 2026-01-10
    amount: 1000
    note: Underpaid by 25 (client-side bank fee) — within fee tolerance.
payments:
  - date: 2026-01-18
    received: 975
    fee: 0
    method: wire
    allocations:
      - invoice: 2026-globex-01
        amount: 975
---

# Globex

Fixture ledger: a 25.00 shortfall that the fee-tolerance rule zeroes out.
