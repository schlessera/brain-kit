---
type: finance
client: acme-corp
display_name: Acme Corporation
currency: USD
status: active
terms_days: 30
created: 2026-01-01
updated: 2026-01-01
invoices:
  - number: 2026-acme-corp-01
    period: 2026-01
    issued: 2026-01-15
    hours: 40
    amount: 4000
    note: Fully paid.
  - number: 2026-acme-corp-02
    period: 2026-01
    issued: 2026-01-15
    hours: 20
    amount: 2000
    note: Partially paid.
payments:
  - date: 2026-01-20
    received: 4000
    fee: 0
    method: wire
    allocations:
      - invoice: 2026-acme-corp-01
        amount: 4000
  - date: 2026-01-25
    received: 1000
    fee: 0
    method: wire
    allocations:
      - invoice: 2026-acme-corp-02
        amount: 1000
---

# Acme Corporation

Fixture ledger: one fully paid invoice and one partially paid invoice.
