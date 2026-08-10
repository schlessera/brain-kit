// ---------------------------------------------------------------------------
// Finance: accounts-receivable tracking for client invoices & payments.
//
// Source of truth is the YAML frontmatter of each `<clientsDir>/<slug>/ledger.md`
// file (an `invoices:` array and a `payments:` array). Everything derived —
// per-invoice paid/open balance, status, overdue days, aging buckets, per-client
// and portfolio totals, and reconciliation warnings — is computed here and never
// hand-maintained. `syncFiles` regenerates the human-readable tables in the ledger
// bodies and the `<clientsDir>/_index.md` dashboard from that same frontmatter.
//
// Nothing here reads a module-level ROOT/CLIENTS_DIR/FEE_TOLERANCE constant:
// every entry point takes a FinanceOptions bag so the engine is reusable across
// brains and testable against fixtures.
// ---------------------------------------------------------------------------

import { resolve, join, relative } from "path";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import matter from "gray-matter";
import { safeResolve } from "@schlessera/brain";

/** Runtime configuration for the AR engine, threaded through every entry point. */
export interface FinanceOptions {
  /** Absolute brain root. */
  root: string;
  /** Clients directory, relative to root (e.g. "clients"). */
  clientsDir: string;
  /**
   * A payment is treated as fully settling its allocated invoices when the
   * shortfall (bank/intermediary fees) is at or below this threshold — keeps a
   * small wire fee from leaving an invoice perpetually "partially paid".
   */
  feeTolerance: number;
  /** Currency assumed when a ledger omits `currency:`. */
  defaultCurrency: string;
  /** Payment terms (days) assumed when a ledger omits `terms_days:`. */
  defaultTermsDays: number;
}

// Markers delimiting the generated block inside a markdown body. Hand-written
// prose above the opening marker (and below the closing one) is preserved.
const GEN_BEGIN = "<!-- BEGIN GENERATED — do not edit by hand; run `brain finance sync` -->";
const GEN_END = "<!-- END GENERATED -->";

export interface Allocation {
  invoice: string;
  amount: number;
}

export interface Payment {
  date: string;
  received: number;
  fee?: number;
  method?: string;
  account?: string;
  allocations: Allocation[];
  note?: string;
}

export interface Invoice {
  number: string;
  period?: string; // service month, YYYY-MM
  issued?: string; // date first sent to client, YYYY-MM-DD
  hours?: number;
  amount: number;
  // Terminal exceptions only; the normal lifecycle is derived from payments.
  state?: "written_off" | "credited";
  // Settled outside the tracked payment stream (e.g. via an external payment
  // processor / channel). Marks the invoice paid without a detailed payment
  // record. paidAmount defaults to the full invoice amount.
  paidVia?: string;
  paidDate?: string;
  paidAmount?: number;
  note?: string;
}

export interface ClientLedger {
  slug: string;
  currency: string;
  legalName?: string;
  displayName: string;
  status: string;
  termsDays: number;
  invoices: Invoice[];
  payments: Payment[];
  ledgerPath: string; // relative to root
}

export type InvoiceStatus =
  | "draft"
  | "open"
  | "partial"
  | "paid"
  | "overdue"
  | "written_off"
  | "credited";

export interface ComputedInvoice extends Invoice {
  paid: number;
  open: number;
  status: InvoiceStatus;
  daysOverdue: number; // 0 when not overdue
}

export interface AgingBuckets {
  current: number;
  d1_30: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
}

export interface ClientReport {
  slug: string;
  displayName: string;
  currency: string;
  status: string;
  invoiced: number;
  received: number; // cash actually received via tracked payments (net of fees)
  allocated: number; // amount applied to invoices via tracked payments
  fees: number;
  settledExternal: number; // invoices settled outside tracked payments
  settledByChannel: Record<string, number>;
  open: number;
  invoiceCount: number;
  paymentCount: number;
  openInvoices: ComputedInvoice[];
  invoices: ComputedInvoice[];
  aging: AgingBuckets;
  warnings: string[];
}

export interface Portfolio {
  asOf: string;
  clients: ClientReport[];
  openByCurrency: Record<string, number>;
  warningCount: number;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Coerce a YAML value (possibly a Date from gray-matter) to a YYYY-MM-DD string. */
function dstr(v: any): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString().split("T")[0];
  return String(v);
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function daysBetween(fromISO: string, toISO: string): number {
  const ms = Date.parse(toISO + "T00:00:00Z") - Date.parse(fromISO + "T00:00:00Z");
  return Math.floor(ms / 86_400_000);
}

/** Load every client ledger under <clientsDir>/<slug>/ledger.md. */
export function loadLedgers(opts: FinanceOptions, filterSlug?: string): ClientLedger[] {
  const clientsDir = resolve(opts.root, opts.clientsDir);
  if (!existsSync(clientsDir)) return [];
  const ledgers: ClientLedger[] = [];

  for (const entry of readdirSync(clientsDir)) {
    // Canonicalize + contain each client dir: a symlinked <clientsDir>/<slug>
    // pointing outside the root must not become a write target downstream,
    // and a dangling symlink must not crash the scan.
    const dir = safeResolve(opts.root, join(opts.clientsDir, entry));
    if (!dir) continue;
    let isDir: boolean;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const ledgerFile = join(dir, "ledger.md");
    if (!existsSync(ledgerFile)) continue;
    if (filterSlug && entry !== filterSlug) continue;

    const { data } = matter(readFileSync(ledgerFile, "utf8"));
    const slug = String(data.client || entry);
    // gray-matter parses bare YAML dates into JS Date objects; coerce back to
    // YYYY-MM-DD strings so date math doesn't produce Invalid Date.
    ledgers.push({
      slug,
      currency: String(data.currency || opts.defaultCurrency),
      legalName: data.legal_name ? String(data.legal_name) : undefined,
      displayName: String(data.display_name || data.title || slug),
      status: String(data.status || "active"),
      termsDays: Number.isFinite(data.terms_days) ? Number(data.terms_days) : opts.defaultTermsDays,
      invoices: (data.invoices || []).map((i: any) => ({
        number: String(i.number),
        period: dstr(i.period),
        issued: dstr(i.issued),
        hours: i.hours,
        amount: Number(i.amount),
        state: i.state,
        paidVia: i.paid_via,
        paidDate: dstr(i.paid_date),
        paidAmount: i.paid_amount != null ? Number(i.paid_amount) : undefined,
        note: i.note,
      })),
      payments: (data.payments || []).map((p: any) => ({
        date: dstr(p.date) || "",
        received: Number(p.received),
        fee: p.fee != null ? Number(p.fee) : undefined,
        method: p.method,
        account: p.account,
        allocations: (p.allocations || []).map((a: any) => ({
          invoice: String(a.invoice),
          amount: Number(a.amount),
        })),
        note: p.note,
      })),
      ledgerPath: relative(opts.root, ledgerFile),
    });
  }

  ledgers.sort((a, b) => a.slug.localeCompare(b.slug));
  return ledgers;
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

export function computeClient(
  ledger: ClientLedger,
  feeTolerance: number,
  asOf = today()
): ClientReport {
  const warnings: string[] = [];

  // Paid-per-invoice from all payment allocations.
  const paidByInvoice = new Map<string, number>();
  const invoiceNumbers = new Set(ledger.invoices.map((i) => i.number));
  let received = 0;
  let allocated = 0;
  let fees = 0;

  for (const p of ledger.payments) {
    received = round2(received + (p.received || 0));
    fees = round2(fees + (p.fee || 0));
    const allocSum = round2(
      (p.allocations || []).reduce((s, a) => s + (a.amount || 0), 0)
    );
    allocated = round2(allocated + allocSum);

    // Reconciliation: received should equal allocated minus stated fees.
    const expected = round2(allocSum - (p.fee || 0));
    if (Math.abs(expected - (p.received || 0)) > 0.01) {
      warnings.push(
        `payment ${p.date}: received ${p.received} ≠ allocated ${allocSum} − fee ${p.fee || 0} (= ${expected})`
      );
    }

    for (const a of p.allocations || []) {
      if (!invoiceNumbers.has(a.invoice)) {
        warnings.push(`payment ${p.date}: allocation to unknown invoice ${a.invoice}`);
      }
      paidByInvoice.set(a.invoice, round2((paidByInvoice.get(a.invoice) || 0) + (a.amount || 0)));
    }
  }

  const settledByChannel: Record<string, number> = {};
  let settledExternal = 0;

  const computed: ComputedInvoice[] = ledger.invoices.map((inv) => {
    // Settled outside the tracked payment stream (e.g. via an external
    // payment processor); recorded only by channel, not per-payment.
    if (inv.paidVia) {
      const amt = round2(inv.paidAmount ?? inv.amount);
      settledExternal = round2(settledExternal + amt);
      settledByChannel[inv.paidVia] = round2((settledByChannel[inv.paidVia] || 0) + amt);
      if (paidByInvoice.has(inv.number)) {
        warnings.push(`invoice ${inv.number}: marked paid_via ${inv.paidVia} but also has payment allocations`);
      }
      return { ...inv, paid: amt, open: 0, status: "paid" as InvoiceStatus, daysOverdue: 0 };
    }

    const paid = round2(paidByInvoice.get(inv.number) || 0);
    let open = round2(inv.amount - paid);
    if (open > 0 && open <= feeTolerance && paid > 0) open = 0; // fee shortfall
    if (paid - inv.amount > 0.01) {
      warnings.push(`invoice ${inv.number}: overpaid — ${paid} allocated vs ${inv.amount} invoiced`);
    }

    let status: InvoiceStatus;
    let daysOverdue = 0;
    if (inv.state === "written_off") status = "written_off";
    else if (inv.state === "credited") status = "credited";
    else if (!inv.issued) status = "draft";
    else if (open <= 0.01) status = "paid";
    else {
      status = paid > 0 ? "partial" : "open";
      const due = addDays(inv.issued, ledger.termsDays);
      const overdueBy = daysBetween(due, asOf);
      if (overdueBy > 0) {
        status = "overdue";
        daysOverdue = overdueBy;
      }
    }
    return { ...inv, paid, open, status, daysOverdue };
  });

  // Sequential numbering gaps, per YYYY-series (gapless is best practice).
  checkNumberingGaps(ledger.invoices, warnings);

  const invoiced = round2(ledger.invoices.reduce((s, i) => s + i.amount, 0));
  const openInvoices = computed.filter((i) => i.open > 0.01);
  const open = round2(openInvoices.reduce((s, i) => s + i.open, 0));

  const aging: AgingBuckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const i of openInvoices) {
    const d = i.daysOverdue;
    if (d <= 0) aging.current = round2(aging.current + i.open);
    else if (d <= 30) aging.d1_30 = round2(aging.d1_30 + i.open);
    else if (d <= 60) aging.d31_60 = round2(aging.d31_60 + i.open);
    else if (d <= 90) aging.d61_90 = round2(aging.d61_90 + i.open);
    else aging.d90_plus = round2(aging.d90_plus + i.open);
  }

  return {
    slug: ledger.slug,
    displayName: ledger.displayName,
    currency: ledger.currency,
    status: ledger.status,
    invoiced,
    received,
    allocated,
    fees,
    settledExternal,
    settledByChannel,
    open,
    invoiceCount: ledger.invoices.length,
    paymentCount: ledger.payments.length,
    openInvoices,
    invoices: computed,
    aging,
    warnings,
  };
}

function addDays(iso: string, days: number): string {
  const t = Date.parse(iso + "T00:00:00Z") + days * 86_400_000;
  return new Date(t).toISOString().split("T")[0];
}

function checkNumberingGaps(invoices: Invoice[], warnings: string[]): void {
  const seriesSeqs = new Map<string, number[]>();
  for (const inv of invoices) {
    const m = inv.number.match(/^(\d{4})-(.+)-(\d+)$/);
    if (!m) continue;
    const key = `${m[1]}-${m[2]}`;
    const seq = parseInt(m[3], 10);
    (seriesSeqs.get(key) || seriesSeqs.set(key, []).get(key)!).push(seq);
  }
  for (const [key, seqs] of seriesSeqs) {
    seqs.sort((a, b) => a - b);
    for (let n = 1; n <= seqs[seqs.length - 1]; n++) {
      if (!seqs.includes(n)) warnings.push(`numbering gap: ${key} missing #${String(n).padStart(2, "0")}`);
    }
  }
}

/** Compute the full AR portfolio from every (or one) client ledger. */
export function buildPortfolio(
  opts: FinanceOptions,
  filterSlug?: string,
  asOf = today()
): Portfolio {
  return portfolioFromLedgers(loadLedgers(opts, filterSlug), opts.feeTolerance, asOf);
}

function portfolioFromLedgers(
  ledgers: ClientLedger[],
  feeTolerance: number,
  asOf: string
): Portfolio {
  const clients = ledgers.map((l) => computeClient(l, feeTolerance, asOf));
  const openByCurrency: Record<string, number> = {};
  let warningCount = 0;
  for (const c of clients) {
    openByCurrency[c.currency] = round2((openByCurrency[c.currency] || 0) + c.open);
    warningCount += c.warnings.length;
  }
  return { asOf, clients, openByCurrency, warningCount };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function money(n: number, currency: string): string {
  const s = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "USD" ? `$${s}` : currency === "EUR" ? `€${s}` : `${s} ${currency}`;
}

const STATUS_ICON: Record<InvoiceStatus, string> = {
  draft: "·", open: "○", partial: "◐", paid: "✓", overdue: "⚠",
  written_off: "✗", credited: "↩",
};

/** Human-readable AR report for the terminal. */
export function renderReport(pf: Portfolio): string {
  const out: string[] = [];
  out.push(`Accounts Receivable — as of ${pf.asOf}\n`);

  for (const c of pf.clients) {
    out.push(`${c.displayName}  (${c.currency}${c.status !== "active" ? `, ${c.status}` : ""})`);
    out.push(`  Invoiced:  ${money(c.invoiced, c.currency).padStart(14)}  (${c.invoiceCount} invoices)`);
    out.push(`  Received:  ${money(c.received, c.currency).padStart(14)}  (cash, ${c.paymentCount} payments)`);
    for (const [ch, amt] of Object.entries(c.settledByChannel)) {
      out.push(`  Settled:   ${money(amt, c.currency).padStart(14)}  (via ${ch}, external channel)`);
    }
    out.push(`  Open:      ${money(c.open, c.currency).padStart(14)}  (${c.openInvoices.length} invoices)`);

    if (c.openInvoices.length) {
      out.push(`  Open invoices:`);
      for (const i of c.openInvoices) {
        const age = i.daysOverdue > 0 ? `${i.daysOverdue}d overdue` : "not yet due";
        out.push(
          `    ${STATUS_ICON[i.status]} ${i.number.padEnd(18)} ${(i.period || "").padEnd(8)} ${money(i.open, c.currency).padStart(12)}  ${age}`
        );
      }
      const a = c.aging;
      out.push(
        `  Aging:  current ${money(a.current, c.currency)} · 1-30 ${money(a.d1_30, c.currency)} · 31-60 ${money(a.d31_60, c.currency)} · 61-90 ${money(a.d61_90, c.currency)} · 90+ ${money(a.d90_plus, c.currency)}`
      );
    }
    if (c.warnings.length) {
      out.push(`  ⚠ warnings:`);
      for (const w of c.warnings) out.push(`     - ${w}`);
    }
    out.push("");
  }

  const totals = Object.entries(pf.openByCurrency)
    .map(([cur, amt]) => money(amt, cur))
    .join(" · ");
  out.push(`TOTAL OPEN: ${totals || "—"}`);
  if (pf.warningCount) out.push(`(${pf.warningCount} reconciliation warning(s) above)`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Sync: regenerate human-readable tables from frontmatter
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: "draft", open: "open", partial: "partial", paid: "paid ✓",
  overdue: "overdue ⚠", written_off: "written off", credited: "credited",
};

/** Markdown tables + summary for a single client's ledger body. */
function renderLedgerTables(c: ClientReport, payments: Payment[]): string {
  const cur = c.currency;
  const lines: string[] = [];

  lines.push(`## Summary\n`);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|------:|`);
  lines.push(`| Invoiced (${c.invoiceCount}) | ${money(c.invoiced, cur)} |`);
  lines.push(`| Received (cash, ${c.paymentCount} payments) | ${money(c.received, cur)} |`);
  lines.push(`| Allocated to invoices | ${money(c.allocated, cur)} |`);
  lines.push(`| Bank/processor fees | ${money(c.fees, cur)} |`);
  for (const [ch, amt] of Object.entries(c.settledByChannel)) {
    lines.push(`| Settled via ${ch} (external) | ${money(amt, cur)} |`);
  }
  lines.push(`| **Open balance (${c.openInvoices.length})** | **${money(c.open, cur)}** |`);
  const a = c.aging;
  lines.push("");
  lines.push(`Aging of open balance — current ${money(a.current, cur)} · 1–30 ${money(a.d1_30, cur)} · 31–60 ${money(a.d31_60, cur)} · 61–90 ${money(a.d61_90, cur)} · 90+ **${money(a.d90_plus, cur)}**`);

  lines.push(`\n## Invoices\n`);
  lines.push(`| Invoice | Period | Issued | Hours | Amount | Paid | Open | Status |`);
  lines.push(`|---------|--------|--------|------:|-------:|-----:|-----:|--------|`);
  for (const i of c.invoices) {
    const statusText = i.paidVia
      ? `paid ✓ (${i.paidVia})`
      : `${STATUS_LABEL[i.status]}${i.daysOverdue ? ` (${i.daysOverdue}d)` : ""}`;
    lines.push(
      `| ${i.number} | ${i.period || ""} | ${i.issued || ""} | ${i.hours ?? ""} | ${money(i.amount, cur)} | ${money(i.paid, cur)} | ${i.open > 0.01 ? money(i.open, cur) : "—"} | ${statusText} |`
    );
  }

  lines.push(`\n## Payments\n`);
  lines.push(`| Date | Received | Fee | Method | Settles |`);
  lines.push(`|------|---------:|----:|--------|---------|`);
  for (const p of payments) {
    const settles = (p.allocations || []).map((al) => `${al.invoice} (${money(al.amount, cur)})`).join(", ");
    lines.push(`| ${p.date} | ${money(p.received, cur)} | ${money(p.fee || 0, cur)} | ${p.method || "wire"} | ${settles} |`);
  }

  if (c.settledExternal > 0) {
    const chans = Object.keys(c.settledByChannel).join(", ");
    lines.push(
      `\n_Invoices marked "paid (${chans})" were settled outside the tracked payment stream (external ${chans} channel). Exact receipt dates/amounts live in that channel; counted above under "Settled via ${chans}"._`
    );
  }

  return lines.join("\n");
}

/** Portfolio dashboard table for <clientsDir>/_index.md. */
function renderIndexTable(pf: Portfolio): string {
  const lines: string[] = [];
  lines.push(`_As of ${pf.asOf}. Generated from each client's \`ledger.md\` — run \`brain finance sync\` to refresh._\n`);
  lines.push(`| Client | Status | Invoiced | Settled | Open | Oldest open | Dir |`);
  lines.push(`|--------|--------|---------:|--------:|-----:|-------------|-----|`);
  for (const c of pf.clients) {
    const oldest = c.openInvoices.length
      ? `${c.openInvoices[0].period || c.openInvoices[0].number} (${c.openInvoices[0].daysOverdue}d)`
      : "—";
    const settled = Math.max(0, Math.round((c.invoiced - c.open) * 100) / 100);
    lines.push(
      `| ${c.displayName} | ${c.status} | ${money(c.invoiced, c.currency)} | ${money(settled, c.currency)} | **${money(c.open, c.currency)}** | ${oldest} | [${c.slug}](${c.slug}/) |`
    );
  }
  lines.push("");
  const totals = Object.entries(pf.openByCurrency).map(([cur, amt]) => money(amt, cur)).join(" · ");
  lines.push(`**Total open: ${totals || "—"}**`);
  if (pf.warningCount) lines.push(`\n⚠ ${pf.warningCount} reconciliation warning(s) — run \`brain finance\` to see them.`);
  return lines.join("\n");
}

/** Replace the generated block in `body`, preserving hand-written prose. */
function replaceGeneratedBlock(body: string, generated: string): string {
  const block = `${GEN_BEGIN}\n\n${generated}\n\n${GEN_END}`;
  const re = new RegExp(`${escapeRe(GEN_BEGIN)}[\\s\\S]*?${escapeRe(GEN_END)}`);
  if (re.test(body)) return body.replace(re, block);
  return `${body.trimEnd()}\n\n${block}\n`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface SyncResult {
  files: string[];
}

// Split a file into its raw frontmatter block (including the --- fences) and
// the body. Frontmatter is preserved verbatim so hand-formatted YAML data
// arrays are never re-serialized (which would mangle them into flow style).
function splitFrontmatter(raw: string): { fm: string; body: string } {
  const m = raw.match(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n[\s\S]*)?$/);
  if (!m) return { fm: "", body: raw };
  return { fm: m[1], body: m[2] ?? "" };
}

/**
 * Compute the rewritten file content for a ledger/dashboard: replaces only the
 * generated body block and bumps `updated:` in the frontmatter text. Returns
 * null when the generated block is already current (nothing to write).
 */
function computeRewrite(abs: string, generated: string, asOf: string): string | null {
  const raw = readFileSync(abs, "utf8");
  const { fm, body } = splitFrontmatter(raw);
  const newBody = replaceGeneratedBlock(body, generated);
  if (newBody === body) return null;
  const newFm = fm.replace(/^updated:.*$/m, `updated: ${asOf}`);
  return `${newFm}${newBody}`;
}

/** Rewrite only the generated body block; bump `updated:`. Returns true if written. */
function rewriteBody(abs: string, generated: string, asOf: string): boolean {
  const next = computeRewrite(abs, generated, asOf);
  if (next === null) return false;
  writeFileSync(abs, next);
  return true;
}

/** Regenerate ledger bodies and the <clientsDir>/_index.md dashboard from frontmatter. */
export function syncFiles(opts: FinanceOptions, asOf = today()): SyncResult {
  const ledgers = loadLedgers(opts);
  const pf = portfolioFromLedgers(ledgers, opts.feeTolerance, asOf);
  const bySlug = new Map(ledgers.map((l) => [l.slug, l]));
  const written: string[] = [];

  for (const c of pf.clients) {
    const ledger = bySlug.get(c.slug);
    if (!ledger) continue;
    const abs = safeResolve(opts.root, ledger.ledgerPath);
    if (!abs) continue;
    if (rewriteBody(abs, renderLedgerTables(c, ledger.payments), asOf)) written.push(ledger.ledgerPath);
  }

  const indexPath = safeResolve(opts.root, join(opts.clientsDir, "_index.md"));
  if (indexPath && existsSync(indexPath) && rewriteBody(indexPath, renderIndexTable(pf), asOf)) {
    written.push(relative(opts.root, indexPath));
  }

  return { files: written };
}

/**
 * Dry-run of syncFiles: the relative paths of ledgers (and _index.md) whose
 * generated block is out of date. Writes nothing. Used by the hygiene check.
 */
export function checkSync(opts: FinanceOptions, asOf = today()): string[] {
  const ledgers = loadLedgers(opts);
  const pf = portfolioFromLedgers(ledgers, opts.feeTolerance, asOf);
  const bySlug = new Map(ledgers.map((l) => [l.slug, l]));
  const stale: string[] = [];

  for (const c of pf.clients) {
    const ledger = bySlug.get(c.slug);
    if (!ledger) continue;
    const abs = safeResolve(opts.root, ledger.ledgerPath);
    if (!abs) continue;
    if (computeRewrite(abs, renderLedgerTables(c, ledger.payments), asOf) !== null) {
      stale.push(ledger.ledgerPath);
    }
  }

  const indexPath = safeResolve(opts.root, join(opts.clientsDir, "_index.md"));
  if (indexPath && existsSync(indexPath) && computeRewrite(indexPath, renderIndexTable(pf), asOf) !== null) {
    stale.push(relative(opts.root, indexPath));
  }

  return stale;
}
