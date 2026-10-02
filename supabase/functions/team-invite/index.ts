/**
 * team-invite — invite a user to an organisation by email.
 *
 * POST { email, role, organization_id }
 *
 * Flow:
 *   1. Verify caller is authenticated and has admin+ role for the org.
 *   2. Check if the email already has an active membership → reject with 409.
 *   3. Check if there is already a pending invitation → reject with 409.
 *   4. Try Supabase Admin API inviteUserByEmail (sends magic-link email).
 *      If the user already exists in auth.users the Admin API still succeeds
 *      (it re-sends a link).
 *   5. Insert a row into organization_memberships with accepted_at = NULL
 *      (pending) and into team_invitations for the audit trail.
 *   6. Return { ok, message }.
 *
 * Fail-closed: if the Supabase invite email cannot be sent we have no safe way
 * for the invitee to redeem the invite (redemption is gated on a *verified*
 * email via accept_pending_invites(), not on a raw URL token), so we roll back
 * the invitation + pending membership and return an error rather than handing
 * back a dead/insecure ?token=<uuid> link. See SLICE P0-03.
 *
 * Input:  { email: string, role: OrgRole, organization_id: string }
 * Output: { ok: true, message: string }
 *       | { ok: false, error: string }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { authorizeOrgMember, supabaseOrgAccessDeps } from '../_shared/orgRole.ts';

type OrgRole = 'viewer' | 'employee' | 'accountant' | 'admin' | 'owner';

const ROLE_RANK: Record<OrgRole, number> = {
  viewer: 0,
  employee: 1,
  accountant: 2,
  admin: 3,
  owner: 4,
};

const VALID_ROLES: OrgRole[] = ['viewer', 'employee', 'accountant', 'admin', 'owner'];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  // --------------------------------------------------------------------------
  // 0. Server config
  // --------------------------------------------------------------------------
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json({ ok: false, error: 'Server config missing' }, 500);
  }

  // --------------------------------------------------------------------------
  // 1. Auth: require a user JWT
  // --------------------------------------------------------------------------
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ ok: false, error: 'Unauthorized' }, 401);

  // Admin client — used for privileged operations only after role-check.
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // --------------------------------------------------------------------------
  // 2. Parse + validate body
  // --------------------------------------------------------------------------
  let body: { email?: string; role?: string; organization_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const { email, role, organization_id } = body;

  if (!email || !role || !organization_id) {
    return json({ ok: false, error: 'email, role, and organization_id are required' }, 400);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedRole = role.trim().toLowerCase() as OrgRole;

  if (!VALID_ROLES.includes(normalizedRole)) {
    return json({ ok: false, error: `role must be one of: ${VALID_ROLES.join(', ')}` }, 400);
  }

  // --------------------------------------------------------------------------
  // 3. Verify caller is an ACCEPTED admin or owner of this org (a pending admin
  //    invite must not be able to invite others).
  // --------------------------------------------------------------------------
  const access = await authorizeOrgMember(user.id, organization_id, supabaseOrgAccessDeps(adminClient, serviceKey), 'admin');
  if (!access.ok || access.caller.kind !== 'member') {
    return json({ ok: false, error: 'Only an admin or owner can invite members' }, access.ok ? 403 : access.status);
  }
  const callerRank = ROLE_RANK[access.caller.role as OrgRole] ?? -1;

  // Cannot invite someone to a role higher than your own
  if (ROLE_RANK[normalizedRole] > callerRank) {
    return json({ ok: false, error: 'Cannot invite to a role higher than your own' }, 403);
  }

  // --------------------------------------------------------------------------
  // 4. Check for existing active membership (use adminClient to resolve email
  //    → user_id; user may not yet exist in auth.users if first-time invite).
  // --------------------------------------------------------------------------
  const { data: existingUser } = await adminClient.auth.admin.listUsers();
  const matchedUser = existingUser?.users?.find(
    (u) => u.email?.toLowerCase() === normalizedEmail,
  );

  if (matchedUser) {
    const { data: activeMembership } = await adminClient
      .from('organization_memberships')
      .select('id, accepted_at')
      .eq('user_id', matchedUser.id)
      .eq('organization_id', organization_id)
      .maybeSingle();

    if (activeMembership?.accepted_at) {
      return json({ ok: false, error: 'This user is already an active member' }, 409);
    }
  }

  // --------------------------------------------------------------------------
  // 5. Check for duplicate pending invitation
  // --------------------------------------------------------------------------
  const { data: existingInvite } = await adminClient
    .from('team_invitations')
    .select('id, status, expires_at')
    .eq('organization_id', organization_id)
    .eq('email', normalizedEmail)
    .eq('status', 'pending')
    .maybeSingle();

  if (existingInvite) {
    const expiresAt = new Date(existingInvite.expires_at);
    if (expiresAt > new Date()) {
      return json(
        { ok: false, error: 'A pending invitation already exists for this email' },
        409,
      );
    }
    // Expired invite — mark it cancelled so we can create a fresh one
    await adminClient
      .from('team_invitations')
      .update({ status: 'cancelled' })
      .eq('id', existingInvite.id);
  }

  // --------------------------------------------------------------------------
  // 6. Create team_invitations record (audit trail + fallback invite token)
  // --------------------------------------------------------------------------
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  // Map org_role → membership_role for team_invitations.role column
  // (team_invitations.role is membership_role enum from migration 0001)
  const legacyRole = normalizedRole === 'accountant'
    ? 'manager'
    : normalizedRole === 'employee' || normalizedRole === 'viewer'
    ? 'member'
    : normalizedRole; // owner | admin map directly

  const { error: inviteRowErr } = await adminClient.from('team_invitations').insert({
    organization_id,
    email: normalizedEmail,
    role: legacyRole,
    token,
    status: 'pending',
    invited_by: user.id,
    expires_at: expiresAt.toISOString(),
  });

  if (inviteRowErr) {
    console.error('team_invitations insert error:', inviteRowErr);
    return json({ ok: false, error: 'Failed to create invitation record' }, 500);
  }

  // --------------------------------------------------------------------------
  // 7. If the invited user already exists, upsert a pending membership row
  //    so they see the pending state immediately on next login.
  //    accepted_at stays NULL until they accept.
  // --------------------------------------------------------------------------
  if (matchedUser) {
    const { error: upsertErr } = await adminClient
      .from('organization_memberships')
      .upsert(
        {
          user_id: matchedUser.id,
          organization_id,
          role: legacyRole,
          role_enum: normalizedRole,
          is_default: false,
          invited_by: user.id,
          invited_at: new Date().toISOString(),
          accepted_at: null,
        },
        { onConflict: 'user_id,organization_id', ignoreDuplicates: false },
      );

    if (upsertErr) {
      console.error('membership upsert error:', upsertErr);
      // Non-fatal — invitation record is already created
    }
  }

  // --------------------------------------------------------------------------
  // 8. Send invite email via Supabase Admin API
  //    redirectTo lands the invitee on /accept-invite, where they set a
  //    password (new user) and accept_pending_invites() grants the membership.
  // --------------------------------------------------------------------------
  const siteUrl = Deno.env.get('SITE_URL') ?? supabaseUrl.replace('/rest/v1', '');

  const { error: adminInviteErr } = await adminClient.auth.admin.inviteUserByEmail(
    normalizedEmail,
    {
      redirectTo: `${siteUrl}/accept-invite`,
      data: {
        organization_id,
        invite_role: normalizedRole,
        invited_by: user.email ?? user.id,
      },
    },
  );

  if (adminInviteErr) {
    // Email send failed. We have no safe fallback: redemption requires the
    // invitee to be signed in with their *verified* email (accept_pending_invites
    // matches the JWT email, not the URL token), so a raw ?token=<uuid> link
    // grants nothing and only leaks a live invite token. Fail closed — roll back
    // the invitation (and any freshly-created pending membership) so we don't
    // leave a dangling "pending forever" record, then surface the error.
    console.error('inviteUserByEmail failed — rolling back invite:', adminInviteErr.message);

    await adminClient.from('team_invitations').delete().eq('token', token);

    if (matchedUser) {
      // Only remove the membership if it is still pending — never clobber a row
      // the user had already accepted in a prior invite.
      await adminClient
        .from('organization_memberships')
        .delete()
        .eq('user_id', matchedUser.id)
        .eq('organization_id', organization_id)
        .is('accepted_at', null);
    }

    return json(
      {
        ok: false,
        error:
          'Could not send the invitation email. The invite was not created. ' +
          'Please check the email address and try again, or contact support if this persists.',
      },
      502,
    );
  }

  return json({
    ok: true,
    message: `Invitation sent to ${normalizedEmail}`,
  });
});
