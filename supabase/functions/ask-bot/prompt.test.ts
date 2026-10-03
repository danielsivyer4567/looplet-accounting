/**
 * AI-01: ask-bot answers are general information, and the model may recommend a registered tax
 * agent. The old prompts said "Never tell the user to 'consult an accountant' as a cop-out" and
 * "NEVER say 'consult your accountant' as the whole answer", while tailoring answers to the user's
 * own circumstances. Under the Tax Agent Services Act 2009, applying a taxation law to someone's
 * circumstances for them to rely on is a tax agent service, which Looplet is not registered to give.
 * https://www.tpb.gov.au/tax-agent-services
 *
 * Run: deno test --allow-env --allow-read --allow-net supabase/functions/ask-bot/prompt.test.ts
 */
import { assert, assertMatch, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  GENERAL_INFORMATION_NOTICE,
  REGISTERED_AGENT_RULE,
  sonarSystemPrompt,
  synthesisSystemPrompt,
  synthesisUserMessage,
} from './prompts.ts';

// Any instruction that stops the model suggesting professional help.
const DISCOURAGES_PROFESSIONAL_HELP =
  /\b(never|don't|do not|avoid)\b[^.\n]*\b(accountant|tax agent|bas agent|consult|professional)/i;

const prompts = {
  sonar: sonarSystemPrompt('=== BUSINESS PROFILE ===\nEntity: sole trader'),
  synthesis: synthesisSystemPrompt('CITATION POLICY:\n- cite [n] markers'),
  user: synthesisUserMessage({
    businessContext: 'Entity: company',
    question: 'Can I claim my new ute?',
    dataBlock: '',
    sonarBlock: '',
    retrievedLaw: '',
  }),
};

Deno.test('no prompt tells the model not to recommend an accountant or tax agent', () => {
  for (const [name, text] of Object.entries(prompts)) {
    assert(!DISCOURAGES_PROFESSIONAL_HELP.test(text), `${name} prompt discourages professional help`);
    assert(!/cop-out/i.test(text.replace(/is never a cop-out/i, '')), `${name} calls it a cop-out`);
  }
});

Deno.test('both answer-writing prompts tell the model to recommend a registered tax agent', () => {
  for (const text of [prompts.sonar, prompts.synthesis]) {
    assertStringIncludes(text, REGISTERED_AGENT_RULE);
    assertMatch(text, /registered tax agent/);
    assertMatch(text, /general information, not advice/i);
  }
  assertMatch(prompts.user, /confirm the position with a registered tax agent/);
});

Deno.test('the answer is framed as the general rule, not personal advice', () => {
  assert(!/TAILORED to their specific situation/.test(prompts.sonar));
  assert(!/paralegal-grade/i.test(prompts.synthesis));
  assertMatch(prompts.synthesis, /It is general information, not tax advice\./);
});

Deno.test('the general-information notice says what it is and who to ask', () => {
  assertMatch(GENERAL_INFORMATION_NOTICE, /^General information only/);
  assertMatch(GENERAL_INFORMATION_NOTICE, /not tax, financial or legal advice/);
  assertMatch(GENERAL_INFORMATION_NOTICE, /registered tax agent or BAS agent/);
});

Deno.test('ask-bot uses these prompts and returns the notice with every answer', async () => {
  const source = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  assertMatch(source, /from '\.\/prompts\.ts'/);
  assertMatch(source, /sonarSystemPrompt\(businessContext\)/);
  assertMatch(source, /synthesisSystemPrompt\(citationPolicy\)/);
  assertMatch(source, /disclaimer: GENERAL_INFORMATION_NOTICE/);
  assert(!DISCOURAGES_PROFESSIONAL_HELP.test(source), 'index.ts still discourages professional help');
  assert(!/cop-out/i.test(source));
});

Deno.test('the advisor function has no instruction against recommending an accountant', async () => {
  const source = await Deno.readTextFile(new URL('../advisor/index.ts', import.meta.url));
  assert(!DISCOURAGES_PROFESSIONAL_HELP.test(source));
  assertMatch(source, /General information only; not tax, legal, or financial advice\./);
});
