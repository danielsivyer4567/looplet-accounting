/**
 * Subject-line and sender-pattern signals for Gmail intake.
 *
 * Priority cascade for classifying an email cluster:
 *   1. lookup_known_sender (DB) — handled in gmail-mine via SQL RPC
 *   2. extractSupplierFromSubject — "Invoice INV### from X" → supplier=X
 *   3. subjectIntent — Tax Invoice / Receipt / Renewal / Donation / Promo
 *   4. senderRolePattern — invoices@ / billing@ / marketing@ / no-reply@
 *   5. ABN / total / payment-detail signals (existing in classify.ts)
 *   6. heuristic shortlist (the original KNOWN_TRADE_SUPPLIERS)
 *   7. AI classification (gmail-classify-ai)
 *   8. user manual review
 *
 * The function stays pure (no DB / network) so it can run inside the mine
 * loop with zero added latency. Each signal returns a partial classification;
 * the caller merges them with the highest-confidence one winning.
 */

export interface SubjectSignal {
  /** What the subject suggests this email is about. */
  intent:
    | 'invoice'
    | 'tax_invoice'
    | 'receipt'
    | 'order_confirmation'
    | 'statement'
    | 'subscription_renewal'
    | 'subscription_trial'
    | 'subscription_welcome'
    | 'quote_or_estimate'
    | 'work_order'
    | 'donation'
    | 'booking_confirmation'
    | 'shipping_notification'
    | 'marketing_promo'
    | 'auth_verify'
    | 'unknown';
  /** The company name extracted from "from X" or "[X]" prefix patterns, if any. */
  supplier_from_subject?: string;
  /** Best invoice/receipt number we could find in the subject (for dedup). */
  doc_number?: string;
  /** True if subject contains marketing / sale language. */
  is_marketing: boolean;
  confidence: number;
}

/**
 * Extract the canonical supplier name from a subject. Handles common AU/global
 * accounting-platform invoice subject formats:
 *
 *   "Invoice INV0269 from The Fencing Contractor Company"
 *   "Tax Invoice 12345 from ACME Pty Ltd"
 *   "Receipt for your order at Bunnings"
 *   "Bill from Chief Redwing Pty. Ltd. - 12345"
 *   "Statement from Westpac"
 *   "Quote #4567 from Reece"
 *   "[Affordable Fencing Supplies]: New order #3705"
 *   "Order confirmation - Bunnings #12345"
 *
 * Returns null if no convincing supplier name is found.
 */
export function extractSupplierFromSubject(subject: string): string | null {
  if (!subject) return null;
  const s = subject.replace(/\s+/g, ' ').trim();

  // Pattern 1: "<Doc-Type> [#]<Number> from <Company>"
  // (Most common — Xero/MYOB/QuickBooks default subject format)
  let m = s.match(
    /(?:Invoice|Tax\s+Invoice|Bill|Receipt|Statement|Quote|Estimate|Order|Purchase\s+Order|PO|Credit\s+Note)\s+(?:#|No\.?\s*|REF[\s:]*|INV[\s:#]*|TI[\s:#]*)?\d*\s*(?:from|for|by)\s+(.+?)\s*$/i,
  );
  if (m && m[1]) return cleanCompany(m[1]);

  // Pattern 2: "Receipt for your order at <Company>"
  m = s.match(
    /Receipt\s+for\s+(?:your\s+)?(?:order|purchase|payment)\s+(?:at|from|with)\s+(.+?)\s*$/i,
  );
  if (m && m[1]) return cleanCompany(m[1]);

  // Pattern 3: "[Company]: ..." — branded invoice / order
  m = s.match(/^\[([^\]]{3,80})\]\s*:?\s*(?:New\s+order|Invoice|Receipt|Quote|Tax)/i);
  if (m && m[1]) return cleanCompany(m[1]);

  // Pattern 4: "Order confirmation - Company"
  m = s.match(
    /(?:Order\s+confirmation|Order\s+received|Your\s+order|Thanks\s+for\s+your\s+order)\s*[-–—]\s*(.+?)\s*$/i,
  );
  if (m && m[1]) return cleanCompany(m[1]);

  // Pattern 5: "<Company> - Invoice|Receipt|..."
  m = s.match(
    /^([A-Z][A-Za-z0-9 .'&,\-]{2,79})\s*[-–—]\s*(?:Tax\s+Invoice|Invoice|Receipt|Statement|Quote|Bill|Order)/,
  );
  if (m && m[1]) return cleanCompany(m[1]);

  // Pattern 6: "Your <docType> from <Company>"
  m = s.match(
    /Your\s+(?:Invoice|Tax\s+Invoice|Bill|Receipt|Statement|Quote|Order)\s+(?:from|with|at)\s+(.+?)\s*$/i,
  );
  if (m && m[1]) return cleanCompany(m[1]);

  return null;
}

/**
 * Get the document number (invoice/order/quote) from a subject. Useful
 * downstream for matching to bills.
 */
export function extractDocNumber(subject: string): string | null {
  const s = subject ?? '';
  const m = s.match(/(?:Invoice|INV|Bill|Receipt|Quote|Order|PO|REF)[\s:#]*(\d{2,12})/i);
  return m ? m[1]! : null;
}

/**
 * Score the *intent* of a subject — what kind of email is this? Operates
 * only on the subject text. Returns an intent + confidence + marketing flag.
 */
export function scoreSubjectIntent(subject: string): SubjectSignal {
  const s = (subject ?? '').toLowerCase();
  if (!s) return { intent: 'unknown', is_marketing: false, confidence: 0 };

  // Marketing / promotional language (high signal)
  const marketingKeywords = [
    '% off', 'percent off', '50% off', 'sale', 'mega sale', 'flash sale',
    'limited time', 'this weekend only', 'exclusive', 'last chance',
    'huge deal', 'price drop', 'biggest sale', 'free shipping', 'spend & save',
    'clearance', 'final hours', 'don\'t miss', 'ends tonight', 'extra ',
    'unlock ', 'gift with purchase', 'redeem', 'save up to', 'lowest price',
    'special offer', 'while stocks last', 'while they last',
  ];
  const emojiHeavy = (s.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? []).length >= 2;
  const isMarketing = emojiHeavy || marketingKeywords.some((k) => s.includes(k));

  if (isMarketing) {
    return { intent: 'marketing_promo', is_marketing: true, confidence: 0.9 };
  }

  // Real-bill subject patterns (very high signal)
  if (/tax\s*invoice/.test(s)) return { intent: 'tax_invoice', is_marketing: false, confidence: 0.95 };
  if (/^(re:\s*)?invoice\s+(inv|#)?\d/.test(s)) return { intent: 'invoice', is_marketing: false, confidence: 0.9 };
  if (/^(re:\s*)?bill\s+(from|for)/.test(s)) return { intent: 'invoice', is_marketing: false, confidence: 0.85 };
  if (/^(re:\s*)?receipt\s+(for|from|#)/.test(s)) return { intent: 'receipt', is_marketing: false, confidence: 0.9 };
  if (/order\s+confirmation/.test(s)) return { intent: 'order_confirmation', is_marketing: false, confidence: 0.85 };
  if (/^(re:\s*)?statement/.test(s)) return { intent: 'statement', is_marketing: false, confidence: 0.8 };

  // Customer-side outbound signals
  if (/^(re:\s*)?quote\s+#?\d/.test(s)) return { intent: 'quote_or_estimate', is_marketing: false, confidence: 0.85 };
  if (/^(re:\s*)?estimate/.test(s)) return { intent: 'quote_or_estimate', is_marketing: false, confidence: 0.8 };
  if (/work\s+order/.test(s)) return { intent: 'work_order', is_marketing: false, confidence: 0.7 };

  // Subscription cycle
  if (/(your subscription|subscription will renew|auto[- ]renew|renewal)/.test(s)) {
    return { intent: 'subscription_renewal', is_marketing: false, confidence: 0.8 };
  }
  if (/(free trial|start your trial|trial ending|trial expires)/.test(s)) {
    return { intent: 'subscription_trial', is_marketing: false, confidence: 0.75 };
  }
  if (/(welcome to|getting started with|set up your)/.test(s)) {
    return { intent: 'subscription_welcome', is_marketing: false, confidence: 0.5 };
  }

  // Donation / charity
  if (/(donation|thank you for your gift|tax.deductible|tax receipt for your)/.test(s)) {
    return { intent: 'donation', is_marketing: false, confidence: 0.85 };
  }

  // Travel / booking
  if (/(booking confirmation|flight confirmation|reservation|itinerary|check.in)/.test(s)) {
    return { intent: 'booking_confirmation', is_marketing: false, confidence: 0.85 };
  }

  // Shipping
  if (/(shipped|tracking number|on its way|out for delivery|delivery confirmation)/.test(s)) {
    return { intent: 'shipping_notification', is_marketing: false, confidence: 0.7 };
  }

  // Auth / verify (low intent — these are noise for invoice purposes)
  if (/(verify your|reset your password|confirm your|2fa|two.factor|sign in to)/.test(s)) {
    return { intent: 'auth_verify', is_marketing: false, confidence: 0.7 };
  }

  return { intent: 'unknown', is_marketing: false, confidence: 0 };
}

/**
 * What does the local-part (before @) of the sender address say about the
 * email's purpose? "invoices@example.com" is a transactional sender;
 * "marketing@example.com" is promo.
 */
export function senderRolePattern(email: string): {
  role: 'invoice' | 'support' | 'marketing' | 'system' | 'unknown';
  confidence: number;
} {
  const local = (email ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (!local) return { role: 'unknown', confidence: 0 };

  const invoiceLocals = [
    'invoice', 'invoices', 'billing', 'bills', 'accounts', 'accounting',
    'payments', 'finance', 'ar', 'ap', 'receipts', 'orders',
  ];
  const marketingLocals = [
    'marketing', 'promo', 'promotions', 'deals', 'insider', 'subscribers',
    'edm', 'news', 'newsletter', 'updates', 'campaigns', 'mail', 'hello',
    'community', 'team', 'announcements',
  ];
  const systemLocals = [
    'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon',
    'postmaster', 'bounces', 'system', 'auto', 'auto-reply',
  ];
  const supportLocals = [
    'support', 'help', 'service', 'customercare', 'customerservice', 'info',
  ];

  for (const k of invoiceLocals) if (local === k || local.startsWith(k + '.') || local.startsWith(k + '+')) {
    return { role: 'invoice', confidence: 0.85 };
  }
  for (const k of marketingLocals) if (local === k || local.startsWith(k + '.')) {
    return { role: 'marketing', confidence: 0.7 };
  }
  for (const k of systemLocals) if (local === k || local.startsWith(k + '.')) {
    return { role: 'system', confidence: 0.4 };
  }
  for (const k of supportLocals) if (local === k || local.startsWith(k + '.')) {
    return { role: 'support', confidence: 0.5 };
  }
  return { role: 'unknown', confidence: 0 };
}

/** Best supplier name across all sample subjects. */
export function bestSupplierFromSubjects(subjects: string[]): string | null {
  for (const s of subjects ?? []) {
    const v = extractSupplierFromSubject(s);
    if (v) return v;
  }
  return null;
}

/** Best subject intent across samples (highest confidence wins). */
export function bestSubjectIntent(subjects: string[]): SubjectSignal {
  let best: SubjectSignal = { intent: 'unknown', is_marketing: false, confidence: 0 };
  for (const s of subjects ?? []) {
    const v = scoreSubjectIntent(s);
    if (v.confidence > best.confidence) best = v;
  }
  return best;
}

/** Trim and clean an extracted company name. */
function cleanCompany(raw: string): string | null {
  let v = raw
    .replace(/\s*[-–—]\s*\d+\s*$/, '')   // trailing "- 12345"
    .replace(/\s*\(.*?\)\s*$/, '')       // trailing parentheticals
    .replace(/\s*-\s*via\s.*$/i, '')     // "- via Tapi"
    .replace(/\s+#?\d+\s*$/, '')         // trailing numbers
    .replace(/\s+/g, ' ')
    .trim();
  // Strip surrounding quotes
  v = v.replace(/^["'“]|["'”]$/g, '').trim();
  if (v.length < 3 || v.length > 80) return null;
  // Reject if it's just a number or junk
  if (!/[A-Za-z]/.test(v)) return null;
  return v;
}
