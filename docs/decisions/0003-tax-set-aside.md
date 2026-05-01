# ADR 0003: Tax set-aside formula

**Status:** Accepted
**Date:** 2026-05-01
**Decides:** Phase 0.3 from `docs/LOOPLET_ACCOUNTING_PRODUCT.md`

---

## Decision

**v1: Fixed percentage of net profit, configurable per entity, default 25%.**

```
tax_set_aside_estimate_period =
    net_profit_period
  × tax_set_aside_pct (per entity, default 25%)

Where:
  net_profit_period =
      revenue_inc_gst_period
    - cost_of_goods_sold_inc_gst_period
    - labour_loaded_period
    - overhead_allocated_period
    - gst_owed_to_ato_period          (output GST minus input credits)
```

Displayed on the dashboard as:

> *"YTD net profit: $84,200. Set aside for income tax: $21,050 (25%).
> Confirm with your accountant — this is an estimate, not a calc."*

The `tax_set_aside_pct` lives on `organizations.settings` jsonb,
defaults to 25%, settable by the entity owner.

## Rationale

Three candidates considered:

1. **Last year's effective rate** — accurate, defensible (uses real ATO
   data) but **requires last year's lodged tax return** to bootstrap. New
   customers don't have it inside the product. Bootstrapping problem.
2. **Progressive bracket estimate** — most accurate. Project annual net
   profit, apply ATO marginal rates, divide by months remaining = monthly
   set-aside. But: requires accurate annual projection, which requires
   stable monthly trends, which new customers don't have. Wrong in the
   first year, then drifts.
3. **Fixed percentage default** — what we picked. 25% is the
   conservative-but-not-hysterical figure most AU accountants quote for
   small-business set-aside. Honest about being an estimate. User
   overrides when they know their real number.

## Why 25% as the default

For AU sole traders + small Pty Ltd, marginal rates land roughly here
once super, deductions, and franking are accounted for. It's:

- **Not aggressive** (would underset, surprise the operator at tax time)
- **Not hysterical** (would overset, lock cashflow that could be deployed)
- **Round number** (no "we calculated 27.4%" pseudoscience)
- **Loud about being a default** (UI prompts the user to confirm with
  their accountant within the first 30 days of signup)

## What's NOT included in the v1 estimate

- **PAYG instalments** — separate from end-of-year tax. ATO sets these
  quarterly based on prior-year liability. v1 doesn't try to model PAYG
  instalments; v1.5 does.
- **GST set-aside** — already a separate calc (GST output - GST input =
  what you owe ATO). Listed alongside tax set-aside on the dashboard
  but it's a different number.
- **State payroll tax** — only applies above thresholds. v2.

## v1.5 plan: progressive estimate when data is available

Once an entity has 12+ months of net-profit data inside the product,
the calc switches to:

```
projected_annual_profit = (YTD net profit) × (12 / months elapsed)
estimated_tax = apply_au_brackets(projected_annual_profit, entity_type)
monthly_set_aside = estimated_tax / 12
```

`apply_au_brackets()` is a pure function in code, with the bracket table
as data (per-fiscal-year). Updates yearly when ATO publishes new
brackets.

The switch is automatic: if 12 months of data exists AND the projected
estimate differs from `25%` by >5%, surface a banner: "based on your
actual profit pattern, your set-aside should be ~X% — switch?"

## v2 plan: real-time bracket projection

Continuous projection that updates with every transaction. Surfaces
"if this trend continues, your tax bill in March will be ~$X" with
confidence interval. Requires modelling business seasonality.

## Confidence framing in UI

Critical: never tell the user "this is your tax." Always frame as
estimate. Example UI string:

> Tax set-aside estimate: **$21,050**
> *Based on 25% of YTD net profit ($84,200). This is a defensive
> estimate — your actual liability depends on deductions, super
> contributions, and other factors only your accountant sees. Confirm
> the % with them.*

This framing is non-negotiable. The product's reputation depends on
not surprising users at tax time. Estimate-with-caveats beats
precise-with-error every time.

## Disclaimer

The product is **not tax advice**. Disclaimer in ToS, in onboarding, in
every report. "Looplet provides estimates based on data you enter;
consult a registered tax agent for actual tax advice."

## Out of scope for v1

- Multi-entity tax aggregation (Pty Ltd + trust + sole trader on one
  consolidated set-aside) — v2.
- International / non-AU tax rules — v3.
- Advance tax instalments / quarterly remittance — v1.5 alongside PAYG.

## Verification

Test in Phase 4 acceptance: AFGC's actual prior-year tax bill divided
by prior-year net profit gives an effective rate. The dashboard's
estimate (using 25% default) should be within 5 percentage points.
If not, surface in onboarding: "Your historical rate was 22% — set
your default to that?"

## Status

**Locked.** v1 = fixed %. Auto-switch to progressive estimate is a v1.5
feature, not a v1 hidden behaviour.
