# General Ledger (double-entry) — EPIC G1

This is the foundation for real, GL-derived financial reporting. Until now the
Balance Sheet (`0041`) and per-org P&L (`0047`) were *stitched approximations*
built directly off `invoices` / `bills` / `bank_accounts` / `debts`. They work,
but they mix concerns — most importantly the P&L pulls **GST-inclusive** revenue
from `invoices`, which overstates income and entangles the GST liability with
trading results.

EPIC G1 introduces a proper double-entry ledger so reporting can be derived from
a single source of truth: **posted journal entries**.

## Schema

| Migration | Object | Purpose |
|-----------|--------|---------|
| `0071` | `chart_of_accounts` table + `account_type` enum | Per-org list of accounts. `account_type ∈ {asset, liability, equity, income, expense}`. Self-FK `parent_account_id` for hierarchy. Unique `(organization_id, code)`. |
| `0072` | `journal_entries` + `journal_lines` tables | A `journal_entry` is one balanced transaction; its `journal_lines` debit/credit accounts. Each line touches exactly one side (`journal_lines_one_side` check). `status ∈ {draft, posted, void}`. `source_type`/`source_id` soft-link back to the originating invoice/bill/payment. |
| `0073` | `post_journal_entry(uuid)` fn + `seed_default_chart_of_accounts(uuid)` fn | Posting validates debits = credits and flips `draft → posted`. The seed function populates a default AU trades-business COA per org (idempotent). |
| `0074` | `v_trial_balance` view | Per `(organization_id, account)`: `SUM(debit)`, `SUM(credit)`, and `net = debit − credit` over **posted** entries only. Lines are aggregated per account first, then `LEFT JOIN`ed onto the chart of accounts (no account×entry cartesian). |
| `0075` | GL integrity triggers | Posted entries are immutable (only `posted → void` allowed; no delete; lines frozen once the parent is posted/void). Each `journal_line.account_id` must be in the **same org** as its parent entry. |

## The model

Every financial event becomes a **journal entry** with two or more **lines**
that net to zero (`Σ debits = Σ credits`). Each line debits or credits one
`chart_of_accounts` row. Amounts are non-negative `bigint` cents; a line is
*either* a debit *or* a credit, never both.

An entry is built as `draft` (where it may be temporarily unbalanced), then
**posted** via `post_journal_entry()`, which:

1. asserts the caller can access the entry's org (RLS is re-checked because the
   function is `SECURITY DEFINER`),
2. asserts there is ≥ 1 line and `Σ debits = Σ credits` (else `RAISE`),
3. sets `status = 'posted'`, `posted_at = now()`.

Only **posted** entries count toward `v_trial_balance`. Drafts and voids are
invisible to reporting.

### Sign convention (normal balances)

`v_trial_balance.net_cents = total_debit_cents − total_credit_cents`:

- **asset / expense** accounts are *debit-normal* → `net_cents` is normally **positive**
- **liability / equity / income** accounts are *credit-normal* → `net_cents` is normally **negative**

Reporting layers flip the sign for credit-normal accounts when presenting them
(e.g. income shown as a positive number on the P&L).

### Example: raising a GST-inclusive invoice for $1,100 ($1,000 + $100 GST)

| Account | Debit | Credit |
|---------|------:|-------:|
| `1100` Accounts receivable (asset) | 110000 | |
| `4000` Job revenue (income) | | 100000 |
| `2100` GST payable (liability) | | 10000 |

Revenue is booked **ex-GST** ($1,000). The GST sits in its own liability
account, never in income. This is the fix for the audit finding that the
current P&L mixes GST-inclusive revenue.

## How P&L and Balance Sheet derive from `v_trial_balance`

Both reports are simple roll-ups of the trial balance — no more stitching
across `invoices`/`bills`/`debts`:

**Profit & Loss** = the income and expense accounts:

```text
income  total  = −SUM(net_cents) WHERE account_type = 'income'   -- flip credit-normal sign
expense total  =  SUM(net_cents) WHERE account_type = 'expense'
net profit     = income total − expense total
```

Because revenue is posted ex-GST, the P&L is now GST-clean by construction.

**Balance Sheet** = the asset, liability and equity accounts:

```text
assets       =  SUM(net_cents) WHERE account_type = 'asset'
liabilities  = −SUM(net_cents) WHERE account_type = 'liability'   -- flip credit-normal sign
equity       = −SUM(net_cents) WHERE account_type = 'equity'
-- identity (after period close): assets = liabilities + equity + net profit
```

A later epic will add the `v_profit_and_loss` / `v_balance_sheet_gl` views on
top of `v_trial_balance` and migrate callers off the `0041` / `0047`
approximations. The approximation views remain in place until then so nothing
breaks during the transition.

## Security model

- All tables are RLS-scoped to `get_accessible_org_ids()` (the repo's standard
  org-scoping helper). `journal_lines` inherit scope through their parent
  `journal_entries` row.
- `post_journal_entry` and `seed_default_chart_of_accounts` are
  `SECURITY DEFINER` with `SET search_path = public` (the repo convention used by
  `0043`/`0054`). Their own references are fully schema-qualified, but `public`
  must be on the search path because they call `get_accessible_org_ids()`, which
  is defined in `0001` without its own `search_path` and uses unqualified table
  names — under `search_path = ''` that helper raises, so posting/seeding would
  always fail. Both `REVOKE ALL ... FROM PUBLIC` and `GRANT EXECUTE ... TO
  authenticated`, and both re-check org access explicitly (since DEFINER
  bypasses RLS).
- `v_trial_balance` uses `security_invoker = on`, so underlying-table RLS scopes
  results to the querying user's orgs.
- **Posted entries are immutable** (`0075`). RLS grants UPDATE/DELETE, but BEFORE
  triggers freeze any entry once `status = 'posted'`: the only permitted change is
  the status transition `posted → void` (every other column preserved), posted
  entries cannot be deleted, and their `journal_lines` cannot be inserted,
  updated, or deleted. Mistakes are corrected with a **reversing entry**, never by
  editing history.
- **Same-org line accounts** (`0075`). A `journal_line.account_id` must reference a
  `chart_of_accounts` row in the same org as the line's parent `journal_entry`,
  enforced by a BEFORE INSERT/UPDATE trigger. Without this, a user with access to
  two orgs could point a line at another org's account and leak the amount into
  that org's `v_trial_balance`. `post_journal_entry` re-checks the same-org and
  `is_active` conditions for every line at post time as a second line of defence.
