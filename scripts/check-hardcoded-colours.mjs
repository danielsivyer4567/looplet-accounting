#!/usr/bin/env node
// UI-01 gate: every colour in the app comes from a theme token, so both themes render every screen.
// Fails on a hard-coded colour literal (hex, rgb()/rgba(), hsl()/hsla(), or a CSS named colour used as a
// value) in src/**/*.tsx, src/**/*.css and index.html. The token definitions in src/index.css (custom
// properties declared in the :root / html[data-theme] blocks) are the one place literals belong.
// The allow-list below names the few literals that cannot be tokens, each with its reason.
// Run: node scripts/check-hardcoded-colours.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_FILE = 'src/index.css';

/** Literals that stay literal. `pattern` is matched against the literal; `path` against the repo path. */
const ALLOW = [
  {
    path: 'src/components/tag-drop/DrawingCanvas.tsx',
    reason: 'Canvas 2D drawing: the pen palette the user picks from and the canvas fill are pixels, not CSS, so they cannot resolve a custom property.',
  },
  {
    path: 'src/components/tag-drop/ModernTagOverlay.tsx',
    reason: 'Builds a standalone HTML document for a popup window that has no stylesheet, so no tokens exist there.',
  },
  {
    pattern: /^#1ab4d7$/i,
    reason: 'Xero brand blue on the Xero connection pill and button, per the Xero brand guidelines.',
  },
  {
    path: TOKEN_FILE,
    pattern: /^#000$/,
    reason: 'mask-image gradient stops: a mask reads alpha/luminance, so this is not a visible colour.',
  },
];

// From the CSS Color Module Level 4 named-colour list. "transparent", "currentColor" and the CSS-wide
// keywords are not literal colours and are not listed.
const NAMED_COLOURS =
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(
    ' ',
  );

// Style properties whose values are colours. A named colour counts only in one of these, so prose such as
// "the red flag" or a variable called `white` is not a hit.
const COLOUR_PROPS =
  /(?:^|[\s;{'"`,(])(?:color|background(?:-color|Color)?|border(?:-[a-z]+)*(?:Color)?|outline(?:-color|Color)?|fill|stroke|box-shadow|boxShadow|text-shadow|textShadow|caret-color|accent-color|floodColor|flood-color|stop-color|stopColor)\s*[:=]\s*(?:['"`]|\{?\s*['"`])?([^;'"`}\n]*)/g;

const HEX = /(?<![\w&/.-])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])/g;
const FUNC = /\b(?:rgba?|hsla?)\((?:[^()]|\([^()]*\))*\)/g;
const NAMED = new RegExp(`(?<![\\w-])(?:${NAMED_COLOURS.join('|')})(?![\\w-])`, 'gi');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|css)$/.test(name)) out.push(full);
  }
  return out;
}

/** Remove the places a `#` run is an id, a URL or an anchor rather than a colour. */
function stripNonColourHashes(line) {
  return line
    .replace(/url\([^)]*\)/g, 'url()')
    .replace(/\b(?:href|to|id|htmlFor|aria-[a-z]+|key|name|data-[a-z-]+)=(["'`])[^"'`]*\1/g, '$1$1')
    .replace(/(?:href|to|id):\s*(["'`])[^"'`]*\1/g, '$1$1');
}

/** Lines of src/index.css that are token definitions: `--name:` declarations inside a theme block. */
function tokenDefinitionLines(css) {
  const lines = css.split('\n');
  const defs = new Set();
  let selector = '';
  let depth = 0;
  let pending = '';
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\*.*?\*\//g, '');
    for (const ch of line) {
      if (ch === '{') {
        depth += 1;
        if (depth === 1) selector = pending.trim();
        pending = '';
      } else if (ch === '}') {
        depth -= 1;
        pending = '';
        if (depth === 0) selector = '';
      } else pending += ch;
    }
    const themeBlock = /^(?::root|html\[data-theme=)/.test(selector);
    if (depth >= 1 && themeBlock && /^\s*--[\w-]+\s*:/.test(raw)) defs.add(i + 1);
  });
  return defs;
}

function isAllowed(path, literal) {
  return ALLOW.some(
    (entry) => (!entry.path || entry.path === path) && (!entry.pattern || entry.pattern.test(literal)),
  );
}

const files = [...walk(join(ROOT, 'src')), join(ROOT, 'index.html')].map((f) => relative(ROOT, f).replace(/\\/g, '/')).sort();

const problems = [];
let allowedCount = 0;
let scanned = 0;

for (const file of files) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  scanned += 1;
  const tokenLines = file === TOKEN_FILE ? tokenDefinitionLines(text) : new Set();
  const isCss = file.endsWith('.css');
  text.split('\n').forEach((rawLine, index) => {
    const lineNo = index + 1;
    if (tokenLines.has(lineNo)) return;
    // Comments explain colours by name ("navy", "grey canvas") and are not styles.
    const line = rawLine.replace(/\/\*.*?\*\//g, '').replace(/^\s*(?:\/\/|\*|\/\*).*$/, '');
    const hits = [];
    const cleaned = stripNonColourHashes(line);
    for (const m of cleaned.matchAll(HEX)) hits.push(m[0]);
    for (const m of line.matchAll(FUNC)) hits.push(m[0]);
    // Named colours: anywhere in a CSS declaration value, or in a colour property of a style object.
    const valueSources = isCss ? [line.includes(':') ? line.slice(line.indexOf(':') + 1) : ''] : [];
    if (!isCss) for (const m of line.matchAll(COLOUR_PROPS)) valueSources.push(m[1] ?? '');
    for (const src of valueSources) {
      for (const m of src.matchAll(NAMED)) {
        // `--colour-name` custom properties and class names such as `border-gray-400` are not values.
        hits.push(m[0]);
      }
    }
    for (const literal of hits) {
      if (isAllowed(file, literal)) {
        allowedCount += 1;
        continue;
      }
      problems.push(`${file}:${lineNo}: ${literal}  ->  ${rawLine.trim().slice(0, 110)}`);
    }
  });
}

for (const entry of ALLOW) {
  if (entry.path && !files.includes(entry.path)) problems.push(`allow-list entry no longer exists: ${entry.path} (remove it)`);
}

if (problems.length > 0) {
  console.error(`Hard-coded colours (${problems.length}); use a token from ${TOKEN_FILE} or add an allow-list reason:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `Hard-coded colour check passed: ${scanned} files scanned, ${allowedCount} allow-listed literal(s) in ${ALLOW.length} rule(s), no other colour literals outside ${TOKEN_FILE} token definitions.`,
);
