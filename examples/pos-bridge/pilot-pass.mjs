#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import process from 'node:process';

const CODE_128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
];

const START_CODE_B = 104;
const STOP = 106;

async function main() {
  try {
    const config = parseArgs(process.argv.slice(2));
    const token = await resolveIdentityToken(config);
    validateReceiptIdentityToken(token);

    const html = renderPassHtml({
      token,
      businessName: config.businessName ?? 'Looplet pilot receipt pass',
      label: config.label ?? 'Pilot customer receipt identity',
      pilotId: config.pilotId ?? '',
      note: config.note ?? 'Cashier scans this before tender. The POS/export must place this value in identity_token for the final itemised receipt.',
    });

    await writeOutput(config.output, html, config.force);

    console.log(JSON.stringify({
      ok: true,
      output: resolve(config.output),
      bytes: Buffer.byteLength(html, 'utf8'),
      token_prefix: tokenPrefix(token),
      token_redacted: redactToken(token),
      format: 'html',
      symbology: 'code128-b',
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? redactToken(error.message) : redactToken(String(error)),
    }, null, 2));
    process.exit(1);
  }
}

function parseArgs(args) {
  const config = {
    output: 'looplet-pilot-pass.html',
    force: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--force') {
      config.force = true;
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
    index += 1;
    if (arg === '--identity-token') config.identityToken = next;
    else if (arg === '--env-file') config.envFile = next;
    else if (arg === '--output') config.output = next;
    else if (arg === '--business-name') config.businessName = next;
    else if (arg === '--label') config.label = next;
    else if (arg === '--pilot-id') config.pilotId = next;
    else if (arg === '--note') config.note = next;
    else throw new Error(`unsupported argument ${arg}`);
  }

  return config;
}

async function resolveIdentityToken(config) {
  if (config.identityToken) return config.identityToken;

  const envPath = config.envFile;
  if (!envPath) {
    throw new Error('pass --identity-token or --env-file with LOOPLET_RECEIPT_IDENTITY_TOKEN');
  }

  const env = parseEnv(await readFile(envPath, 'utf8'));
  if (!env.LOOPLET_RECEIPT_IDENTITY_TOKEN) {
    throw new Error('env file does not contain LOOPLET_RECEIPT_IDENTITY_TOKEN');
  }
  return env.LOOPLET_RECEIPT_IDENTITY_TOKEN;
}

function parseEnv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals === -1) continue;
    env[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  return env;
}

function validateReceiptIdentityToken(token) {
  if (!/^rhp_[^.]+\..+/.test(token)) {
    throw new Error('identity token must look like rhp_<prefix>.<secret>');
  }
  for (const char of token) {
    const code = char.charCodeAt(0);
    if (code < 32 || code > 126) {
      throw new Error('identity token must be printable ASCII for Code 128');
    }
  }
}

async function writeOutput(output, html, force) {
  const outputPath = resolve(output);
  if (!force) {
    try {
      await access(outputPath);
      throw new Error(`output already exists: ${outputPath}; pass --force to overwrite`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, 'utf8');
}

function renderPassHtml({ token, businessName, label, pilotId, note }) {
  const barcode = code128Bars(token);
  const bars = barcode.bars
    .map((bar) => `<rect class="bar" x="${bar.x}" y="14" width="${bar.width}" height="66"></rect>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Looplet POS pilot pass</title>
  <style>
    :root { font-family: Inter, Arial, sans-serif; color: #111827; background: #f8fafc; }
    body { margin: 0; padding: 32px; }
    main { max-width: 760px; margin: 0 auto; }
    .pass { background: #fff; border: 1px solid #d1d5db; border-radius: 12px; padding: 24px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
    .eyebrow { color: #047857; font-size: 12px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
    h1 { margin: 8px 0 6px; font-size: 26px; }
    p { color: #475569; line-height: 1.5; }
    .barcode { width: 100%; height: 118px; display: block; margin: 20px 0 12px; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; }
    .barcode .bar { fill: #000; }
    code { display: block; overflow-wrap: anywhere; padding: 12px; border-radius: 8px; background: #f1f5f9; color: #0f172a; font-size: 14px; }
    dl { display: grid; grid-template-columns: 120px 1fr; gap: 8px 12px; margin-top: 20px; color: #334155; }
    dt { font-weight: 800; color: #64748b; }
    dd { margin: 0; }
    .warning { margin-top: 18px; padding: 12px; border-radius: 8px; background: #fff7ed; color: #9a3412; font-size: 13px; }
    @media print {
      body { padding: 0; background: #fff; }
      .pass { box-shadow: none; border-color: #111827; break-inside: avoid; }
    }
  </style>
</head>
<body>
  <main>
    <section class="pass" aria-label="Looplet POS pilot pass">
      <div class="eyebrow">Looplet receipt identity</div>
      <h1>${escapeHtml(label)}</h1>
      <p>${escapeHtml(note)}</p>
      <svg class="barcode" role="img" aria-label="POS scannable receipt identity barcode" viewBox="0 0 ${barcode.width} 96" preserveAspectRatio="none">
        <rect width="${barcode.width}" height="96" fill="#fff"></rect>
        ${bars}
      </svg>
      <code>${escapeHtml(token)}</code>
      <dl>
        <dt>Business</dt>
        <dd>${escapeHtml(businessName)}</dd>
        <dt>Pilot ID</dt>
        <dd>${escapeHtml(pilotId || 'not recorded')}</dd>
        <dt>Symbology</dt>
        <dd>Code 128 B</dd>
      </dl>
      <div class="warning">Treat this pass as sensitive pilot credential material. Do not put it in logs, support tickets, or public photos.</div>
    </section>
  </main>
</body>
</html>
`;
}

function code128Bars(value, quietZone = 10) {
  const values = [START_CODE_B, ...payloadValues(value), checksum(value), STOP];
  const bars = [];
  let x = quietZone;
  for (const code of values) {
    const pattern = CODE_128_PATTERNS[code];
    [...pattern].forEach((part, index) => {
      const width = Number(part);
      if (index % 2 === 0) bars.push({ x, width });
      x += width;
    });
  }
  return { bars, width: x + quietZone };
}

function checksum(value) {
  return payloadValues(value).reduce((sum, code, index) => sum + code * (index + 1), START_CODE_B) % 103;
}

function payloadValues(value) {
  if (!value) throw new Error('Barcode value is required');
  return [...value].map((char) => char.charCodeAt(0) - 32);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function tokenPrefix(token) {
  return token.split('.')[0] ?? token;
}

function redactToken(value) {
  return String(value).replace(/rhp_[^\s"',}<>]+/g, (token) => `${tokenPrefix(token)}.[redacted]`);
}

await main();
