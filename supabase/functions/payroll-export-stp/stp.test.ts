// Deno unit test for the STP Phase 2 builder + termination event (SC-3.L.02).
// Run: deno test supabase/functions/payroll-export-stp/stp.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildStpEvent,
  cessationTypeCode,
  etpCode,
  stpTransmissionGate,
  type StpOrg,
  type StpRun,
  type StpSlip,
} from "./stp.ts";

const ORG: StpOrg = { id: "org-1", name: "Test Pty Ltd", settings: { abn: "11111111111" } };

function slip(empId: string, name: string): StpSlip {
  return {
    hours_ordinary: 38, hours_overtime: 0, hours_leave: 0,
    gross_ordinary_cents: 200000, gross_overtime_cents: 0, gross_leave_cents: 0, gross_total_cents: 200000,
    payg_tax_cents: 40000, super_guarantee_cents: 23000, super_rate_pct: 11.5, net_pay_cents: 160000,
    ytd_gross_cents: 200000, ytd_tax_cents: 40000, ytd_super_cents: 23000,
    employee: { id: empId, full_name: name, email: null, wage_components: null },
  };
}

function run(metadata: Record<string, unknown> | null): StpRun {
  return {
    organization_id: "org-1",
    period_start: "2026-06-01", period_end: "2026-06-30", pay_date: "2026-06-30",
    total_gross_cents: 200000, total_tax_cents: 40000, total_super_cents: 23000, total_net_cents: 160000,
    metadata,
  };
}

interface PayEvent {
  termination: { employee_id: string; cessation_date: string; cessation_type_code: string } | null;
  employees: {
    employee_id: string;
    etp: { code: string; taxable_cents: number; tax_free_cents: number; tax_withheld_cents: number } | null;
  }[];
}
const payEvent = (stp: Record<string, unknown>) => (stp as { pay_event: PayEvent }).pay_event;

Deno.test("ordinary run: no termination block, no ETP on any employee", () => {
  const stp = buildStpEvent({ run: run(null), org: ORG, slips: [slip("e1", "A")], generatedBy: "t" });
  const pe = payEvent(stp);
  assertEquals(pe.termination, null);
  assertEquals(pe.employees[0].etp, null);
  assertEquals(
    (stp as { transmission_gate: ReturnType<typeof stpTransmissionGate> }).transmission_gate,
    stpTransmissionGate(),
  );
});

Deno.test("STP export is explicitly transmit-gated, not an SBR submission", () => {
  const gate = stpTransmissionGate();
  assertEquals(gate.approval_required, true);
  assertEquals(gate.blocked_action, "stp_sbr_transmit");
  assertEquals(gate.transmit_enabled, false);
  assertEquals(gate.handoff, "registered_tax_or_bas_agent");
  assertEquals(gate.external_wall.includes("ATO/DSP/SBR"), true);
});

Deno.test("genuine redundancy: cessation code R + excluded ETP code R on the terminated employee only", () => {
  const meta = {
    termination: {
      employee_id: "e1",
      cessation_date: "2026-06-30",
      reason: "genuine_redundancy",
      etp: { taxable_cents: 2_483_600, tax_free_cents: 7_516_400, tax_withheld_cents: 794_752 },
    },
  };
  const pe = payEvent(
    buildStpEvent({ run: run(meta), org: ORG, slips: [slip("e1", "A"), slip("e2", "B")], generatedBy: "t" }),
  );
  assertEquals(pe.termination?.employee_id, "e1");
  assertEquals(pe.termination?.cessation_date, "2026-06-30");
  assertEquals(pe.termination?.cessation_type_code, "R");

  const e1 = pe.employees.find((x) => x.employee_id === "e1");
  assertEquals(e1?.etp?.code, "R");
  assertEquals(e1?.etp?.taxable_cents, 2_483_600);
  assertEquals(e1?.etp?.tax_free_cents, 7_516_400);
  assertEquals(e1?.etp?.tax_withheld_cents, 794_752);

  // a non-terminated employee in the same run carries no ETP
  const e2 = pe.employees.find((x) => x.employee_id === "e2");
  assertEquals(e2?.etp, null);
});

Deno.test("resignation: cessation code V + non-excluded ETP code O", () => {
  const meta = {
    termination: {
      employee_id: "e1",
      cessation_date: "2026-06-30",
      reason: "resignation",
      etp: { taxable_cents: 5_000_000, tax_free_cents: 0, tax_withheld_cents: 1_600_000 },
    },
  };
  const pe = payEvent(buildStpEvent({ run: run(meta), org: ORG, slips: [slip("e1", "A")], generatedBy: "t" }));
  assertEquals(pe.termination?.cessation_type_code, "V");
  assertEquals(pe.employees[0].etp?.code, "O");
  assertEquals(pe.employees[0].etp?.taxable_cents, 5_000_000);
});

Deno.test("termination without a pay slip in the run is flagged (ETP not silently dropped)", () => {
  const meta = {
    termination: {
      employee_id: "e-missing",
      cessation_date: "2026-06-30",
      reason: "resignation",
      etp: { taxable_cents: 5_000_000, tax_free_cents: 0, tax_withheld_cents: 1_600_000 },
    },
  };
  const stp = buildStpEvent({
    run: run(meta),
    org: ORG,
    slips: [slip("e1", "A")], // terminated employee e-missing has NO slip
    generatedBy: "t",
  });
  const notes = (stp as { notes: string[] }).notes;
  assertEquals(
    notes.some((n) => n.includes("e-missing") && n.includes("no pay slip")),
    true,
  );
  // No ETP block is emitted for the absent employee (there is no slip to carry it).
  const pe = payEvent(stp);
  assertEquals(pe.employees.every((x) => x.etp === null), true);
});

Deno.test("termination WITH a matching slip emits no orphan-ETP note", () => {
  const meta = {
    termination: {
      employee_id: "e1",
      cessation_date: "2026-06-30",
      reason: "resignation",
      etp: { taxable_cents: 5_000_000, tax_free_cents: 0, tax_withheld_cents: 1_600_000 },
    },
  };
  const stp = buildStpEvent({ run: run(meta), org: ORG, slips: [slip("e1", "A")], generatedBy: "t" });
  const notes = (stp as { notes: string[] }).notes;
  assertEquals(notes.some((n) => n.includes("no pay slip")), false);
});

Deno.test("code mappers", () => {
  assertEquals(cessationTypeCode("invalidity"), "I");
  assertEquals(cessationTypeCode("dismissal"), "F");
  assertEquals(cessationTypeCode("contract_end"), "C");
  assertEquals(cessationTypeCode("something_unknown"), "V"); // default voluntary
  assertEquals(etpCode("early_retirement"), "R"); // excluded
  assertEquals(etpCode("retirement"), "O"); // not excluded
});
