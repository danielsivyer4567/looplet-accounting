import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  allows,
  effectiveSources,
  parseCsp,
  parsePermissionsPolicy,
  readHeaders,
} from './cspPolicy';

// CSP-01. The production headers in public/_headers blocked two working features:
// - PDF previews. Allocations, BillDetail and CodingReview show a PDF bill in an <iframe> pointed at a
//   Supabase Storage signed URL, but the CSP had no frame-src, so frames fell back to default-src 'self'.
// - Voice notes. TagDropManager records audio with getUserMedia({ audio: true }), but the
//   Permissions-Policy said microphone=().
// The fix allows exactly those two things and nothing else.

const headers = readHeaders();
const csp = parseCsp(headers.get('content-security-policy') ?? '');
const permissions = parsePermissionsPolicy(headers.get('permissions-policy') ?? '');

/** A signed URL made the way the app makes one (getBillFileUrl → storage.createSignedUrl), offline. */
async function signedUrlFor(projectUrl: string, bucket: string, key: string): Promise<string> {
  const fetchStub: typeof fetch = async (input) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    // Supabase Storage answers POST /storage/v1/object/sign/<bucket>/<key> with a relative signed path.
    const signedURL = path.replace('/storage/v1', '') + '?token=test-token';
    return new Response(JSON.stringify({ signedURL }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createClient(projectUrl, 'anon-key', {
    global: { fetch: fetchStub },
    auth: { persistSession: false },
  });
  const { data, error } = await client.storage.from(bucket).createSignedUrl(key, 600);
  if (error || !data) throw error ?? new Error('no signed URL');
  return data.signedUrl;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path.replace(/\\/g, '/')] : [];
  });
}

describe('PDF previews work under the production CSP (CSP-01)', () => {
  it('lets a page frame a Supabase Storage signed URL', async () => {
    const url = await signedUrlFor(
      'https://dxoikltymmknxqpkpyhi.supabase.co',
      'bills',
      'org-1/2026/bill 7.pdf',
    );
    expect(url).toMatch(
      /^https:\/\/dxoikltymmknxqpkpyhi\.supabase\.co\/storage\/v1\/object\/sign\/bills\//,
    );
    expect(allows(csp, 'frame-src', url)).toBe(true);
    // A preview build on another Supabase project (staging) frames its own storage too.
    expect(
      allows(
        csp,
        'frame-src',
        await signedUrlFor('https://stagingref.supabase.co', 'documents', 'a.pdf'),
      ),
    ).toBe(true);
  });

  it('frames Storage objects only: not other Supabase APIs, not other sites, not data: or blob:', () => {
    for (const blocked of [
      'https://dxoikltymmknxqpkpyhi.supabase.co/rest/v1/bills',
      'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/ask-bot',
      'https://dxoikltymmknxqpkpyhi.supabase.co/auth/v1/authorize',
      'https://supabase.co.evil.example/storage/v1/object/sign/x.pdf',
      'https://evil.example/storage/v1/object/sign/x.pdf',
      'http://dxoikltymmknxqpkpyhi.supabase.co/storage/v1/object/sign/x.pdf',
      'https://accounting.looplet.com.au/',
      'data:application/pdf;base64,JVBERi0=',
      'blob:https://accounting.looplet.com.au/1234',
    ]) {
      expect(allows(csp, 'frame-src', blocked), blocked).toBe(false);
    }
  });

  it('lets DocumentPreviewModal fetch the file and show the pages it renders as JPEG data URLs', async () => {
    const url = await signedUrlFor(
      'https://dxoikltymmknxqpkpyhi.supabase.co',
      'bills',
      'org-1/b.pdf',
    );
    expect(allows(csp, 'connect-src', url)).toBe(true);
    expect(allows(csp, 'img-src', 'data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
    const modal = readFileSync('src/components/DocumentPreviewModal.tsx', 'utf8');
    expect(modal).toContain("canvas.toDataURL('image/jpeg'");
    expect(modal).toContain('await fetch(url)');
  });

  it('covers every page that frames a document: each one frames a signed Storage URL', () => {
    const framing = sourceFiles('src').filter((file) =>
      readFileSync(file, 'utf8').includes('<iframe'),
    );
    expect(framing.sort()).toEqual([
      'src/pages/Allocations.tsx',
      'src/pages/BillDetail.tsx',
      'src/pages/CodingReview.tsx',
    ]);
    for (const file of framing) {
      expect(readFileSync(file, 'utf8'), file).toMatch(/createSignedUrl\(|getBillFileUrl\(/);
    }
  });
});

describe('the microphone works for this site only (CSP-01)', () => {
  it('allows the microphone for the app itself and nobody else', () => {
    expect(permissions.get('microphone')).toEqual(['self']);
    const recorder = readFileSync('src/components/tag-drop/TagDropManager.tsx', 'utf8');
    expect(recorder).toContain('navigator.mediaDevices.getUserMedia({ audio: true })');
  });

  it('keeps the camera and geolocation off', () => {
    expect(permissions.get('camera')).toEqual([]);
    expect(permissions.get('geolocation')).toEqual([]);
    expect([...permissions.keys()].sort()).toEqual(['camera', 'geolocation', 'microphone']);
  });
});

describe('nothing else in the policy was loosened (CSP-01)', () => {
  it('keeps scripts, objects, framing of this site and the base URI locked down', () => {
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('script-src')).toEqual(["'self'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'self'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
    expect(csp.has('upgrade-insecure-requests')).toBe(true);
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('frame-src names one path-limited source and no wildcard, scheme or self', () => {
    expect(csp.get('frame-src')).toEqual(['https://*.supabase.co/storage/v1/object/']);
    expect(effectiveSources(csp, 'frame-src')).not.toContain("'self'");
  });

  it('never allows eval or inline scripts, and no directive allows everything', () => {
    for (const [name, sources] of csp) {
      expect(sources, name).not.toContain("'unsafe-eval'");
      expect(sources, name).not.toContain('*');
      if (name !== 'style-src') expect(sources, name).not.toContain("'unsafe-inline'");
    }
  });
});
