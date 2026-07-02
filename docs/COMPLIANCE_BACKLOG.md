# Remaining Compliance Backlog

**Status:** active external-gated TODO list.

These items are deliberately left pending in `docs/FINISH_LINE_TRACKER.md`. The
repo can prepare artifacts and fail closed, but it must not claim live ATO
electronic lodgement until the external gates are complete.

## ATO Lodgement TODOs

- [ ] `P2-LODGE-2` Digital-signing integration points and secret wiring.
      Requires DSP/EVTE-approved signing material, keystore references such as
      `ATO_M2M_KEYSTORE_REF`, certificate rotation procedures, and staging receipt
      evidence.
- [ ] `P2-LODGE-3` Lodgement status polling and correspondence ingest.
      Requires ATO pre-production endpoints, message IDs, status fixtures,
      correspondence taxonomy, and reconciliation against the local `lodgements` and
      `ato_correspondence` tables.
- [ ] `P2-LODGE-4` Lodgement orchestration, audit, and retry.
      Requires live accreditation approval, operator runbook, retry budget, support
      path, audit export, and proof that failed lodgement states remain fail-closed.

## Release Boundary

Until those items are complete, the product boundary is preparation, approval,
manual export, and local audit evidence. It is not live ATO electronic
transmission.

## Acceptance Evidence Needed Later

- ATO DSP accreditation and EVTE/SBR certification evidence.
- Staging successful signing and transmission receipt.
- Status-polling fixtures for accepted, rejected, pending, and duplicate cases.
- Correspondence ingest proof against real or certified pre-production payloads.
- Security review of signing secrets, audit logs, and operator access.
