// Lodge readiness checklist
//
// A clear, honest status panel of what is *actually required* before any
// electronic lodgement to the ATO/ASIC can succeed. None of these can be faked
// locally — they are external accreditation, credential, and hosting steps.
// Items render red while unmet and flip green only when their underlying
// secrets/assets are provisioned and the deployed gate reports `all_green`.
// The default state is all-unmet: lodgement is blocked until then.

import { AlertTriangle, Circle, CheckCircle2 } from 'lucide-react';

export interface LodgeRequirement {
  /** Stable id. */
  id: string;
  /** Short human title of the requirement. */
  title: string;
  /** What actually has to happen, in plain language. */
  detail: string;
  /** Who must do it — almost always an external party. */
  owner: string;
  /** True once provisioned + verified against the deployed gate. */
  done: boolean;
}

// The canonical, honest list. `done: false` everywhere because production
// ATO/DSP/SBR readiness requires external accreditation that has not been
// granted yet. Flip an item's `done` to true ONLY when the deployed gate
// proves it green.
export const LODGE_REQUIREMENTS: readonly LodgeRequirement[] = [
  {
    id: 'dsp',
    title: 'ATO Digital Service Provider accreditation',
    detail:
      'Looplet must be registered with the ATO as a Digital Service Provider and pass their security and operational review. The ATO then issues the machine credentials used to sign lodgements — these are granted by the ATO and cannot be self-issued.',
    owner: 'ATO (external accreditation)',
    done: false,
  },
  {
    id: 'evte',
    title: 'ATO test-environment certification',
    detail:
      'A full draft → lodge → receipt cycle must pass in the ATO’s External Vendor Test Environment. The ATO grants access to the production lodgement endpoint only after this certification passes.',
    owner: 'ATO (grants production access after certification)',
    done: false,
  },
  {
    id: 'sbr',
    title: 'Standard Business Reporting taxonomy hosting',
    detail:
      'The official SBR taxonomy (the ATO’s ~200MB validation ruleset) must be version-pinned and hosted so lodgement checks validate against the same rules the ATO applies.',
    owner: 'Looplet platform',
    done: false,
  },
  {
    id: 'smoke',
    title: 'Verified end-to-end connectivity',
    detail:
      'Once credentials and hosting are in place, live connectivity is verified end-to-end against the deployed services before the first real lodgement is allowed.',
    owner: 'Looplet platform (after provisioning)',
    done: false,
  },
  {
    id: 'gate',
    title: 'Lodgement gate reports all-green',
    detail:
      'Lodgement stays safely disabled until accreditation, certification and hosting are all verified. This is a protective gate: it makes a half-configured lodgement impossible rather than risky.',
    owner: 'Automatic — flips once the items above are green',
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
            : `Lodgement disabled — awaiting ${outstanding.length} external prerequisite${
                outstanding.length === 1 ? '' : 's'
              }`}
        </h2>
      </header>

      {!allGreen && (
        <p style={{ color: MUTED, fontSize: '0.85rem', margin: '0.4rem 0 0.85rem' }}>
          Electronic lodgement to the ATO/ASIC requires external accreditation and ATO-issued
          credentials. Until every item below is verified, lodgement is safely disabled — prepare
          and review your lodgements here, then lodge through your registered agent or the ATO
          portals.
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
                <span
                  style={{
                    color,
                    fontWeight: 700,
                    fontSize: '0.92rem',
                  }}
                >
                  {req.done ? 'Done' : 'Awaiting'} — {req.title}
                </span>
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
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
