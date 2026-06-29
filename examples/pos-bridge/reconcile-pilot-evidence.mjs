#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import {
  containsUnredactedSecret,
  reconcileEvidenceFieldSamples,
  redactSecrets,
  requiredFieldSampleEventTypes,
} from './field-sample-reconciliation.mjs';

async function main() {
  const args = process.argv.slice(2);
  const evidenceFile = args.shift();
  if (!evidenceFile) throw new Error(usage());

  const samplePaths = Object.fromEntries(
    requiredFieldSampleEventTypes.map((eventType) => [eventType, readOption(args, `--${eventType}`)]),
  );
  if (args.length > 0 || Object.values(samplePaths).some((value) => !value)) {
    throw new Error(usage());
  }

  const evidenceText = await readFile(evidenceFile, 'utf8');
  const evidence = JSON.parse(evidenceText);
  const reconciliation = await reconcileEvidenceFieldSamples(evidence, samplePaths);
  const failures = [...reconciliation.failures];
  if (containsUnredactedSecret(evidenceText)) failures.push('evidence file must not contain unredacted Looplet secrets');

  const result = {
    ok: failures.length === 0,
    evidence_file: evidenceFile,
    checked_at: new Date().toISOString(),
    evidence_ok_claimed: evidence?.ok === true,
    matches: reconciliation.matches,
    failures,
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function usage() {
  return 'usage: node reconcile-pilot-evidence.mjs <pos-pilot-evidence.json> --sale <field-sale.json> --refund <field-refund.json> --void <field-void.json>';
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error)),
  }, null, 2));
  process.exit(1);
});
