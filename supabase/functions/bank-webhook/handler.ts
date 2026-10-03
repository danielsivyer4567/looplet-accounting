// bank-webhook request handling, separated from Deno.serve so it can be tested with fakes.
//
// Order of work for one Redbark delivery:
//   1. Fail closed: no REDBARK_WEBHOOK_SECRET means 503. The function is deployed with verify_jwt = false, so the
//      HMAC signature over the raw body is its only gate.
//   2. Read the body (bounded), verify the signature and timestamp. Anything unverified is refused with 401 and
//      nothing is stored.
//   3. Find the linked connections for the accounts the delivery names (a read), then persist the event in
//      bank_events_raw BEFORE acting. If it cannot be stored the delivery is not acknowledged (500), so Redbark
//      retries it.
//   4. Dispatch one bank-sync per linked connection, however many rows name it, and acknowledge with 202.
//
// Redbark allows three attempts in about four seconds and then disables the destination; a 30-second timeout is not
// retried (https://redbark.com/docs/webhook). So the syncs run in the background after the acknowledgement, and a
// failed sync is recorded on the connection rather than turned into a failed delivery: the event is already stored,
// bank-sync is idempotent and resumes from its checkpoint, and bank-sync-all runs every six hours.

import { isFeedOrganization } from '../_shared/bankfeed/access.ts';
import { parseRedbarkEvent, readBoundedBody, sha256Hex, verifyRedbarkSignature } from '../_shared/bankfeed/webhook.ts';

export interface LinkedConnection {
  id: string;
  organization_id: string;
}

export interface RawEventRow {
  organization_id: string | null;
  provider: 'redbark';
  provider_event_id: string;
  payload_hash: string;
  raw_payload: Record<string, unknown>;
}

export interface WebhookDeps {
  secret: string | null | undefined;
  allowedOrganizationIds: ReadonlySet<string>;
  now?: () => number;
  /** Active Redbark connections with an active linked account among `accountIds`. */
  findLinkedConnections(accountIds: string[]): Promise<LinkedConnection[]>;
  /** Inserts the raw event; 'duplicate' when this exact event was stored before. Throws when it cannot be stored. */
  storeEvent(row: RawEventRow): Promise<'stored' | 'duplicate'>;
  /** Starts bank-sync for one connection; rejects when the sync could not run. */
  dispatchSync(connection: LinkedConnection): Promise<void>;
  recordDispatchFailure(connection: LinkedConnection, message: string): Promise<void>;
  /** Keeps `work` running after the response is sent (EdgeRuntime.waitUntil in production). */
  background(work: Promise<unknown>): void;
}

function reply(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function handleBankWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== 'POST') return reply({ ok: false, error: 'POST only' }, 405);
  if (!deps.secret) return reply({ ok: false, error: 'The bank feed webhook is not configured.' }, 503);

  let body: string;
  try {
    body = await readBoundedBody(req);
  } catch (error) {
    return error instanceof RangeError
      ? reply({ ok: false, error: 'Delivery too large.' }, 413)
      : reply({ ok: false, error: 'Delivery body could not be read.' }, 400);
  }

  const verified = await verifyRedbarkSignature({
    signature: req.headers.get('X-Redbark-Signature'),
    timestamp: req.headers.get('X-Redbark-Timestamp'),
    rawBody: body,
    secret: deps.secret,
    nowMs: (deps.now ?? Date.now)(),
  });
  if (!verified.ok) return reply({ ok: false, error: 'Delivery not verified.' }, 401);

  const event = parseRedbarkEvent(body);
  const payloadHash = await sha256Hex(body);

  // One target per connection; only organisations allowed to use the feed are woken.
  const targets = new Map<string, LinkedConnection>();
  if (event.accountIds.length > 0) {
    for (const connection of await deps.findLinkedConnections(event.accountIds)) {
      if (isFeedOrganization(deps.allowedOrganizationIds, connection.organization_id)) targets.set(connection.id, connection);
    }
  }
  const organizations = new Set([...targets.values()].map((t) => t.organization_id));

  // Persist before acting. Members of the one organisation the event belongs to can read it; an event that names no
  // linked account, or several organisations, is stored without one and stays service-role only.
  let duplicateDelivery = false;
  try {
    const stored = await deps.storeEvent({
      organization_id: organizations.size === 1 ? [...organizations][0] : null,
      provider: 'redbark',
      provider_event_id: event.id ? `event:${event.id}` : `body:${payloadHash}`,
      payload_hash: payloadHash,
      raw_payload: event.payload,
    });
    if (stored === 'duplicate') duplicateDelivery = true;
  } catch (error) {
    console.error(JSON.stringify({ event: 'bankfeed.webhook_persist_failed', message: error instanceof Error ? error.message : String(error) }));
    return reply({ ok: false, error: 'The bank feed event could not be stored.' }, 500);
  }

  if (event.type !== 'transactions.synced') {
    return reply({ ok: true, action: 'ignored', type: event.type, duplicate: duplicateDelivery }, 200);
  }
  if (targets.size === 0) {
    return reply({ ok: true, action: 'no_linked_accounts', duplicate: duplicateDelivery }, 200);
  }

  // A duplicate delivery still dispatches: an earlier attempt may have stored the event and then failed before its
  // sync ran, and bank-sync never imports a transaction twice.
  const connections = [...targets.values()];
  const work = Promise.allSettled(connections.map((connection) => deps.dispatchSync(connection))).then(async (results) => {
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') continue;
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      await deps.recordDispatchFailure(connections[index], message).catch((error) => {
        console.error(JSON.stringify({ event: 'bankfeed.webhook_failure_not_recorded', connection: connections[index].id, message: String(error) }));
      });
    }
  });
  deps.background(work);
  return reply({ ok: true, action: 'sync_dispatched', connections: connections.length, duplicate: duplicateDelivery }, 202);
}
