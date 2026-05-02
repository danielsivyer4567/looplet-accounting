/**
 * Heuristic classifier for Gmail entity mining. Maps a sender (domain + name +
 * email) to a predicted (kind, category, display_name, confidence). Built for
 * Australian trades businesses — the supplier list is AU-biased.
 *
 * Confidence guide:
 *   1.0  exact known-supplier match (definitive)
 *   0.9  domain matches a known brand
 *   0.7  pattern matches a consumer brand → likely personal
 *   0.5  free-mail (gmail.com etc.) — needs body context
 *   0.0  no signal
 *
 * Categories follow `intake_categories.code` from migration 0012.
 */

export type EntityKind =
  | 'supplier'
  | 'contractor'
  | 'customer'
  | 'personal'
  | 'subscription'
  | 'internal_admin'
  | 'unknown';

export interface ClassifyInput {
  sender_address: string;       // sales@bunnings.com.au
  sender_domain: string;        // bunnings.com.au
  sender_name?: string | null;  // "Bunnings Group"
  recent_subjects?: string[];
  is_outbound?: boolean;        // came from SENT folder; suggests customer
}

export interface ClassifyResult {
  kind: EntityKind;
  category: string | null;       // intake_categories.code
  display_name: string;          // canonical brand label
  confidence: number;            // 0..1
  reason: string;                // one-line explanation for the triage UI
  supplier_canonical?: string;   // if matched, the canonical supplier name
}

/**
 * Known AU trades supplier and contractor domains. The category here is the
 * intake_categories.code; the brand is the canonical display name we want to
 * show in triage and use as the supplier label when the user approves.
 */
const KNOWN_TRADE_SUPPLIERS: Record<string, { brand: string; category: string }> = {
  // Materials / hardware
  'bunnings.com.au':         { brand: 'Bunnings',           category: 'materials' },
  'reece.com.au':            { brand: 'Reece',              category: 'materials' },
  'mitre10.com.au':          { brand: 'Mitre 10',           category: 'materials' },
  'totaltools.com.au':       { brand: 'Total Tools',        category: 'plant_equipment' },
  'sydneytools.com.au':      { brand: 'Sydney Tools',       category: 'plant_equipment' },
  'masters.com.au':          { brand: 'Masters',            category: 'materials' },
  'bowens.com.au':           { brand: 'Bowens',             category: 'materials' },
  'tradelink.com.au':        { brand: 'Tradelink',          category: 'materials' },
  'plumbingplus.com.au':     { brand: 'Plumbing Plus',      category: 'materials' },
  'metcash.com':             { brand: 'Metcash',            category: 'materials' },
  // Fencing-specific (AFGC-relevant)
  'paulwynnfencing.com.au':  { brand: 'Paul Wynn Fencing',  category: 'materials' },
  'finchfencing.com.au':     { brand: 'Finch Fencing',      category: 'materials' },
  'colourbond.com.au':       { brand: 'Colorbond',          category: 'materials' },
  'gramline.com.au':         { brand: 'Gramline',           category: 'materials' },
  // Plant / hire
  'kennards.com.au':         { brand: 'Kennards Hire',      category: 'plant_equipment' },
  'coates.com.au':           { brand: 'Coates Hire',        category: 'plant_equipment' },
  'onsiterentals.com.au':    { brand: 'Onsite Rentals',     category: 'plant_equipment' },
  // Fuel / fleet
  'shellbusiness.com.au':    { brand: 'Shell Business',     category: 'fuel' },
  'bp.com.au':               { brand: 'BP',                 category: 'fuel' },
  'ampol.com.au':            { brand: 'Ampol',              category: 'fuel' },
  'caltex.com.au':           { brand: 'Caltex',             category: 'fuel' },
  '7eleven.com.au':          { brand: '7-Eleven',           category: 'fuel' },
  // Telco / internet
  'telstra.com':             { brand: 'Telstra',            category: 'telephone_internet' },
  'telstra.com.au':          { brand: 'Telstra',            category: 'telephone_internet' },
  'optus.com.au':            { brand: 'Optus',              category: 'telephone_internet' },
  'vodafone.com.au':         { brand: 'Vodafone',           category: 'telephone_internet' },
  'aussiebroadband.com.au':  { brand: 'Aussie Broadband',   category: 'telephone_internet' },
  'tpg.com.au':              { brand: 'TPG',                category: 'telephone_internet' },
  // Utilities
  'agl.com.au':              { brand: 'AGL',                category: 'utilities' },
  'energyaustralia.com.au':  { brand: 'Energy Australia',   category: 'utilities' },
  'origin.com.au':           { brand: 'Origin Energy',      category: 'utilities' },
  'red-energy.com.au':       { brand: 'Red Energy',         category: 'utilities' },
  // Insurance
  'aami.com.au':             { brand: 'AAMI',               category: 'insurance' },
  'allianz.com.au':          { brand: 'Allianz',            category: 'insurance' },
  'qbe.com':                 { brand: 'QBE',                category: 'insurance' },
  'suncorp.com.au':          { brand: 'Suncorp',            category: 'insurance' },
  'racq.com.au':             { brand: 'RACQ',               category: 'insurance' },
};

/**
 * Domains that indicate a SaaS / business subscription. These default to
 * subscriptions_saas category.
 */
const BUSINESS_SAAS: Record<string, string> = {
  'xero.com':                'Xero',
  'servicem8.com':           'ServiceM8',
  'simpro.com.au':           'simPRO',
  'tradify.com':             'Tradify',
  'fergus.com':              'Fergus',
  'workflowmax.com':         'WorkflowMax',
  'microsoft.com':           'Microsoft 365',
  'office.com':              'Microsoft 365',
  'google.com':              'Google',
  'workspace.google.com':    'Google Workspace',
  'adobe.com':               'Adobe',
  'canva.com':               'Canva',
  'github.com':              'GitHub',
  'gitlab.com':              'GitLab',
  'zoom.us':                 'Zoom',
  'slack.com':               'Slack',
  'notion.so':               'Notion',
  'dropbox.com':             'Dropbox',
  'mailchimp.com':           'Mailchimp',
  'intuit.com':              'Intuit / QuickBooks',
  'mailerlite.com':          'MailerLite',
};

/**
 * Domains that indicate a personal / consumer transaction. Auto Setup will
 * predict `personal_expense` (excluded from Xero push) but the user can override.
 */
const PERSONAL_BRANDS: Record<string, string> = {
  'netflix.com':             'Netflix',
  'spotify.com':             'Spotify',
  'apple.com':               'Apple',
  'itunes.com':              'iTunes',
  'amazon.com.au':           'Amazon',
  'amazon.com':              'Amazon',
  'ebay.com.au':             'eBay',
  'woolworths.com.au':       'Woolworths',
  'coles.com.au':            'Coles',
  'aldi.com.au':             'Aldi',
  'iga.com.au':              'IGA',
  'uber.com':                'Uber',
  'ubereats.com':            'Uber Eats',
  'menulog.com.au':          'Menulog',
  'doordash.com':            'DoorDash',
  'airbnb.com':              'Airbnb',
  'booking.com':             'Booking.com',
  'expedia.com.au':          'Expedia',
  'qantas.com':              'Qantas',
  'jetstar.com':             'Jetstar',
  'virginaustralia.com':     'Virgin Australia',
  'paypal.com':              'PayPal',
  'kogan.com':               'Kogan',
  'jbhifi.com.au':           'JB Hi-Fi',
  'thegoodguys.com.au':      'The Good Guys',
  'harveynorman.com.au':     'Harvey Norman',
  'bigw.com.au':             'Big W',
  'kmart.com.au':            'Kmart',
  'target.com.au':           'Target',
};

/**
 * Internal admin / government — always business but never a "supplier" in the
 * normal sense. Maps to ato_bas_super or a similar category.
 */
const INTERNAL_ADMIN: Record<string, { brand: string; category: string }> = {
  'ato.gov.au':              { brand: 'ATO',               category: 'ato_bas_super' },
  'mygov.gov.au':            { brand: 'myGov',             category: 'ato_bas_super' },
  'asic.gov.au':             { brand: 'ASIC',              category: 'professional_fees' },
  'fairwork.gov.au':         { brand: 'Fair Work',         category: 'professional_fees' },
  'austrac.gov.au':          { brand: 'AUSTRAC',           category: 'professional_fees' },
  'qbcc.qld.gov.au':         { brand: 'QBCC',              category: 'training' },
  'business.gov.au':         { brand: 'business.gov.au',   category: 'professional_fees' },
  'workersafe.qld.gov.au':   { brand: 'WorkSafe Qld',      category: 'insurance' },
};

/** Free-mail providers — no signal from the domain itself. */
const FREE_MAIL = new Set([
  'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'yahoo.com.au',
  'icloud.com', 'me.com', 'live.com', 'live.com.au', 'msn.com',
  'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'tpg.com.au', 'iinet.net.au',
]);

/** Subject keywords that hint at customer/quote/invoice context. */
const CUSTOMER_HINT_KEYWORDS = [
  'quote', 'estimate', 'invoice from', 'your invoice', 'your quote',
  'thank you for your enquiry', 'job request',
];

/** Subject keywords that hint at supplier/receipt context. */
const SUPPLIER_HINT_KEYWORDS = [
  'invoice', 'receipt', 'tax invoice', 'order confirmation',
  'payment received', 'delivery', 'docket',
];

/** Subject keywords that hint at subscription/recurring context. */
const SUBSCRIPTION_HINT_KEYWORDS = [
  'subscription', 'monthly', 'recurring', 'auto-renew', 'renewal',
];

/** The classifier. */
export function classifyEntity(input: ClassifyInput): ClassifyResult {
  const domain = input.sender_domain.toLowerCase();
  const subjects = (input.recent_subjects ?? []).map((s) => s.toLowerCase());
  const subjectsBlob = subjects.join(' | ');
  const senderName = (input.sender_name ?? '').trim();

  // 1. Known trade supplier — strongest signal
  if (KNOWN_TRADE_SUPPLIERS[domain]) {
    const m = KNOWN_TRADE_SUPPLIERS[domain]!;
    return {
      kind: 'supplier',
      category: m.category,
      display_name: m.brand,
      confidence: 1.0,
      reason: `Domain ${domain} is a known AU trade supplier (${m.brand})`,
      supplier_canonical: m.brand,
    };
  }

  // 2. Internal admin / government
  if (INTERNAL_ADMIN[domain]) {
    const m = INTERNAL_ADMIN[domain]!;
    return {
      kind: 'internal_admin',
      category: m.category,
      display_name: m.brand,
      confidence: 1.0,
      reason: `Domain ${domain} is government / internal admin (${m.brand})`,
    };
  }

  // 3. Business SaaS subscription
  if (BUSINESS_SAAS[domain]) {
    return {
      kind: 'subscription',
      category: 'subscriptions_saas',
      display_name: BUSINESS_SAAS[domain]!,
      confidence: 0.95,
      reason: `Domain ${domain} is a known business SaaS provider`,
    };
  }

  // 4. Personal / consumer brand
  if (PERSONAL_BRANDS[domain]) {
    return {
      kind: 'personal',
      category: 'personal_expense',
      display_name: PERSONAL_BRANDS[domain]!,
      confidence: 0.9,
      reason: `Domain ${domain} is a consumer brand — predicted personal`,
    };
  }

  // 5. Outbound mail = customer (we sent them an email)
  if (input.is_outbound) {
    return {
      kind: 'customer',
      category: 'customer_payment',
      display_name: senderName || prettyFromDomain(domain),
      confidence: 0.7,
      reason: 'Found in SENT folder — likely a customer',
    };
  }

  // 6. Free-mail sender — could be contractor or personal correspondence
  if (FREE_MAIL.has(domain)) {
    if (CUSTOMER_HINT_KEYWORDS.some((k) => subjectsBlob.includes(k))) {
      return {
        kind: 'customer',
        category: 'customer_payment',
        display_name: senderName || input.sender_address,
        confidence: 0.55,
        reason: `Free-mail sender + subject hints (${pickFirstHit(subjectsBlob, CUSTOMER_HINT_KEYWORDS)})`,
      };
    }
    if (SUPPLIER_HINT_KEYWORDS.some((k) => subjectsBlob.includes(k))) {
      return {
        kind: 'contractor',
        category: 'subcontractor',
        display_name: senderName || input.sender_address,
        confidence: 0.5,
        reason: `Free-mail with invoice/receipt subject — likely a subcontractor`,
      };
    }
    return {
      kind: 'unknown',
      category: 'uncategorized',
      display_name: senderName || input.sender_address,
      confidence: 0.2,
      reason: `Free-mail sender, no clear signal — needs review`,
    };
  }

  // 7. Subject suggests a recurring/subscription billing
  if (SUBSCRIPTION_HINT_KEYWORDS.some((k) => subjectsBlob.includes(k))) {
    return {
      kind: 'subscription',
      category: 'subscriptions_saas',
      display_name: senderName || prettyFromDomain(domain),
      confidence: 0.55,
      reason: `Subject mentions subscription/renewal`,
    };
  }

  // 8. Generic supplier-ish from a business domain (.com.au, etc.)
  if (SUPPLIER_HINT_KEYWORDS.some((k) => subjectsBlob.includes(k))) {
    return {
      kind: 'supplier',
      category: 'uncategorized',
      display_name: senderName || prettyFromDomain(domain),
      confidence: 0.5,
      reason: `Business domain + invoice subject — unclassified supplier`,
    };
  }

  // 9. Fallback
  return {
    kind: 'unknown',
    category: 'uncategorized',
    display_name: senderName || prettyFromDomain(domain),
    confidence: 0.0,
    reason: 'No matching heuristic — manual review required',
  };
}

/** Convert "bunnings.com.au" → "Bunnings". */
function prettyFromDomain(domain: string): string {
  const parts = domain.split('.');
  const head = parts[0] ?? domain;
  return head.charAt(0).toUpperCase() + head.slice(1);
}

function pickFirstHit(text: string, keywords: string[]): string {
  for (const k of keywords) if (text.includes(k)) return k;
  return '';
}

/** Extract an Australian ABN from a body string (returns first match or null). */
export function extractAbn(text: string): string | null {
  if (!text) return null;
  const m = text.match(/\bABN[\s:]*(\d{2}\s?\d{3}\s?\d{3}\s?\d{3})\b/i);
  return m ? m[1]!.replace(/\s+/g, '') : null;
}

/** Extract a total amount in cents from common phrasings. Conservative; null if ambiguous. */
export function extractTotalCents(text: string): number | null {
  if (!text) return null;
  const patterns = [
    /\b(?:total|amount\s+due|grand\s+total|invoice\s+total)[\s:]*\$?\s?([\d,]+\.\d{2})\b/i,
    /\bAUD?\s*\$?\s?([\d,]+\.\d{2})\b/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const num = parseFloat(m[1]!.replace(/,/g, ''));
      if (Number.isFinite(num) && num > 0) return Math.round(num * 100);
    }
  }
  return null;
}

/** Lower-case + strip everything but the email domain. */
export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : email.toLowerCase();
}
