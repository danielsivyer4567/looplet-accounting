# Accountant Portal

How external accountants join a client's Looplet organisation, what they can see,
and the invariants that keep them **non-billable**.

## Flow

1. A client sends an invite from **Settings → Account → Invite your accountant**
   (`team-invite` edge fn, `role: 'accountant'`, `redirectTo: ${SITE_URL}/accept-invite`).
2. The accountant lands on the public `/accept-invite` page. New users set a
   password (`AuthContext.setPassword` → `auth.updateUser`); existing users skip it.
3. `accept_pending_invites()` (migration `0199`, `SECURITY DEFINER`, `authenticated`
   only) matches `team_invitations` by the caller's verified JWT email, creates or
   updates an `organization_memberships` row with `role_enum = 'accountant'` and
   `accepted_at = now()`, and flips the invite to accepted. This closes the
   new-user gap: an invitee who had no account when invited still gets a membership.
4. `OrgContext.refresh()` reloads memberships; the accountant lands on `/clients`.

## Role-aware behaviour

`OrgContext` joins `role_enum, accepted_at` per membership and derives:

- `accountantClientOrgs` — orgs where the caller's relationship is `role_enum === 'accountant'`.
- `isAccountantOnly` — `organizations.length > 0 && every org is accountant`.

These drive:

- **Landing** (`App.tsx` `HomeRoute`): accountant-only users redirect to `/clients`.
- **Client picker** (`Clients.tsx`): card grid of client orgs; clicking switches org.
- **Nav** (`Layout.tsx`): a "Clients" item for mixed users (own org + client orgs).
- **Cross-tenant notifications** (`NotificationBell` / `Notifications` via
  `useNotificationOrgScope`): when `accountantClientOrgs.length > 0` the single-org
  filter is dropped and RLS scopes the rows; each row shows its client org name and
  clicking switches org before navigating.

## Non-billable invariant

Accountants are **guests** of their clients' orgs, not customers. The invariants:

1. **Never billed.** An accountant membership (`role_enum = 'accountant'`) must not
   count toward any seat / subscription tally. Future seat-counting MUST exclude
   `role_enum = 'accountant'` rows.
2. **Never forced to create an org.** An accountant-only user has no org of their
   own and should not be nudged to make one. `OrgSelector` suppresses the
   "+ New organisation" affordance when `isAccountantOnly` is true. Onboarding /
   empty-state "create your first org" prompts must apply the same guard.
3. **Access is borrowed, not owned.** All client data the accountant sees comes
   through RLS on the client org's rows (`get_accessible_org_ids()`), never through
   ownership. Revoking the membership revokes access with no orphaned billing.

When adding seat-counting, billing, or onboarding flows, check `role_enum` /
`isAccountantOnly` and exclude accountants per the rules above.
