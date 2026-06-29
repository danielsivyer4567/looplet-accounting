// Backend RPC (SC-7.E.00)
//
// Validates ATO credential completeness for lodge operations.
// Fails with FORBIDDEN if ATO DSP credentials absent.
// This is the primary gate for lodge operations.

import { lodgeOperationsHealth, type LodgeOperationsHealth } from "../_shared/lodge/operations-health.ts";

export interface LodgeReadyResult {
  allowed: boolean;
  health?: LodgeOperationsHealth & { reason?: string };
  error?: string;
}

export async function isLodgeReady(
  req: Request,
): Promise<LodgeReadyResult> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return {
      allowed: false,
      error: "Unauthorized",
    };
  }

  try {
    const health = lodgeOperationsHealth();

    if (!health.all_green) {
      return {
        allowed: false,
        health: {
          ...health,
          reason: "ATO DSP/EVTE/SBR configuration incomplete",
        },
        error: health.audit_trail,
      };
    }

    return {
      allowed: true,
      health,
    };
  } catch (err) {
    return {
      allowed: false,
      error: err instanceof Error ? err.message : "Health check failed",
    };
  }
}

Deno.serve(async (req: Request) => {
  // Health-check RPC for lodge operations readiness
  const result = await isLodgeReady(req);
  return new Response(JSON.stringify(result), {
    status: result.allowed ? 200 : 403,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
