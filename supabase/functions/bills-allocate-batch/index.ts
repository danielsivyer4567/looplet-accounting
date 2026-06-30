import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, preflight } from '../_shared/cors.ts'

interface RequestBody {
  org_id: string
  mode: 'stats' | 'auto_accept' | 'rematch' | 'full'
  min_score?: number
}

interface ScoreBandCounts {
  high: number       // >= 0.85
  medium: number     // 0.5 – 0.85
  no_suggestion: number
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    const client = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    })

    let body: RequestBody
    try {
      body = await req.json()
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const { org_id, mode, min_score } = body

    if (!org_id || typeof org_id !== 'string') {
      return new Response(
        JSON.stringify({ error: 'org_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (!['stats', 'auto_accept', 'rematch', 'full'].includes(mode)) {
      return new Response(
        JSON.stringify({ error: 'mode must be one of: stats, auto_accept, rematch, full' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // Verify org membership — fail fast before any heavy RPCs
    const { data: memberData, error: memberError } = await client
      .from('organization_members')
      .select('organization_id')
      .eq('organization_id', org_id)
      .maybeSingle()

    if (memberError) {
      return new Response(
        JSON.stringify({ error: 'Failed to verify org membership', detail: memberError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (!memberData) {
      return new Response(
        JSON.stringify({ error: 'Forbidden: caller is not a member of this organisation' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    const effectiveMinScore = min_score ?? 0.85

    if (mode === 'stats') {
      const result = await fetchStats(client, org_id)
      return new Response(
        JSON.stringify(result),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (mode === 'auto_accept') {
      const result = await runAutoAccept(client, org_id, effectiveMinScore)
      return new Response(
        JSON.stringify(result),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    if (mode === 'rematch') {
      const result = await runRematch(client, org_id)
      return new Response(
        JSON.stringify(result),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }

    // mode === 'full': rematch then auto_accept
    const rematchResult = await runRematch(client, org_id)
    const acceptResult = await runAutoAccept(client, org_id, effectiveMinScore)

    return new Response(
      JSON.stringify({ rematch: rematchResult, auto_accept: acceptResult }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    console.error('bills-allocate-batch unhandled error:', err)
    return new Response(
      JSON.stringify({ error: 'Internal server error', detail: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
})

async function fetchStats(
  client: ReturnType<typeof createClient>,
  org_id: string,
): Promise<{ stats: ScoreBandCounts }> {
  const { data, error } = await client
    .from('v_allocation_queue')
    .select('score')
    .eq('organization_id', org_id)

  if (error) {
    throw new Error(`Failed to query v_allocation_queue: ${error.message}`)
  }

  const rows = (data ?? []) as Array<{ score: number | null }>

  const counts: ScoreBandCounts = { high: 0, medium: 0, no_suggestion: 0 }
  for (const row of rows) {
    const score = row.score
    if (score == null) {
      counts.no_suggestion++
    } else if (score >= 0.85) {
      counts.high++
    } else if (score >= 0.5) {
      counts.medium++
    } else {
      counts.no_suggestion++
    }
  }

  return { stats: counts }
}

async function runAutoAccept(
  client: ReturnType<typeof createClient>,
  org_id: string,
  min_score: number,
): Promise<{ auto_accept: unknown }> {
  const { data, error } = await client.rpc('bulk_accept_job_suggestions', {
    p_org_id: org_id,
    p_min_score: min_score,
  })

  if (error) {
    throw new Error(`bulk_accept_job_suggestions failed: ${error.message}`)
  }

  return { auto_accept: data }
}

async function runRematch(
  client: ReturnType<typeof createClient>,
  org_id: string,
): Promise<{ rematch: unknown }> {
  const { data, error } = await client.rpc('rematch_unallocated_bills', {
    p_org_id: org_id,
    p_limit: 500,
  })

  if (error) {
    throw new Error(`rematch_unallocated_bills failed: ${error.message}`)
  }

  return { rematch: data }
}
