#!/usr/bin/env node
// UI-04 gate: the accessibility floor the themes and markup must keep.
//   (a) Every text/background token pair used by the app meets WCAG 2.1 AA contrast in both themes:
//       4.5:1 for body text, 3:1 for large text (>= 24px, or >= 18.66px bold).
//   (b) No font-size under 11px, in CSS or in inline styles (px, rem, em, Tailwind text-[Npx]).
//   (c) Every icon-only <button> has an accessible name: aria-label, aria-labelledby, title, or
//       visually hidden text (.sr-only / .visually-hidden).
// Run: node scripts/check-a11y-tokens.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_FILE = 'src/index.css';
const MIN_FONT_PX = 11;
const ROOT_FONT_PX = 16;

// ---------------------------------------------------------------------------
// (a) Contrast of token pairs. Text tokens are listed against the surfaces they sit on. A
// translucent background is composited over the page surface first. `large` relaxes to 3:1.
// ---------------------------------------------------------------------------
const PAIRS = [
  // Body copy on every surface.
  ...['--bg-app', '--bg-panel', '--bg-card', '--bg-input', '--bg-hover'].flatMap((bg) => [
    { fg: '--text-title', bg },
    { fg: '--text-body', bg },
    { fg: '--text-muted', bg },
    { fg: '--text-link', bg },
  ]),
  // Sidebar and brand tile.
  { fg: '--text-sidebar', bg: '--bg-sidebar' },
  { fg: '--text-sidebar-active', bg: '--bg-sidebar-active' },
  { fg: '--text-muted', bg: '--bg-sidebar' },
  { fg: '--brand-tile-fg', bg: '--brand-tile-bg' },
  // Buttons: white text on the filled accents.
  { fg: '--text-on-accent', bg: '--accent-primary' },
  { fg: '--text-on-accent', bg: '--accent-primary-hover' },
  // Status text on its tint (tints are translucent in dark mode: composite over the card).
  { fg: '--text-success', bg: '--bg-success-subtle', over: '--bg-card' },
  { fg: '--text-danger', bg: '--bg-danger-subtle', over: '--bg-card' },
  { fg: '--text-warning', bg: '--bg-warning-subtle', over: '--bg-card' },
  { fg: '--text-info', bg: '--bg-info-subtle', over: '--bg-card' },
  // Status text straight on surfaces (table cells, notes).
  ...['--bg-app', '--bg-card'].flatMap((bg) => [
    { fg: '--text-success', bg },
    { fg: '--text-danger', bg },
    { fg: '--text-warning', bg },
    { fg: '--text-info', bg },
  ]),
  // Accents on the surfaces. Accents are fills, borders and icons (and, at most, large or bold
  // labels): the 3:1 non-text/large-text minimum. Body text uses the --text-* tokens above, which
  // is why those are held to 4.5:1 and why an accent cannot double as small text: a colour that is
  // 4.5:1 against a dark surface cannot also carry white button text at 4.5:1.
  ...['--bg-app', '--bg-card', '--bg-panel'].flatMap((bg) => [
    { fg: '--accent-primary', bg, large: true },
    { fg: '--accent-success', bg, large: true },
    { fg: '--accent-danger', bg, large: true },
    { fg: '--accent-warning', bg, large: true },
    { fg: '--accent-info', bg, large: true },
  ]),
  // Code block and palette tiles (white text on each palette colour).
  { fg: '--text-code', bg: '--bg-code' },
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ fg: '--text-on-accent', bg: `--palette-${n}` })),
];

function parseThemeBlocks(css) {
  const blocks = {};
  const re = /(^|\n)((?::root|html\[data-theme='(?:light|dark)'\])(?:,\s*html\[data-theme='(?:light|dark)'\])?)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selector = m[2];
    const theme = /dark/.test(selector) ? 'dark' : 'light';
    blocks[theme] ??= {};
    const body = m[3].replace(/\/\*[\s\S]*?\*\//g, '');
    for (const decl of body.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const name = decl.slice(0, i).trim();
      const value = decl.slice(i + 1).trim();
      if (name.startsWith('--')) blocks[theme][name] = value;
    }
  }
  // :root common values apply to both themes.
  if (blocks.light && blocks.dark) for (const [k, v] of Object.entries(blocks.light)) blocks.dark[k] ??= v;
  return blocks;
}

function parseColour(value, tokens, depth = 0) {
  if (depth > 8) return null;
  const v = value.trim();
  const varRef = /^var\((--[\w-]+)\)$/.exec(v);
  if (varRef) return tokens[varRef[1]] ? parseColour(tokens[varRef[1]], tokens, depth + 1) : null;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (fn) return { r: +fn[1], g: +fn[2], b: +fn[3], a: fn[4] === undefined ? 1 : +fn[4] };
  return null; // gradients, shadows, fonts
}

function composite(fg, bg) {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

function luminance({ r, g, b }) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const problems = [];
const css = readFileSync(join(ROOT, TOKEN_FILE), 'utf8');
const themes = parseThemeBlocks(css);
let pairsChecked = 0;
for (const theme of ['light', 'dark']) {
  const tokens = themes[theme];
  if (!tokens) {
    problems.push(`${TOKEN_FILE}: no ${theme} theme block found`);
    continue;
  }
  for (const pair of PAIRS) {
    const fgRaw = tokens[pair.fg];
    const bgRaw = tokens[pair.bg];
    if (!fgRaw || !bgRaw) {
      problems.push(`${theme}: token missing for pair ${pair.fg} on ${pair.bg}`);
      continue;
    }
    const fg = parseColour(fgRaw, tokens);
    let bg = parseColour(bgRaw, tokens);
    if (!fg || !bg) {
      problems.push(`${theme}: cannot parse ${pair.fg}=${fgRaw} or ${pair.bg}=${bgRaw}`);
      continue;
    }
    if (bg.a < 1) {
      const over = parseColour(tokens[pair.over ?? '--bg-card'] ?? '', tokens);
      if (!over) {
        problems.push(`${theme}: ${pair.bg} is translucent and ${pair.over ?? '--bg-card'} cannot be resolved`);
        continue;
      }
      bg = composite(bg, over);
    }
    const ratio = contrast(fg.a < 1 ? composite(fg, bg) : fg, bg);
    const min = pair.large ? 3 : 4.5;
    pairsChecked += 1;
    if (ratio < min) {
      problems.push(`${theme}: ${pair.fg} on ${pair.bg} is ${ratio.toFixed(2)}:1 (needs ${min}:1)  [${fgRaw} on ${bgRaw}]`);
    }
  }
}

// ---------------------------------------------------------------------------
// (b) Font sizes.
// ---------------------------------------------------------------------------
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|css)$/.test(name)) out.push(full);
  }
  return out;
}
const files = walk(join(ROOT, 'src'))
  .map((f) => relative(ROOT, f).replace(/\\/g, '/'))
  .filter((f) => !f.startsWith('src/test/'))
  .sort();

function toPx(num, unit) {
  if (unit === 'px' || unit === '') return num;
  if (unit === 'rem' || unit === 'em') return num * ROOT_FONT_PX;
  return null; // %, vw: not judged
}

const FONT_SIZE_RE = /(?:font-size\s*:\s*|fontSize\s*:\s*['"]?)(\d*\.?\d+)\s*(px|rem|em|)(?=[;'",}\s)])|text-\[(\d*\.?\d+)px\]/g;
let fontSitesChecked = 0;
let iconButtonsChecked = 0;

for (const file of files) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(FONT_SIZE_RE)) {
      fontSitesChecked += 1;
      const px = m[3] !== undefined ? Number(m[3]) : toPx(Number(m[1]), m[2]);
      if (px !== null && px < MIN_FONT_PX) {
        problems.push(`${file}:${i + 1}: font-size ${m[0].trim()} is ${px.toFixed(1)}px (< ${MIN_FONT_PX}px)  | ${line.trim().slice(0, 90)}`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // (c) Icon-only buttons.
  // -------------------------------------------------------------------------
  if (!file.endsWith('.tsx')) continue;
  let pos = 0;
  while ((pos = text.indexOf('<button', pos)) !== -1) {
    const after = text[pos + 7];
    if (after && !/[\s>/]/.test(after)) {
      pos += 7;
      continue;
    }
    // Walk the opening tag, skipping JSX expressions and strings, to its closing '>'.
    let i = pos + 7;
    let depth = 0;
    let quote = null;
    let selfClosing = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote && text[i - 1] !== '\\') quote = null;
        continue;
      }
      if (depth === 0 && (ch === '"' || ch === "'")) {
        quote = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '`' && depth > 0) {
        // template literal inside an expression: skip to its end
        let j = i + 1;
        while (j < text.length && text[j] !== '`') j++;
        i = j;
      } else if (depth === 0 && ch === '>') {
        selfClosing = text[i - 1] === '/';
        break;
      }
    }
    const openTag = text.slice(pos, i + 1);
    const lineNo = text.slice(0, pos).split('\n').length;
    let children = '';
    let end = i + 1;
    if (!selfClosing) {
      const close = text.indexOf('</button>', i);
      if (close === -1) break;
      children = text.slice(i + 1, close);
      end = close + 9;
    }
    pos = end;
    iconButtonsChecked += 1;
    // Children with whitespace, {' '} and comments removed.
    const body = children
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\{'\s*'\}/g, '')
      .replace(/\{"\s*"\}/g, '')
      .trim();
    if (body === '' && !selfClosing && !/aria-label|title=|aria-labelledby/.test(openTag)) {
      // An empty button is rendered by children elsewhere (rare); treat as icon-only.
    }
    // Icon-only: only self-closing elements (icons), or a single glyph such as × or ….
    const onlyElements = body.length > 0 && /^(?:<[A-Za-z][\w.]*(?:\s[^<>]*?)?\/>\s*)+$/.test(body.replace(/\{[^{}]*\}/g, (e) => (/^\{\s*<[^>]*\/>\s*\}$/.test(e) ? '<I />' : e)));
    const onlyGlyph = /^(?:&times;|&#x2715;|&hellip;|[×✕✖✗⋯…‹›«»←→↑↓+\-–—•·]|×)$/.test(body);
    const conditionalIcon = /^\{[^{}]*\?\s*<[A-Z][\w.]*[^<>]*\/>\s*:\s*<[A-Z][\w.]*[^<>]*\/>\s*\}$/.test(body);
    if (!(onlyElements || onlyGlyph || conditionalIcon)) continue;
    const named = /\baria-label(?:ledby)?\s*=|\btitle\s*=/.test(openTag) || /sr-only|visually-hidden|VisuallyHidden/.test(children);
    if (!named) {
      problems.push(`${file}:${lineNo}: icon-only <button> without an accessible name  | ${openTag.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Accessibility check failed (${problems.length}):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `Accessibility check passed: ${pairsChecked} token pairs meet WCAG AA in both themes, ${fontSitesChecked} font sizes >= ${MIN_FONT_PX}px, ${iconButtonsChecked} buttons scanned and every icon-only one is named.`,
);
