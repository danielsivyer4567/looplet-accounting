import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const renew = readFileSync(join(root, 'supabase/functions/gmail-watch-renew/index.ts'), 'utf8');
const notificationsPage = readFileSync(join(root, 'src/pages/Notifications.tsx'), 'utf8');

describe('gmail-watch-renew disconnect notification contract', () => {
  it('disables fatal Gmail integrations and emits an org notification', () => {
    expect(renew).toMatch(
      /const fatal = \/invalid_grant\|\\\(400\\\)\|\\\(401\\\)\/i\.test\(msg\)/,
    );
    expect(renew).toMatch(/if \(fatal\) update\.is_active = false/);
    expect(renew).toMatch(/if \(fatal\) \{\s*await emitGmailDisconnectNotification/);
    expect(renew).toMatch(/admin\.rpc\('notify'/);
    expect(renew).toMatch(/p_category:\s*'gmail_disconnected'/);
    expect(renew).toMatch(/p_title:\s*'Reconnect Gmail'/);
    expect(renew).toMatch(/p_link:\s*'\/settings'/);
    expect(renew).toMatch(/p_severity:\s*'error'/);
    expect(renew).toMatch(/p_resource_type:\s*'gmail_integrations'/);
    expect(renew).toMatch(/p_resource_id:\s*row\.id/);
    expect(renew).not.toMatch(/TODO\(B3 follow-up\): also emit a notification row/);
  });

  it('keeps notification insert failures non-fatal to the renew run', () => {
    expect(renew).toMatch(/emitGmailDisconnectNotification\(admin, row, msg\)\.catch/);
    expect(renew).toMatch(/notify gmail_disconnected failed/);
  });

  it('labels Gmail disconnect alerts in the notifications UI', () => {
    expect(notificationsPage).toMatch(/gmail_disconnected:\s*'Gmail disconnected'/);
    expect(notificationsPage).toMatch(/gmail_disconnected:\s*MailWarning/);
  });
});
