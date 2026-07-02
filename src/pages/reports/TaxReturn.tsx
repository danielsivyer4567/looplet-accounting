import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import {
  useTaxReturn,
  type TaxReturn,
  type ReturnLabelSection,
  type ReturnLabelTotal,
  type TaxPayable,
} from '@/hooks/useTaxReturn';
import { useBookToTax, type BookToTax, type CgtCalc } from '@/hooks/useBookToTax';
import { useApprovals } from '@/hooks/useApprovals';
import { CgtEventsPanel } from '@/components/CgtEventsPanel';
import { SkeletonTable } from '@/components/Skeleton';
import { formatMoney } from '@/lib/money';
import {
  ChevronLeft,
  Layers,
  Archive,
  FileText,
  Calculator,
  Scale,
  AlertTriangle,
  Info,
  ShieldCheck,
  CheckCircle2,
  Lock,
  Clock,
  Loader2,
} from 'lucide-react';

/**
 * Tax return draft (SC-4.I.02) + approve-to-finalise gate (SC-4.I.03) — the entity-aware
 * draft annual return for one AU FY, consuming useTaxReturn (build_return +
 * compute_tax_payable) and useBookToTax (book_to_tax + cgt_calc). Shows the return labels
 * mapped from the GL, the book-to-tax reconciliation to taxable income, the offset/credit
 * waterfall to net tax payable, and the CGT schedule (with the capture surface). It is the
 * screen behind the "Tax Summary (Annual)" report card and reads off the same year-end
 * books the EOFY pack bundles.
 *
 * A tax return is a Tier-2 (approve-first) artifact (§3.2): "Approve return" opens a
 * Tier-2 approval (request_approval) bound to the return's key figures; the "Finalise"
 * action stays gated until an admin approves that row (is_action_approved). Finalising
 * locks the draft read-only — it is NOT lodgement, which stays a Phase-7 (SC-7.E/DSP) stub.
 */

const fyLabel = (fy: number) => `FY${fy}-${(fy + 1).toString().slice(2)}`;

/** Most recent AU FY start year (FY starts 1 July). */
function currentFyStartYear(): number {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

const ENTITY_LABELS: Record<string, string> = {
  company: 'Company',
  sole_trader: 'Sole trader',
  partnership: 'Partnership',
  trust: 'Trust',
  smsf: 'SMSF',
  other: 'Other',
};

const entityLabel = (entity: string | undefined): string =>
  entity ? (ENTITY_LABELS[entity] ?? entity) : '—';

/** approvals.resource_type for the annual-return finalise gate (no per-return row exists,
 * so resource_id is the org — the payload hash carries the FY-precise identity). */
const RESOURCE_TYPE = 'tax_return';

export function TaxReturnPage() {
  const { currentOrg } = useOrg();
  const fyStart = currentFyStartYear();
  const [fyStartYear, setFyStartYear] = useState<number>(fyStart);

  // The data hooks guard on currentOrg internally; call them unconditionally (rules of
  // hooks) — every hook must run before the no-org early return below.
  const {
    taxReturn,
    taxPayable,
    loading: returnLoading,
    error: returnError,
  } = useTaxReturn(fyStartYear);
  const { bookToTax, cgt, loading: bookLoading, error: bookError } = useBookToTax(fyStartYear);
  const { pending, requestApproval, isApproved, refresh: refreshApprovals } = useApprovals();

  const entity = taxReturn?.entity_type ?? taxPayable?.entity_type ?? bookToTax?.entity_type;
  const taxableIncome = bookToTax?.taxable_income_cents ?? taxPayable?.taxable_income_cents ?? null;

  // ---- approve-to-finalise gate (SC-4.I.03) ----------------------------------------
  // The Tier-2 payload pins the return's identity + headline figures, so editing the
  // return (e.g. a CGT event) after approval changes the hash and re-gates finalisation.
  const orgId = currentOrg?.id ?? null;
  // Memoised so its identity is stable across renders — the gate effect below depends on
  // it directly (no JSON round-trip) and only re-checks when the figures actually change.
  const approvalPayload = useMemo<Record<string, unknown>>(
    () => ({
      kind: 'tax_return_finalise',
      fy_start_year: fyStartYear,
      entity_type: entity ?? null,
      taxable_income_cents: taxableIncome,
      net_tax_payable_cents: taxPayable?.net_tax_payable_cents ?? null,
      net_refund_cents: taxPayable?.net_refund_cents ?? null,
    }),
    [fyStartYear, entity, taxableIncome, taxPayable],
  );
  const canApprove = taxReturn != null || taxPayable != null;
  // Coarse "a request is open" hint (resource is org-scoped; the hash is the FY identity).
  const pendingForReturn = pending.some(
    (a) => a.resource_type === RESOURCE_TYPE && a.resource_id === orgId,
  );

  const [approved, setApproved] = useState(false);
  const [finalised, setFinalised] = useState(false);
  const [busy, setBusy] = useState<null | 'approve' | 'refresh'>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Re-check the Tier-2 guard whenever the figures or the pending queue change — an admin
  // approval lands out-of-band, so it surfaces on the next load / "Check status" refresh.
  useEffect(() => {
    let live = true;
    if (!orgId || !canApprove) {
      setApproved(false);
      return;
    }
    isApproved(RESOURCE_TYPE, orgId, approvalPayload)
      .then((ok) => live && setApproved(ok))
      .catch(() => live && setApproved(false));
    return () => {
      live = false;
    };
    // pendingForReturn re-triggers the check when a pending request resolves out-of-band
    // (the row drops from the queue on admin approval) — cheaper than watching the array.
  }, [orgId, approvalPayload, pendingForReturn, canApprove, isApproved]);

  // Switching FY views a different return — clear the per-FY finalised lock.
  useEffect(() => setFinalised(false), [fyStartYear]);

  if (!currentOrg) return null;

  const fyOptions = [0, 1, 2, 3, 4].map((i) => fyStart - i);
  const loading = returnLoading || bookLoading;
  const errors = [returnError, bookError].filter((e): e is string => !!e);
  const caveats = Array.from(
    new Set([
      ...(bookToTax?.caveats ?? []),
      ...(taxPayable?.caveats ?? []),
      ...(cgt?.sbe_concession_caveats ?? []),
    ]),
  );

  const handleApprove = async () => {
    if (!orgId) return;
    setBusy('approve');
    setActionError(null);
    try {
      await requestApproval(RESOURCE_TYPE, orgId, approvalPayload);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleRefreshStatus = async () => {
    setBusy('refresh');
    setActionError(null);
    try {
      await refreshApprovals();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleFinalise = () => {
    if (approved) setFinalised(true);
  };

  return (
    <section className="animated-fade-in">
      <Link
        to="/reports"
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.825rem',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
          marginBottom: '1rem',
        }}
      >
        <ChevronLeft size={14} />
        <span>Reports</span>
      </Link>

      <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Layers size={24} style={{ color: 'var(--accent-primary)' }} />
        Tax Return (Draft)
      </h1>
      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.875rem',
          marginTop: '0.25rem',
          marginBottom: '1.5rem',
          maxWidth: '820px',
          lineHeight: '1.5',
        }}
      >
        The entity-aware draft return for the selected financial year: GL accounts mapped to
        tax-return labels, the book-to-tax reconciliation to taxable income, the offsets and credits
        waterfall to net tax, and the capital-gains schedule. Built from the same year-end books the{' '}
        <Link
          to="/reports/eofy"
          style={{ color: 'var(--accent-primary)', textDecoration: 'underline', fontWeight: 600 }}
        >
          EOFY pack
        </Link>{' '}
        bundles. Draft only — lodgement and approval are separate steps.
      </p>

      {/* FY selector */}
      <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label
              htmlFor="taxreturn-fy"
              style={{
                display: 'block',
                fontSize: '0.7rem',
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                marginBottom: '0.35rem',
              }}
            >
              Financial year
            </label>
            <select
              id="taxreturn-fy"
              className="form-select"
              value={fyStartYear}
              onChange={(e) => setFyStartYear(Number(e.target.value))}
              disabled={loading}
              style={{ minWidth: '160px' }}
            >
              {fyOptions.map((fy) => (
                <option key={fy} value={fy}>
                  {fyLabel(fy)}
                </option>
              ))}
            </select>
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>
            Entity: <strong style={{ color: 'var(--text-title)' }}>{entityLabel(entity)}</strong>
          </div>
        </div>
      </div>

      {/* Approve-to-finalise gate (SC-4.I.03) */}
      <FinalisationCard
        finalised={finalised}
        approved={approved}
        pending={pendingForReturn}
        canApprove={canApprove}
        busy={busy}
        actionError={actionError}
        onApprove={handleApprove}
        onFinalise={handleFinalise}
        onRefreshStatus={handleRefreshStatus}
      />

      {/* RPC error banner (partial — book_to_tax / build_return can fail independently). */}
      {!loading && errors.length > 0 && (
        <Banner tone="warning" icon={AlertTriangle}>
          <strong>Some figures are unavailable.</strong> {errors.join(' · ')} — apply the Phase-4
          tax migrations (0138–0150) to enable the full draft return.
        </Banner>
      )}

      {/* Headline KPIs */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
          marginBottom: '2rem',
        }}
      >
        <Kpi
          label="Taxable income"
          value={taxableIncome == null ? '—' : formatMoney(taxableIncome)}
          icon={Scale}
          type="neutral"
        />
        <NetTaxKpi taxPayable={taxPayable} loading={loading} />
        <Kpi
          label="Net capital gain"
          value={cgt == null ? '—' : formatMoney(cgt.net_capital_gain_cents)}
          icon={Calculator}
          type={cgt && cgt.net_capital_gain_cents > 0 ? 'warning' : 'neutral'}
          sub={cgt ? `${cgt.event_count} CGT event${cgt.event_count === 1 ? '' : 's'}` : undefined}
        />
      </div>

      {loading ? (
        <div aria-busy="true" aria-label="Loading tax return draft">
          <SkeletonTable rows={5} cols={4} />
        </div>
      ) : (
        <>
          {/* Return labels (entity-aware) */}
          {taxReturn ? (
            <Card title="Return labels" subtitle={taxReturn.return_form} icon={FileText}>
              <ReturnLabels taxReturn={taxReturn} />
            </Card>
          ) : (
            <Card title="Return labels" icon={FileText}>
              <Empty>
                No mapped return for this entity / year. build_return does not map SMSF or
                profile-less entities — record the entity type and book activity first.
              </Empty>
            </Card>
          )}

          {/* Book-to-tax reconciliation */}
          {bookToTax && (
            <Card title="Book-to-tax reconciliation" icon={Calculator}>
              <BookToTaxRecon bookToTax={bookToTax} />
            </Card>
          )}

          {/* Tax payable waterfall */}
          {taxPayable && (
            <Card title="Tax payable" subtitle={taxPayable.rate_basis.note} icon={Scale}>
              <TaxPayableWaterfall taxPayable={taxPayable} />
            </Card>
          )}

          {/* CGT schedule + capture surface (locked once finalised — read-only return) */}
          <Card title="Capital gains (CGT)" icon={Layers}>
            {cgt && <CgtSummary cgt={cgt} />}
            {finalised ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.875rem 1rem',
                  background: 'var(--bg-hover)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-muted)',
                  fontSize: '0.825rem',
                }}
              >
                <Lock size={15} />
                <span>CGT events are locked — this return is finalised.</span>
              </div>
            ) : (
              <CgtEventsPanel />
            )}
          </Card>

          {/* Caveats */}
          {caveats.length > 0 && (
            <Card title="Caveats & assumptions" icon={Info}>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: '1.1rem',
                  color: 'var(--text-muted)',
                  fontSize: '0.825rem',
                  lineHeight: '1.6',
                }}
              >
                {caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      {/* EOFY tie-in footer */}
      <div
        className="card"
        style={{
          marginTop: '0.5rem',
          background: 'var(--bg-hover)',
          border: '1px dashed var(--border-subtle)',
          padding: '1.25rem',
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'flex-start',
        }}
      >
        <Archive
          size={16}
          style={{ flexShrink: 0, color: 'var(--accent-primary)', marginTop: '2px' }}
        />
        <div style={{ fontSize: '0.825rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
          <span
            style={{
              fontWeight: 600,
              color: 'var(--text-title)',
              display: 'block',
              marginBottom: '0.25rem',
            }}
          >
            Part of the {fyLabel(fyStartYear)} annual cycle
          </span>
          This draft reads the finalised year-end books. Generate the{' '}
          <Link
            to="/reports/eofy"
            style={{ color: 'inherit', textDecoration: 'underline', fontWeight: 600 }}
          >
            EOFY pack
          </Link>{' '}
          to true-up and lock the periods first, then approve and lodge the return (Phase 7).
        </div>
      </div>
    </section>
  );
}

// ---- entity-aware return labels ----------------------------------------------------

// build_return emits a closed discriminated union over entity_type; the switch lets
// the compiler narrow each branch without casts and forces a build break (the
// `never` default) if a fifth entity form is ever added without a render branch.
function ReturnLabels({ taxReturn }: { taxReturn: TaxReturn }) {
  switch (taxReturn.entity_type) {
    case 'company': {
      const item = taxReturn.item6_total_profit_or_loss;
      return (
        <>
          <LabelSection title="Item 6 income" section={item.income} />
          <LabelSection title="Item 6 expenses" section={item.expenses} />
          <TotalRow total={item.total_profit_or_loss} strong />
        </>
      );
    }
    case 'sole_trader': {
      const item = taxReturn.p8_business_income_and_expenses;
      return (
        <>
          <LabelSection title="Item P8 income" section={item.income} />
          <LabelSection title="Item P8 expenses" section={item.expenses} />
          <TotalRow total={item.net_income_or_loss_from_business} strong />
          <TotalRow
            total={taxReturn.item15_net_income_or_loss_from_business}
            note={`from ${taxReturn.item15_net_income_or_loss_from_business.source_label}`}
          />
        </>
      );
    }
    case 'partnership':
    case 'trust': {
      const item = taxReturn.item5_business_income_and_expenses;
      const dist = taxReturn.distribution_statement;
      return (
        <>
          <LabelSection title="Item 5 income" section={item.income} />
          <LabelSection title="Item 5 expenses" section={item.expenses} />
          <TotalRow total={item.net_income_or_loss_from_business} strong />
          {taxReturn.item26_trust_net_income && (
            <TotalRow
              total={taxReturn.item26_trust_net_income}
              note={`s95 basis: ${taxReturn.item26_trust_net_income.basis}`}
            />
          )}
          <div
            style={{
              marginTop: '1rem',
              padding: '0.875rem 1rem',
              background: 'var(--bg-hover)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.825rem',
              color: 'var(--text-muted)',
              lineHeight: '1.5',
            }}
          >
            <strong style={{ color: 'var(--text-title)' }}>{dist.label_name}:</strong>{' '}
            {formatMoney(dist.distributable_net_cents)} distributable ({dist.share_labels}).{' '}
            {dist.note}
          </div>
        </>
      );
    }
    default:
      return assertNever(taxReturn);
  }
}

/** Compile-time exhaustiveness guard for the entity_type switch above. */
function assertNever(value: never): never {
  throw new Error(`Unhandled tax-return entity: ${JSON.stringify(value)}`);
}

function LabelSection({ title, section }: { title: string; section: ReturnLabelSection }) {
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <h4
        style={{
          margin: '0 0 0.5rem',
          fontSize: '0.75rem',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'var(--text-muted)',
        }}
      >
        {title}
      </h4>
      {section.lines.length === 0 ? (
        <p style={{ margin: '0 0 0.5rem', color: 'var(--text-muted)', fontSize: '0.825rem' }}>
          No mapped accounts.
        </p>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <tbody>
              {section.lines.map((l) => (
                <tr key={`${l.account_code}-${l.label_code ?? l.label_name}`}>
                  <td>
                    {l.label_code && (
                      <code style={{ fontSize: '0.7rem', marginRight: '0.4rem' }}>
                        {l.label_code}
                      </code>
                    )}
                    {l.account_name}
                    <span
                      style={{
                        color: 'var(--text-muted)',
                        fontSize: '0.75rem',
                        marginLeft: '0.4rem',
                      }}
                    >
                      {l.account_code}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(l.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TotalRow total={section.total} />
    </div>
  );
}

function TotalRow({
  total,
  strong,
  note,
}: {
  total: ReturnLabelTotal;
  strong?: boolean;
  note?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: '1rem',
        padding: '0.5rem 0.25rem',
        borderTop: strong ? '2px solid var(--border-subtle)' : '1px dashed var(--border-subtle)',
        fontWeight: strong ? 800 : 600,
      }}
    >
      <span style={{ color: 'var(--text-title)' }}>
        {total.label_code && (
          <code style={{ fontSize: '0.7rem', marginRight: '0.4rem' }}>{total.label_code}</code>
        )}
        {total.label_name}
        {note && (
          <span
            style={{
              color: 'var(--text-muted)',
              fontWeight: 400,
              fontSize: '0.75rem',
              marginLeft: '0.4rem',
            }}
          >
            {note}
          </span>
        )}
      </span>
      <span style={{ color: 'var(--text-title)', fontFamily: 'var(--font-title)' }}>
        {formatMoney(total.amount_cents)}
      </span>
    </div>
  );
}

// ---- book-to-tax reconciliation ----------------------------------------------------

function BookToTaxRecon({ bookToTax: b }: { bookToTax: BookToTax }) {
  return (
    <div>
      <ReconRow label="Accounting profit" value={b.accounting_profit_cents} />
      {b.add_backs.lines.map((l) => (
        <ReconRow
          key={`${l.account_code}-${l.reason}`}
          label={`Add back: ${l.account_name}`}
          hint={l.reason}
          value={l.amount_cents}
          indent
          sign="+"
        />
      ))}
      <ReconRow label="Non-deductible add-backs" value={b.add_backs.total_cents} sign="+" subtle />
      <ReconRow
        label="Depreciation difference (book − tax)"
        hint={`book ${formatMoney(b.depreciation_reconciliation.book_depreciation_cents)} · tax ${formatMoney(
          b.depreciation_reconciliation.tax_depreciation_cents,
        )}`}
        value={b.depreciation_reconciliation.difference_cents}
        sign="±"
      />
      <ReconRow label="= Taxable income subtotal" value={b.taxable_income_subtotal_cents} strong />
      <ReconRow
        label="Net capital gain"
        hint={b.capital_gains.source}
        value={b.capital_gains.net_capital_gain_cents}
        sign="+"
      />
      <ReconRow
        label="Franking gross-up"
        hint={
          b.franking.grossed_up_into_assessable_income
            ? 'grossed up into assessable income'
            : b.franking.note
        }
        value={b.franking.credits_received_cents}
        sign="+"
      />
      <ReconRow
        label="= Assessable income before losses"
        value={b.assessable_income_before_losses_cents}
        strong
      />
      <ReconRow
        label="Carried-forward revenue losses applied"
        hint={`${formatMoney(b.revenue_losses.available_cents)} available · ${formatMoney(
          b.revenue_losses.carried_forward_cents,
        )} carried forward`}
        value={b.revenue_losses.applied_cents}
        sign="−"
      />
      <ReconRow label="= Taxable income" value={b.taxable_income_cents} strong highlight />
    </div>
  );
}

function ReconRow({
  label,
  hint,
  value,
  sign,
  strong,
  subtle,
  indent,
  highlight,
}: {
  label: string;
  hint?: string;
  value: number;
  sign?: '+' | '−' | '±';
  strong?: boolean;
  subtle?: boolean;
  indent?: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: '1rem',
        padding: '0.45rem 0.5rem',
        paddingLeft: indent ? '1.5rem' : '0.5rem',
        borderTop: strong ? '2px solid var(--border-subtle)' : '1px dashed var(--border-subtle)',
        background: highlight ? 'var(--bg-hover)' : 'transparent',
        borderRadius: highlight ? 'var(--radius-sm)' : 0,
        fontWeight: strong ? 800 : subtle ? 600 : 400,
        color: subtle || indent ? 'var(--text-muted)' : 'var(--text-title)',
      }}
    >
      <span>
        {label}
        {hint && (
          <span
            style={{
              color: 'var(--text-muted)',
              fontWeight: 400,
              fontSize: '0.75rem',
              marginLeft: '0.4rem',
            }}
          >
            {hint}
          </span>
        )}
      </span>
      <span style={{ whiteSpace: 'nowrap', fontFamily: 'var(--font-title)' }}>
        {sign && value !== 0 && (
          <span style={{ color: 'var(--text-muted)', marginRight: '0.25rem' }}>{sign}</span>
        )}
        {formatMoney(value)}
      </span>
    </div>
  );
}

// ---- tax payable waterfall ---------------------------------------------------------

function TaxPayableWaterfall({ taxPayable: t }: { taxPayable: TaxPayable }) {
  const nonRef = t.offsets.non_refundable;
  const ref = t.offsets.refundable;
  return (
    <div>
      <ReconRow label="Taxable income" value={t.taxable_income_cents} />
      <ReconRow
        label="Income tax"
        hint={
          t.rate_basis.rate != null
            ? `${(t.rate_basis.rate * 100).toFixed(t.rate_basis.rate < 0.1 ? 1 : 0)}% ${t.rate_basis.kind}`
            : t.rate_basis.kind
        }
        value={t.income_tax_cents}
      />
      {t.medicare_levy_cents > 0 && (
        <ReconRow label="Medicare levy" value={t.medicare_levy_cents} sign="+" />
      )}
      {nonRef.total_cents > 0 && (
        <ReconRow
          label="Non-refundable offsets"
          hint={`SBITO ${formatMoney(nonRef.sbito_cents)} · franking ${formatMoney(nonRef.company_franking_cents)}`}
          value={nonRef.total_cents}
          sign="−"
        />
      )}
      <ReconRow
        label="= Tax after non-refundable offsets"
        value={t.tax_after_non_refundable_offsets_cents}
        strong
      />
      <ReconRow label="Total liability (incl. levy)" value={t.total_liability_cents} />
      {ref.total_cents > 0 && (
        <ReconRow
          label="Refundable credits"
          hint={`franking ${formatMoney(ref.franking_cents)} · PAYG instalments ${formatMoney(
            ref.payg_instalments_paid_cents,
          )}`}
          value={ref.total_cents}
          sign="−"
        />
      )}
      <ReconRow
        label={
          t.result === 'refundable'
            ? '= Net refund'
            : t.result === 'payable'
              ? '= Net tax payable'
              : '= Net (nil)'
        }
        value={t.result === 'refundable' ? t.net_refund_cents : t.net_tax_payable_cents}
        strong
        highlight
      />
    </div>
  );
}

// ---- CGT summary -------------------------------------------------------------------

function CgtSummary({ cgt }: { cgt: CgtCalc }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '0.75rem',
        marginBottom: '1.5rem',
      }}
    >
      <MiniStat
        label="Current-year gains"
        value={formatMoney(cgt.current_year_capital_gains_cents)}
      />
      <MiniStat
        label="Current-year losses"
        value={formatMoney(cgt.current_year_capital_losses_cents)}
      />
      <MiniStat
        label="CGT discount"
        value={formatMoney(cgt.cgt_discount_cents)}
        sub={`${(cgt.cgt_discount_rate * 100).toFixed(cgt.cgt_discount_rate < 0.4 ? 1 : 0)}%`}
      />
      <MiniStat label="Net capital gain" value={formatMoney(cgt.net_capital_gain_cents)} strong />
    </div>
  );
}

// ---- presentational primitives -----------------------------------------------------

function Card({
  title,
  subtitle,
  icon: Icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: typeof FileText;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          marginBottom: subtitle ? '0.25rem' : '1rem',
        }}
      >
        <Icon size={18} style={{ color: 'var(--accent-primary)' }} />
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{title}</h2>
      </div>
      {subtitle && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '0 0 1rem' }}>
          {subtitle}
        </p>
      )}
      {children}
    </div>
  );
}

function Kpi({
  label,
  value,
  icon: Icon,
  type,
  sub,
}: {
  label: string;
  value: string;
  icon: typeof FileText;
  type: 'success' | 'danger' | 'warning' | 'neutral';
  sub?: string | undefined;
}) {
  const accent = `var(--accent-${type === 'neutral' ? 'primary' : type})`;
  return (
    <div
      className="card"
      style={{ padding: '1.25rem', borderLeft: `4px solid ${accent}`, position: 'relative' }}
    >
      <div
        style={{
          fontSize: '0.675rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 700,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: '0.35rem',
          fontSize: '1.5rem',
          color: 'var(--text-title)',
          fontWeight: 800,
          fontFamily: 'var(--font-title)',
        }}
      >
        {value}
      </div>
      <div
        style={{
          marginTop: '0.25rem',
          fontSize: '0.725rem',
          color: 'var(--text-muted)',
          minHeight: '0.9rem',
        }}
      >
        {sub ?? ''}
      </div>
      <div
        style={{ position: 'absolute', right: '1rem', bottom: '1rem', color: accent, opacity: 0.7 }}
      >
        <Icon size={18} />
      </div>
    </div>
  );
}

function NetTaxKpi({ taxPayable, loading }: { taxPayable: TaxPayable | null; loading: boolean }) {
  if (!taxPayable) {
    return <Kpi label="Net tax" value={loading ? '…' : '—'} icon={Scale} type="neutral" />;
  }
  if (taxPayable.result === 'refundable') {
    return (
      <Kpi
        label="Net tax"
        value={formatMoney(taxPayable.net_refund_cents)}
        icon={Scale}
        type="success"
        sub="refundable"
      />
    );
  }
  if (taxPayable.result === 'payable') {
    return (
      <Kpi
        label="Net tax"
        value={formatMoney(taxPayable.net_tax_payable_cents)}
        icon={Scale}
        type="danger"
        sub="payable to ATO"
      />
    );
  }
  return <Kpi label="Net tax" value={formatMoney(0)} icon={Scale} type="neutral" sub="nil" />;
}

function MiniStat({
  label,
  value,
  sub,
  strong,
}: {
  label: string;
  value: string;
  sub?: string;
  strong?: boolean;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-hover)',
        borderRadius: 'var(--radius-sm)',
        padding: '0.75rem',
      }}
    >
      <div
        style={{
          fontSize: '0.7rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: strong ? '1.25rem' : '1rem',
          fontWeight: strong ? 800 : 600,
          color: 'var(--text-title)',
          marginTop: '0.2rem',
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '2rem 1.5rem',
        border: '1px dashed var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        textAlign: 'center',
        color: 'var(--text-muted)',
        fontSize: '0.85rem',
        lineHeight: '1.5',
      }}
    >
      {children}
    </div>
  );
}

function Banner({
  tone,
  icon: Icon,
  children,
}: {
  tone: 'warning' | 'danger';
  icon: typeof AlertTriangle;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`badge badge-${tone}`}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.5rem',
        padding: '0.875rem 1rem',
        marginBottom: '1.5rem',
        textTransform: 'none',
        fontSize: '0.875rem',
        lineHeight: '1.4',
        width: '100%',
        justifyContent: 'flex-start',
      }}
    >
      <Icon size={16} style={{ marginTop: '2px', flexShrink: 0 }} />
      <span>{children}</span>
    </div>
  );
}

// ---- approve-to-finalise gate card (SC-4.I.03) -------------------------------------
//
// A tax return is a Tier-2 (approve-first) artifact (§3.2). "Approve return" opens the
// Tier-2 approval; "Finalise return" stays DISABLED until an admin has approved that
// request (approved===true via is_action_approved). Finalising locks the draft read-only
// — it is NOT lodgement (that stays the Phase-7 SC-7.E/DSP stub).
function FinalisationCard({
  finalised,
  approved,
  pending,
  canApprove,
  busy,
  actionError,
  onApprove,
  onFinalise,
  onRefreshStatus,
}: {
  finalised: boolean;
  approved: boolean;
  pending: boolean;
  canApprove: boolean;
  busy: null | 'approve' | 'refresh';
  actionError: string | null;
  onApprove: () => void;
  onFinalise: () => void;
  onRefreshStatus: () => void;
}) {
  const status = finalised
    ? 'Finalised'
    : approved
      ? 'Approved'
      : pending
        ? 'Pending approval'
        : 'Draft';
  const badge =
    finalised || approved ? 'badge-success' : pending ? 'badge-warning' : 'badge-neutral';

  return (
    <div className="card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <ShieldCheck size={18} style={{ color: 'var(--accent-primary)' }} />
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Finalisation</h2>
        </div>
        <span className={`badge ${badge}`} style={{ textTransform: 'none' }}>
          {status}
        </span>
      </div>
      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.8rem',
          margin: '0.5rem 0 1rem',
          lineHeight: '1.5',
        }}
      >
        A tax return is a Tier-2 approve-first artifact. Approve it to open a Tier-2 sign-off, then
        finalise once an admin approves — finalising locks the draft. Lodgement to the ATO is a
        separate, later step.
      </p>

      {finalised ? (
        <div
          className="badge badge-success"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.75rem 1rem',
            textTransform: 'none',
            fontSize: '0.85rem',
            width: '100%',
            justifyContent: 'flex-start',
          }}
        >
          <Lock size={15} />
          <span>This return is finalised and read-only.</span>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {!approved && (
            <button
              className="btn btn-secondary"
              onClick={onApprove}
              disabled={pending || !canApprove || busy !== null}
              title={
                !canApprove
                  ? 'Load the return figures before approving'
                  : pending
                    ? 'A Tier-2 approval is already open'
                    : 'Open a Tier-2 approval for this return'
              }
            >
              {busy === 'approve' ? <Loader2 size={14} /> : <ShieldCheck size={14} />}
              <span>{pending ? 'Approval requested' : 'Approve return'}</span>
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={onFinalise}
            disabled={!approved || busy !== null}
            title={approved ? 'Lock this draft as finalised' : 'Approve the return first'}
          >
            <Lock size={14} />
            <span>Finalise return</span>
          </button>
          {pending && !approved && (
            <button className="btn btn-ghost" onClick={onRefreshStatus} disabled={busy !== null}>
              {busy === 'refresh' ? <Loader2 size={14} /> : <Clock size={14} />}
              <span>Check status</span>
            </button>
          )}
        </div>
      )}

      {pending && !approved && !finalised && (
        <p
          style={{
            color: 'var(--text-muted)',
            fontSize: '0.8rem',
            marginTop: '0.75rem',
            marginBottom: 0,
          }}
        >
          Awaiting sign-off — an admin can approve it in the{' '}
          <Link
            to="/approvals"
            style={{ color: 'var(--accent-primary)', textDecoration: 'underline', fontWeight: 600 }}
          >
            Approvals queue
          </Link>
          .
        </p>
      )}
      {approved && !finalised && (
        <p
          style={{
            color: 'var(--text-success)',
            fontSize: '0.8rem',
            marginTop: '0.75rem',
            marginBottom: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
          }}
        >
          <CheckCircle2 size={14} /> Approved — ready to finalise.
        </p>
      )}
      {actionError && (
        <p
          style={{
            color: 'var(--text-danger)',
            fontSize: '0.8rem',
            marginTop: '0.75rem',
            marginBottom: 0,
          }}
        >
          {actionError}
        </p>
      )}
    </div>
  );
}
