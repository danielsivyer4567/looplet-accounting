// Lodge readiness checklist (SC-DEPLOY-01..04)
//
// A deliberately loud, red checklist of what is *actually required* before any
// electronic lodgement to the ATO/ASIC can succeed. None of these can be faked
// locally — they are external accreditation, credential, and hosting steps.
//
// Each item is a real TODO sourced from the backend lodge gate
// (`lodgeOperationsHealth` -> EVTE + DSP + SBR). Items render RED while unmet
// and flip green only when their underlying secrets/assets are provisioned and
// the deployed gate reports `all_green`. The default state is all-unmet, which
// is the honest current reality: lodgement is blocked.

import { AlertTriangle, Circle, CheckCircle2 } from 'lucide-react';

export interface LodgeRequirement {
  /** Stable id, also the ledger slice it maps to. */
  id: string;
  /** Slice tag shown as a chip, e.g. "SC-DEPLOY-02". */
  slice: string;
  /** Short human title of the requirement. */
  title: string;
  /** What actually has to happen, in plain language. */
  detail: string;
  /** Who must do it — almost always an external party. */
  owner: string;
  /** Concrete blockers: secret names / assets that must be present. */
  blocks: string[];
  /** True once provisioned + verified against the deployed gate. */
  done: boolean;
}

// The canonical, honest list. `done: false` everywhere because the production
// ATO/DSP/SBR readiness is deploy-gated and none of it is provisioned yet.
// Flip an item's `done` to true ONLY when the deployed gate proves it green.
export const LODGE_REQUIREMENTS: readonly LodgeRequirement[] = [
  {
    id: 'dsp',
    slice: 'SC-DEPLOY-02',
    title: 'ATO DSP accreditation + machine credentials',
    detail:
      'Onboard as a registered Digital Service Provider with the ATO and pass their security/operational review, then load the issued machine-to-machine credentials as Edge Function secrets. These are issued by the ATO — they cannot be generated locally.',
    owner: 'ATO DSP onboarding (external) → platform secrets',
    blocks: ['ATO_DSP_ABN', 'ATO_SOFTWARE_ID', 'ATO_STIN', 'ATO_M2M_KEYSTORE_REF'],
    done: false,
  },
  {
    id: 'evte',
    slice: 'SC-DEPLOY-02',
    title: 'EVTE certification → production endpoint access',
    detail:
      'Run the full draft → lodge → receipt cycle against the ATO External Vendor Test Environment (sandbox). The ATO grants production endpoint access only after EVTE certification passes. Then set the endpoint and confirm Supabase edge egress is allowlisted.',
    owner: 'ATO (grants prod after EVTE pass)',
    blocks: ['ATO_EVTE_ENDPOINT', 'production endpoint egress allowlist'],
    done: false,
  },
  {
    id: 'sbr',
    slice: 'SC-DEPLOY-03',
    title: 'SBR taxonomy hosted + version-pinned',
    detail:
      'Pin an SBR taxonomy release (e.g. SBR AU 2024.1) and host the ~200MB XBRL asset set on CDN/Storage so Edge Functions can load it at cold-start in under 2s. The bundled local subset cannot validate real production filings.',
    owner: 'Platform / infra',
    blocks: ['SBR_TAXONOMY_VERSION', 'SBR_TAXONOMY_BASE_URL'],
    done: false,
  },
  {
    id: 'smoke',
    slice: 'SC-DEPLOY-01',
    title: 'Real post-deploy smoke verification',
    detail:
      'After deploy, run the real HTTP smoke tests against the deployed Edge Functions and inspect actual cron execution records. This replaces the earlier mock script that fabricated its own 200 responses and proved nothing.',
    owner: 'Platform (after deploy)',
    blocks: ['prod deploy access', 'scripts/deploy-smoke-tests.py (real HTTP run)'],
    done: false,
  },
  {
    id: 'gate',
    slice: 'SC-DEPLOY-04',
    title: 'Lodge gate reports all-green',
    detail:
      'Only when DSP, EVTE and SBR are all configured does the backend lodgeOperationsHealth report all_green = true and lodge actions stop returning FORBIDDEN. Until then the fail-closed gate correctly blocks every lodge attempt.',
    owner: 'Automatic — flips once the three above are green',
    blocks: ['depends on DSP + EVTE + SBR above'],
    done: false,
  },
] as const;

const DANGER = 'var(--accent-danger)';
const SUCCESS = 'var(--accent-success)';
const MUTED = 'var(--text-muted)';

export function LodgeReadinessChecklist({
  requirements = LODGE_REQUIREMENTS,
}: {
  requirements?: readonly LodgeRequirement[];
}) {
  const outstanding = requirements.filter((r) => !r.done);
  const allGreen = outstanding.length === 0;

  return (
    <section
      aria-label="Lodgement readiness requirements"
      className="card"
      style={{
        padding: '1rem 1.15rem',
        marginBottom: '1rem',
        borderLeft: `4px solid ${allGreen ? SUCCESS : DANGER}`,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <AlertTriangle size={18} style={{ color: allGreen ? SUCCESS : DANGER }} />
        <h2 style={{ margin: 0, fontSize: '1rem', color: allGreen ? SUCCESS : DANGER }}>
          {allGreen
            ? 'Lodgement ready — all external prerequisites provisioned'
            : `Lodgement blocked — ${outstanding.length} external prerequisite${
                outstanding.length === 1 ? '' : 's'
              } not yet provisioned`}
        </h2>
      </header>

      {!allGreen && (
        <p style={{ color: MUTED, fontSize: '0.85rem', margin: '0.4rem 0 0.85rem' }}>
          Electronic lodgement to the ATO/ASIC cannot succeed until every item below is real. None
          of these can be completed in this workspace — they require external accreditation,
          ATO-issued credentials, or asset hosting. The fail-closed gate blocks all lodge attempts
          until then.
        </p>
      )}

      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.65rem' }}>
        {requirements.map((req) => {
          const color = req.done ? SUCCESS : DANGER;
          const Icon = req.done ? CheckCircle2 : Circle;
          return (
            <li
              key={req.id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: '0.6rem',
                padding: '0.6rem 0.7rem',
                border: `1px solid ${req.done ? 'var(--border-subtle)' : DANGER}`,
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-card)',
              }}
            >
              <Icon size={18} style={{ color, marginTop: '0.15rem' }} aria-hidden />
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    flexWrap: 'wrap',
                  }}
                >
                  <span
                    style={{
                      color,
                      fontWeight: 700,
                      fontSize: '0.92rem',
                    }}
                  >
                    {req.done ? '✔' : 'TODO'} — {req.title}
                  </span>
                  <span
                    className="badge"
                    style={{
                      fontSize: '0.65rem',
                      color: MUTED,
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    {req.slice}
                  </span>
                </div>
                <p
                  style={{
                    margin: '0.25rem 0 0.4rem',
                    fontSize: '0.82rem',
                    color: 'var(--text-body)',
                  }}
                >
                  {req.detail}
                </p>
                <div style={{ fontSize: '0.75rem', color: MUTED }}>
                  <span style={{ fontWeight: 600 }}>Owner:</span> {req.owner}
                </div>
                <div style={{ fontSize: '0.75rem', color: MUTED, marginTop: '0.15rem' }}>
                  <span style={{ fontWeight: 600 }}>Blocked on:</span>{' '}
                  <span style={{ fontFamily: 'monospace' }}>{req.blocks.join(', ')}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
