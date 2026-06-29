#!/usr/bin/env python3
"""
Real post-deploy smoke tests for Edge Functions and cron jobs (SC-DEPLOY-01).

This replaces the earlier mock script, which fabricated its own 200 responses
from an in-script dict and asserted on them — proving nothing and even claiming
DSP/EVTE were healthy when they are not. This version makes REAL HTTP calls to
the deployed functions and asserts on REAL status codes.

Design principles:
  * No fabricated responses. Every result comes from an actual network call.
  * Fail-closed is success. Before ATO DSP/EVTE/SBR credentials are provisioned,
    a lodge-capable function returning 401/403 FORBIDDEN is the CORRECT, healthy
    outcome. A 200 "lodged" without credentials would be a FAILURE.
  * Honest gaps. Cron execution-record inspection needs a service-role DB
    connection that this anon-key script does not have, so it is reported as
    SKIPPED with the reason — never faked.

Usage:
  SUPABASE_URL=https://<ref>.supabase.co \\
  SUPABASE_ANON_KEY=<anon> \\
  python scripts/deploy-smoke-tests.py

Exit codes: 0 = all asserted checks passed (skips allowed), 1 = a check failed
or required config is missing.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone

SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("VITE_SUPABASE_URL")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY") or os.environ.get(
    "VITE_SUPABASE_ANON_KEY"
)

PASS = "PASS"
FAIL = "FAIL"
SKIP = "SKIP"


@dataclass
class Check:
    name: str
    status: str
    detail: str
    http_status: int | None = None
    body_excerpt: str = ""


@dataclass
class HttpResult:
    status: int
    body: str
    error: str | None = None


def _request(path: str, method: str = "POST", payload: dict | None = None) -> HttpResult:
    """Issue a real HTTP request to a deployed Edge Function."""
    url = f"{SUPABASE_URL.rstrip('/')}/functions/v1/{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {SUPABASE_ANON_KEY}")
    req.add_header("apikey", SUPABASE_ANON_KEY)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return HttpResult(status=resp.status, body=resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        # Non-2xx still carries a body we want to inspect (e.g. the 403 gate JSON).
        return HttpResult(status=exc.code, body=exc.read().decode("utf-8", "replace"))
    except urllib.error.URLError as exc:
        return HttpResult(status=0, body="", error=str(exc.reason))
    except Exception as exc:  # noqa: BLE001 - surface any transport failure honestly
        return HttpResult(status=0, body="", error=str(exc))


def _excerpt(body: str, limit: int = 240) -> str:
    body = body.replace("\n", " ").strip()
    return body if len(body) <= limit else body[:limit] + "..."


# --- Individual checks -------------------------------------------------------


def check_function_reachable(name: str, path: str) -> Check:
    """A deployed function should be reachable. We never expect a 404 (missing
    deploy) or a transport error. Auth/gate rejections (401/403) are fine — they
    prove the function is up and enforcing its own rules."""
    res = _request(path, method="POST", payload={"smoke": True})
    if res.error or res.status == 0:
        return Check(name, FAIL, f"transport error: {res.error}", res.status)
    if res.status == 404:
        return Check(name, FAIL, "404 — function not deployed", 404, _excerpt(res.body))
    if res.status in (502, 503, 504):
        return Check(name, FAIL, f"{res.status} — function unhealthy", res.status, _excerpt(res.body))
    return Check(
        name,
        PASS,
        f"reachable (HTTP {res.status})",
        res.status,
        _excerpt(res.body),
    )


def check_lodge_fail_closed(name: str, path: str) -> Check:
    """For lodge-capable functions, BEFORE creds are provisioned the only safe
    outcome is a fail-closed rejection (401/403). A 200 success here would mean
    the gate is broken."""
    res = _request(path, method="POST", payload={"action": "smoke", "smoke": True})
    if res.error or res.status == 0:
        return Check(name, FAIL, f"transport error: {res.error}", res.status)
    if res.status == 404:
        return Check(name, FAIL, "404 — function not deployed", 404, _excerpt(res.body))
    if res.status in (401, 403):
        marker = "FORBIDDEN" in res.body or "Unauthorized" in res.body or "block_reason" in res.body
        return Check(
            name,
            PASS,
            f"fail-closed as expected (HTTP {res.status}{', gate marker present' if marker else ''})",
            res.status,
            _excerpt(res.body),
        )
    if res.status == 200:
        return Check(
            name,
            FAIL,
            "200 OK without credentials — fail-closed gate is NOT enforcing",
            200,
            _excerpt(res.body),
        )
    return Check(
        name,
        FAIL,
        f"unexpected HTTP {res.status} (wanted 401/403 pre-credentials)",
        res.status,
        _excerpt(res.body),
    )


def check_cron_records() -> Check:
    """Cron execution records live in `cron.job_run_details` and require a
    service-role DB connection. This anon-key HTTP script cannot read them, so
    we SKIP honestly rather than fabricate a pass."""
    return Check(
        "cron-execution-records",
        SKIP,
        "needs service-role DB access (SELECT cron.job_run_details); run the SQL "
        "check separately — not verifiable from an anon HTTP smoke test",
    )


# --- Runner ------------------------------------------------------------------

# (display name, function path). Lodge-capable functions are checked fail-closed.
REACHABLE_FUNCTIONS = [
    ("orchestrator-cron (SC-7.I)", "accountant-orchestrator"),
]
LODGE_FUNCTIONS = [
    ("ato-correspondence (SC-7.H)", "ato-correspondence"),
    ("working-papers bundle (SC-7.G.02)", "working-papers"),
    ("smsf-audit-pack (SC-5.M.01)", "smsf-audit-pack"),
    ("asic Form 484 (SC-5.P.03)", "div7a-agreement"),
]


def main() -> int:
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        print("ERROR: SUPABASE_URL and SUPABASE_ANON_KEY are required.", file=sys.stderr)
        return 1

    print("Real post-deploy smoke tests (SC-DEPLOY-01)")
    print(f"Target : {SUPABASE_URL}")
    print(f"Started: {datetime.now(timezone.utc).isoformat()}\n")

    checks: list[Check] = []
    for name, path in REACHABLE_FUNCTIONS:
        checks.append(check_function_reachable(name, path))
    for name, path in LODGE_FUNCTIONS:
        checks.append(check_lodge_fail_closed(name, path))
    checks.append(check_cron_records())

    for c in checks:
        symbol = {"PASS": "[PASS]", "FAIL": "[FAIL]", "SKIP": "[SKIP]"}[c.status]
        line = f"{symbol} {c.name}: {c.detail}"
        print(line)
        if c.body_excerpt:
            print(f"        body: {c.body_excerpt}")

    failed = [c for c in checks if c.status == FAIL]
    skipped = [c for c in checks if c.status == SKIP]
    passed = [c for c in checks if c.status == PASS]

    print("\nSummary")
    print(f"  passed : {len(passed)}")
    print(f"  failed : {len(failed)}")
    print(f"  skipped: {len(skipped)} (not fabricated — see reasons above)")

    if failed:
        print("\nRESULT: FAIL — do not treat this deploy as verified.")
        return 1
    print("\nRESULT: PASS — asserted checks green. Resolve SKIPs separately before lodge go-live.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
