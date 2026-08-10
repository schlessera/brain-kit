---
# Client ledger — the source of truth for accounts-receivable tracking.
#
# Everything below the "BEGIN GENERATED" marker in the body is rewritten by
# `brain finance sync` from the frontmatter below. Edit only this frontmatter
# by hand; hand-written prose outside the generated block is preserved.
type: finance
client: __SLUG__                    # stable slug; must match the directory name
display_name: __DISPLAY__           # human-readable name shown in reports
# legal_name: Acme Corporation LLC  # optional; full legal entity name
currency: __CURRENCY__              # ISO code; drives money formatting (USD/EUR special-cased)
status: active                      # free-form label: active | inactive | archived
terms_days: __TERMS__               # payment terms in days; overdue = issued + terms_days
created: __TODAY__
updated: __TODAY__

# invoices: every invoice issued (or drafted) to this client.
#   number:  invoice id. The "YYYY-<series>-NN" shape enables numbering-gap detection.
#   period:  service month, YYYY-MM (optional).
#   issued:  date first sent, YYYY-MM-DD. Omit to keep the invoice a draft.
#   hours:   optional; hours billed.
#   amount:  invoice total, in `currency` major units.
#   state:   terminal exception only — written_off | credited.
#   paid_via / paid_date / paid_amount:
#            marks an invoice settled OUTSIDE the tracked payment stream (e.g. via an
#            external payment processor). paid_amount defaults to `amount`.
#   note:    optional free text.
invoices:
  - number: __YEAR__-__SLUG__-01
    period: __PERIOD__
    issued: __TODAY__
    hours: 40
    amount: 4000
    note: First engagement invoice (fully paid in the example below).
  - number: __YEAR__-__SLUG__-02
    period: __PERIOD__
    issued: __TODAY__
    amount: 2000
    note: Second invoice — partially paid, leaves an open balance.

# payments: cash actually received. Each payment allocates its received amount
# across one or more invoices. Reconciliation expects: received == (Σ allocations) − fee.
#   date:        payment date, YYYY-MM-DD.
#   received:    net cash received (after processor/bank fees).
#   fee:         optional; processor/bank fee withheld.
#   method:      optional label — wire | card | ...
#   account:     optional receiving-account label.
#   allocations: [{ invoice, amount }] — how the payment is applied to invoices.
#   note:        optional free text.
payments:
  - date: __TODAY__
    received: 4000
    fee: 0
    method: wire
    allocations:
      - invoice: __YEAR__-__SLUG__-01
        amount: 4000
    note: Settles invoice 01 in full.
  - date: __TODAY__
    received: 1000
    fee: 0
    method: wire
    allocations:
      - invoice: __YEAR__-__SLUG__-02
        amount: 1000
    note: Partial payment against invoice 02.
---

# __DISPLAY__

Hand-written context about this client goes here (contacts, scope, rate history).
Prose above and below the generated block is preserved by `brain finance sync`.

<!-- BEGIN GENERATED — do not edit by hand; run `brain finance sync` -->

_Run `brain finance sync` to populate the summary, invoice, and payment tables._

<!-- END GENERATED -->
