#!/usr/bin/env node
// Build-config integrity gate. This repo was compromised on 2026-08-08 (commit ceb0925): an obfuscated loader was
// appended to postcss.config.js, and an agent-hook pack (.cursor/), HANDOFF.md and hidden .gitignore entries were
// added. This check fails on any sign of that class of implant. It only reads tracked files and never runs them.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const SELF = 'scripts/check-build-config-integrity.mjs';
const problems = [];
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const read = (path) => readFileSync(path, 'utf8');

// 1. Known indicators of the September/August loaders, anywhere in tracked text.
const indicators = ["global.i='A10-", 'ETH_RPC_URL', 'eth_getTransactionByHash', 'eth_getBlockByNumber'];
const textual = /\.(m?[jt]sx?|cjs|json|md|ya?ml|toml|html|css|sh|ps1|bat|cmd)$/i;
for (const path of tracked) {
  if (path === SELF || !textual.test(path) || path === 'package-lock.json') continue;
  const text = read(path);
  for (const ioc of indicators) if (text.includes(ioc)) problems.push(`${path}: contains implant indicator ${JSON.stringify(ioc)}`);
}

// 2. Build configs stay small and plain: no code execution, network or very long lines.
const configs = tracked.filter((p) => /^(postcss|tailwind|vite|vitest|eslint)\.config\.(m?[jt]s|cjs)$/.test(p));
for (const path of configs) {
  const text = read(path);
  if (path.startsWith('postcss.config') && statSync(path).size > 400) problems.push(`${path}: ${statSync(path).size} bytes; a clean PostCSS config is under 400`);
  if (/\b(eval|Function)\s*\(|child_process|\bspawn\s*\(|\bexecSync\b|https?:\/\/|\brequire\s*\(\s*['"](https?|net|dns)['"]/.test(text)) problems.push(`${path}: executes code or reaches the network`);
  text.split(/\r?\n/).forEach((line, i) => { if (line.length > 300) problems.push(`${path}:${i + 1}: ${line.length}-character line`); });
}

// 3. No install-time lifecycle scripts.
const scripts = JSON.parse(read('package.json')).scripts ?? {};
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepack', 'postpack']) {
  if (scripts[hook]) problems.push(`package.json: lifecycle script "${hook}" runs on install`);
}

// 4. Agent-hook and editor auto-run surfaces added by the implant must not come back.
for (const path of tracked) {
  if (path.startsWith('.cursor/')) problems.push(`${path}: agent-hook pack (.cursor/) is tracked`);
  if (path === 'HANDOFF.md') problems.push('HANDOFF.md: agent-context injection file is tracked');
  if (path.startsWith('.githooks/')) problems.push(`${path}: repository git hooks are tracked`);
}
for (const path of tracked.filter((p) => /^\.vscode\/(tasks|settings)\.json$/.test(p))) {
  if (/folderOpen|allowAutomaticTasks/.test(read(path))) problems.push(`${path}: runs tasks automatically on folder open`);
}
const ignore = read('.gitignore');
for (const hidden of ['temp_auto_push.bat', 'temp_interactive_push.bat', 'branch_structure.json', 'kleosrules']) {
  if (ignore.includes(hidden)) problems.push(`.gitignore: hides "${hidden}"`);
}
if (/^state\/\s*$/m.test(ignore)) problems.push('.gitignore: hides "state/"');

// 5. Very long lines in tracked source (obfuscated payloads), excluding generated and data files.
for (const path of tracked.filter((p) => /\.(m?[jt]sx?|cjs)$/.test(p) && !/(^|\/)(dist|node_modules)\//.test(p) && !p.endsWith('.d.ts'))) {
  read(path).split(/\r?\n/).forEach((line, i) => { if (line.length > 2000) problems.push(`${path}:${i + 1}: ${line.length}-character line`); });
}

// 6. Font files must be fonts, not text.
const magic = { woff: 'wOFF', woff2: 'wOF2', otf: 'OTTO' };
for (const path of tracked.filter((p) => /\.(woff2?|ttf|otf|eot)$/i.test(p))) {
  const head = readFileSync(path).subarray(0, 4);
  const ext = path.split('.').pop().toLowerCase();
  const ok = magic[ext] ? head.toString('latin1') === magic[ext] : ext === 'ttf' ? head.equals(Buffer.from([0, 1, 0, 0])) || head.toString('latin1') === 'true' : true;
  if (!ok) problems.push(`${path}: not a real ${ext} font (starts with ${JSON.stringify(head.toString('latin1'))})`);
}

if (problems.length) {
  console.error(`Build-config integrity check FAILED (${problems.length}):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Build-config integrity check passed: ${tracked.length} tracked files, ${configs.length} build configs, no implant indicators.`);
