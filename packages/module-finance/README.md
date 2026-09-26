# @schlessera/brain-module-finance

> **Requires Bun ≥ 1.3** (via `@schlessera/brain`'s `bun:sqlite`) — npm/npx will not
> warn you (npm ignores `engines.bun`); install from https://bun.sh.

Accounts-receivable tracking for freelance / agency client work: per-client
`ledger.md` files are the source of truth, and the module derives every balance,
status, aging bucket, and reconciliation warning from their frontmatter.

Enable it in `brain.config.ts`:

```ts
modules: {
  "@schlessera/brain-module-finance": { clientsDir: "clients", feeTolerance: 30 },
}
```

## Contributed type

| Type      | Directory   | Notes |
|-----------|-------------|-------|
| `finance` | `clients/`  | one sub-directory per client, each holding a `ledger.md` |

**Relocating the directory.** The manifest declares the `finance` type's dir as
the static literal `clients` (a module manifest is evaluated before user config,
so it cannot read `clientsDir`). The `clientsDir` config option is what the CLI
and hygiene check actually use. If you move clients elsewhere, set **both**:

```ts
modules: { "@schlessera/brain-module-finance": { clientsDir: "billing/clients" } },
taxonomy: { types: { finance: { dir: "billing/clients" } } },
```

## Config schema

| Key           | Type     | Default    | Meaning |
|---------------|----------|------------|---------|
| `clientsDir`  | string   | `"clients"`| Directory (relative to the brain root) holding client folders. |
| `feeTolerance`| number   | `30`       | Max per-invoice shortfall (bank/processor fees) still treated as fully paid. |
| `currency`    | string   | `"USD"`    | Currency assumed when a ledger omits `currency:`. |
| `termsDays`   | number   | `30`       | Payment terms (days) assumed when a ledger omits `terms_days:`. |

## Ledger frontmatter spec

Each `clients/<slug>/ledger.md` carries this frontmatter. `templates/ledger.md`
is the annotated starter (used by `brain finance new-client`); this table is the
authoritative field reference.

Top-level keys:

| Key            | Required | Meaning |
|----------------|----------|---------|
| `type`         | —        | `finance` (so the doc classifies correctly). |
| `client`       | yes      | Stable slug; defaults to the directory name. |
| `display_name` | —        | Name shown in reports (falls back to `title`, then `client`). |
| `legal_name`   | —        | Full legal entity name. |
| `currency`     | —        | ISO code; `USD`/`EUR` get a currency symbol, others are suffixed. |
| `status`       | —        | Free-form label (`active` / `inactive` / `archived`); default `active`. |
| `terms_days`   | —        | Payment terms in days; overdue = `issued` + `terms_days`. |

`invoices:` — array of issued/drafted invoices:

| Field         | Meaning |
|---------------|---------|
| `number`      | Invoice id. The `YYYY-<series>-NN` shape enables numbering-gap detection. |
| `period`      | Service month, `YYYY-MM` (optional). |
| `issued`      | Date first sent, `YYYY-MM-DD`. Omit to keep the invoice a **draft**. |
| `hours`       | Optional; hours billed. |
| `amount`      | Invoice total, in `currency` major units. |
| `state`       | Terminal exception only: `written_off` \| `credited`. |
| `paid_via`    | Marks the invoice settled **outside** the tracked payment stream (e.g. an external payment processor). |
| `paid_date`   | Date of that external settlement. |
| `paid_amount` | Amount settled externally; defaults to `amount`. |
| `note`        | Optional free text. |

`payments:` — array of cash receipts. Reconciliation expects `received == (Σ allocations) − fee`:

| Field         | Meaning |
|---------------|---------|
| `date`        | Payment date, `YYYY-MM-DD`. |
| `received`    | Net cash received (after processor/bank fees). |
| `fee`         | Optional; processor/bank fee withheld. |
| `method`      | Optional label (`wire` / `card` / …). |
| `account`     | Optional receiving-account label. |
| `allocations` | `[{ invoice, amount }]` — how the payment is applied to invoices. |
| `note`        | Optional free text. |

### Derived statuses

`draft` (not yet issued) · `open` (issued, unpaid) · `partial` (some paid) ·
`paid` (open balance ≤ 0, or within `feeTolerance`) · `overdue` (past
`issued + terms_days`) · `written_off` · `credited`.

## CLI

The module registers one top-level command, `brain finance`:

| Command                        | Effect |
|--------------------------------|--------|
| `brain finance`                | AR report across every client ledger (`--json` for a `{ portfolio }` envelope). |
| `brain finance sync`           | Regenerate the tables in each ledger body and the `clients/_index.md` dashboard from frontmatter (`--json` → `{ files }`). |
| `brain finance new-client <slug>` | Scaffold `clients/<slug>/ledger.md` from `templates/ledger.md` (errors if it already exists). |

### Generated block

`sync` rewrites only core's `finance` generated region in each ledger body, so
hand-written prose around it is preserved, and bumps `updated` only when the
tables changed:

```
<!-- brain:generated:finance -->
…tables…
<!-- /brain:generated:finance -->
```

A ledger still carrying the older `<!-- BEGIN GENERATED … -->` /
`<!-- END GENERATED -->` markers is rewritten to the region on its next
`sync`, with the same tables.

## Index-sync rules

This module contributes no directory anchors of its own; ledgers are ordinary
documents plus a generated `clients/_index.md` dashboard.

## Hygiene check

`ledger generated block out of date` — a dry-run of `sync`. For every ledger (and
`clients/_index.md`) whose generated block no longer matches its frontmatter, it
emits a `warning` audit issue suggesting `brain finance sync`. Surfaced by
`brain audit`.
