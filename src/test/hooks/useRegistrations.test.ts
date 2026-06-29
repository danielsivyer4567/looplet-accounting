/**
 * Unit tests for src/hooks/useRegistrations.ts — the pure buildRegistrationPayload mapping
 * (SC-5.O.01). No DOM/mocks: the field mapping from a business_profile fixture to the
 * ABN/GST/PAYG/FBT registration lines is fully testable in isolation.
 */

import { describe, it, expect, vi } from 'vitest';

// useRegistrations.ts imports @/lib/supabase, which throws at module load without env vars.
// We test the pure buildRegistrationPayload (no I/O), so stub the client the same way the
// page/hook tests do (vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'))).
vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

import {
  buildRegistrationPayload,
  GST_THRESHOLD_CENTS,
  type RegistrationProfile,
  type RegistrationType,
} from '@/hooks/useRegistrations';

// A baseline profile: nothing registered, no employees, no turnover.
function baseProfile(overrides: Partial<RegistrationProfile> = {}): RegistrationProfile {
  return {
    entity_type: 'company',
    industry_code: '0123',
    industry_label: 'Construction',
    state_code: 'QLD',
    is_gst_registered: false,
    is_fbt_registered: false,
    is_paygi_registered: false,
    is_paygw_registered: false,
    estimated_annual_turnover_cents: 0,
    employees_count: 0,
    ...overrides,
  };
}

const line = (payload: ReturnType<typeof buildRegistrationPayload>, type: RegistrationType) => {
  const match = payload.lines.find((l) => l.type === type);
  if (!match) throw new Error(`Missing registration line: ${type}`);
  return match;
};

describe('buildRegistrationPayload — header mapping', () => {
  it('maps the entity/industry/state/turnover fields straight through', () => {
    const p = buildRegistrationPayload(
      baseProfile({
        entity_type: 'trust',
        state_code: 'NSW',
        estimated_annual_turnover_cents: 12345,
      }),
    );
    expect(p.entity_type).toBe('trust');
    expect(p.state_code).toBe('NSW');
    expect(p.industry_code).toBe('0123');
    expect(p.industry_label).toBe('Construction');
    expect(p.estimated_annual_turnover_cents).toBe(12345);
  });

  it('always includes all five registration lines (ABN/GST/PAYGW/PAYGI/FBT)', () => {
    const p = buildRegistrationPayload(baseProfile());
    expect(p.lines.map((l) => l.type).sort()).toEqual(['ABN', 'FBT', 'GST', 'PAYGI', 'PAYGW']);
  });
});

describe('buildRegistrationPayload — ABN', () => {
  it('always recommends the ABN as the base registration', () => {
    const abn = line(buildRegistrationPayload(baseProfile()), 'ABN');
    expect(abn.registered).toBe(false);
    expect(abn.recommended).toBe(true);
  });
});

describe('buildRegistrationPayload — GST threshold rule', () => {
  it('recommends GST when turnover meets the $75k threshold and not yet registered', () => {
    const gst = line(
      buildRegistrationPayload(
        baseProfile({ estimated_annual_turnover_cents: GST_THRESHOLD_CENTS }),
      ),
      'GST',
    );
    expect(gst.registered).toBe(false);
    expect(gst.recommended).toBe(true);
    expect(gst.reason).toMatch(/required/i);
  });

  it('does NOT recommend GST below the threshold (optional)', () => {
    const gst = line(
      buildRegistrationPayload(
        baseProfile({ estimated_annual_turnover_cents: GST_THRESHOLD_CENTS - 1 }),
      ),
      'GST',
    );
    expect(gst.recommended).toBe(false);
    expect(gst.reason).toMatch(/optional/i);
  });

  it('does NOT recommend GST when already registered, even above the threshold', () => {
    const gst = line(
      buildRegistrationPayload(
        baseProfile({ is_gst_registered: true, estimated_annual_turnover_cents: 50_000_000 }),
      ),
      'GST',
    );
    expect(gst.registered).toBe(true);
    expect(gst.recommended).toBe(false);
    expect(gst.reason).toMatch(/already registered/i);
  });
});

describe('buildRegistrationPayload — PAYG withholding (employees)', () => {
  it('recommends PAYGW when the business has employees and is not registered', () => {
    const paygw = line(buildRegistrationPayload(baseProfile({ employees_count: 3 })), 'PAYGW');
    expect(paygw.recommended).toBe(true);
    expect(paygw.reason).toMatch(/employees/i);
  });

  it('does NOT recommend PAYGW with no employees', () => {
    const paygw = line(buildRegistrationPayload(baseProfile({ employees_count: 0 })), 'PAYGW');
    expect(paygw.recommended).toBe(false);
  });

  it('does NOT recommend PAYGW when already registered', () => {
    const paygw = line(
      buildRegistrationPayload(baseProfile({ employees_count: 3, is_paygw_registered: true })),
      'PAYGW',
    );
    expect(paygw.registered).toBe(true);
    expect(paygw.recommended).toBe(false);
  });
});

describe('buildRegistrationPayload — PAYGI and FBT are surfaced, not auto-recommended', () => {
  it('never auto-recommends PAYG instalments (ATO-initiated), only reflects the registered state', () => {
    const off = line(buildRegistrationPayload(baseProfile()), 'PAYGI');
    expect(off.registered).toBe(false);
    expect(off.recommended).toBe(false);

    const on = line(buildRegistrationPayload(baseProfile({ is_paygi_registered: true })), 'PAYGI');
    expect(on.registered).toBe(true);
    expect(on.recommended).toBe(false);
  });

  it('never auto-recommends FBT (fringe-benefit provision is not derivable), only reflects state', () => {
    const off = line(buildRegistrationPayload(baseProfile()), 'FBT');
    expect(off.registered).toBe(false);
    expect(off.recommended).toBe(false);

    const on = line(buildRegistrationPayload(baseProfile({ is_fbt_registered: true })), 'FBT');
    expect(on.registered).toBe(true);
    expect(on.recommended).toBe(false);
  });
});

describe('buildRegistrationPayload — null tolerance', () => {
  it('treats null booleans/numbers as not-registered / zero', () => {
    const p = buildRegistrationPayload({
      entity_type: null,
      industry_code: null,
      industry_label: null,
      state_code: null,
      is_gst_registered: null,
      is_fbt_registered: null,
      is_paygi_registered: null,
      is_paygw_registered: null,
      estimated_annual_turnover_cents: null,
      employees_count: null,
    });
    // No registrations flagged, GST optional (turnover treated as 0), PAYGW not required.
    expect(line(p, 'GST').registered).toBe(false);
    expect(line(p, 'GST').recommended).toBe(false);
    expect(line(p, 'PAYGW').recommended).toBe(false);
  });
});
