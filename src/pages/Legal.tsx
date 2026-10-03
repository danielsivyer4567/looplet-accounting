import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LegalLinks } from '@/components/LegalLinks';
import { LEGAL_PATHS, LEGAL_VERSIONS, SUPPORT_EMAIL } from '@/lib/legal';

/**
 * Privacy policy, terms of service and collection notice (LEGAL-01).
 *
 * These describe what this code does: Supabase hosting, read-only Gmail access for bills, the Xero
 * connection, the AI providers each feature calls, Resend email and Cloudflare hosting. They are
 * DRAFTS: a qualified legal reviewer must approve them before anyone relies on them. Details the
 * repository does not contain (legal entity, ABN, address, hosting region, retention periods,
 * governing law) are shown as visible "To be confirmed by Looplet" markers, never invented.
 */

/** A detail Looplet must supply. Rendered visibly so nobody mistakes it for the real value. */
function Tbc({ children }: { children: ReactNode }) {
  return (
    <mark
      className="legal-tbc"
      style={{
        background: 'var(--bg-warning-subtle, #fff4d6)',
        color: 'var(--text-warning, #8a5a00)',
        border: '1px dashed currentColor',
        borderRadius: '4px',
        padding: '0 0.3rem',
        fontWeight: 600,
      }}
    >
      [To be confirmed by Looplet: {children}]
    </mark>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: '0.5rem' }}>
      <h2 style={{ margin: '1rem 0 0', fontSize: '1.1rem' }}>{title}</h2>
      {children}
    </section>
  );
}

function LegalDocument({
  title,
  version,
  children,
}: {
  title: string;
  version: string;
  children: ReactNode;
}) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-app)', color: 'var(--text-body)' }}>
      <main
        style={{
          maxWidth: '760px',
          margin: '0 auto',
          padding: '2rem 1rem 3rem',
          display: 'grid',
          gap: '0.75rem',
          lineHeight: 1.6,
          fontSize: '0.95rem',
        }}
      >
        <Link to="/" style={{ color: 'var(--text-link)', fontSize: '0.85rem' }}>
          ← Back to Looplet Accounting
        </Link>
        <h1 style={{ margin: '0.5rem 0 0' }}>{title}</h1>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Version {version}
        </p>
        <div
          role="note"
          aria-label="Draft notice"
          style={{
            padding: '0.75rem 1rem',
            border: '1px solid var(--accent-warning, #d99a00)',
            borderRadius: 'var(--radius-sm, 6px)',
            background: 'var(--bg-warning-subtle, #fff8e6)',
          }}
        >
          <strong>Draft awaiting legal review.</strong> Looplet has written this document to match
          how the app works today, but a qualified lawyer has not yet reviewed it. Text marked “To
          be confirmed by Looplet” is information Looplet still has to supply.
        </div>
        {children}
        <hr style={{ margin: '2rem 0 1rem', borderColor: 'var(--border-subtle)' }} />
        <LegalLinks />
      </main>
    </div>
  );
}

function SupportEmail() {
  return <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;
}

function WhoWeAre() {
  return (
    <p>
      Looplet Accounting (“Looplet”, “we”, “us”) is provided by <Tbc>legal entity name</Tbc> (ABN{' '}
      <Tbc>ABN</Tbc>) of <Tbc>business address</Tbc>. Contact us at <SupportEmail />. Our privacy
      contact is <Tbc>privacy officer name or role, and phone number</Tbc>.
    </p>
  );
}

const SERVICE_PROVIDERS: { name: string; what: string }[] = [
  {
    name: 'Supabase',
    what: 'Hosts the database, file storage (your bills, receipts and other uploads), sign-in and the server functions that run the app. All of your books are stored here.',
  },
  {
    name: 'Cloudflare',
    what: 'Hosts and delivers the web app (and the PDF viewer script, from Cloudflare’s cdnjs). It handles your connection details, such as IP address, when you use the app.',
  },
  {
    name: 'Google',
    what: 'Sign-in with Google, if you use it, and read-only Gmail access, if you connect a mailbox (see “Gmail” below).',
  },
  {
    name: 'Xero',
    what: 'Only if you connect Xero. We send bills, invoices, contacts, payments and attachments to your Xero organisation and read its accounts, bank transactions, payments and reports.',
  },
  {
    name: 'Redbark (bank-data provider)',
    what: 'Only if you connect a bank feed: account details and transactions for the accounts you choose.',
  },
  {
    name: 'MiniMax, Anthropic, OpenAI and Groq (document reading)',
    what: 'Read uploaded or emailed bills, receipts and bank statements to pull out the supplier, dates, amounts, GST and line items. One provider is used at a time, set by Looplet.',
  },
  {
    name: 'Groq',
    what: 'Writes Ask AI answers (with your question, a summary of your business profile and the figures from your books that the question needs), decides which email senders are suppliers or customers (sender names, email domains and a few subject lines), and reads emailed requests from accountants.',
  },
  {
    name: 'MiniMax',
    what: 'Suggests categories for bank transactions (descriptions and amounts).',
  },
  {
    name: 'Perplexity',
    what: 'Researches Australian tax rules for Ask AI and advisor notes (your question and a summary of your business profile), looks up public details of suppliers and customers by name, and tracks upcoming law changes.',
  },
  {
    name: 'OpenAI (search)',
    what: 'Turns Ask AI questions into search vectors to find the relevant law in our legal library.',
  },
  {
    name: 'Resend',
    what: 'Sends emails from Looplet, such as activity summaries for accountants and replies to accountants’ email requests.',
  },
];

function ServiceProviderList() {
  return (
    <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: '0.35rem' }}>
      {SERVICE_PROVIDERS.map((provider) => (
        <li key={provider.name}>
          <strong>{provider.name}</strong>: {provider.what}
        </li>
      ))}
    </ul>
  );
}

function OverseasDisclosure() {
  return (
    <p>
      Most of these providers are based outside Australia or process data overseas, so your
      information is likely to be disclosed to overseas recipients. The countries involved are{' '}
      <Tbc>the countries for each provider, and the Supabase hosting region</Tbc>.
    </p>
  );
}

export function PrivacyPolicyPage() {
  return (
    <LegalDocument title="Privacy policy" version={LEGAL_VERSIONS.privacy}>
      <Section title="Who we are">
        <WhoWeAre />
        <p>
          This policy explains how we handle personal information in Looplet Accounting, in line
          with the Australian Privacy Principles (APPs) in the Privacy Act 1988 (Cth). Tax file
          numbers are also handled under the Privacy (Tax File Number) Rule 2015.
        </p>
      </Section>

      <Section title="What we collect">
        <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: '0.35rem' }}>
          <li>
            <strong>Your account</strong>: email address and password (handled by our sign-in
            provider; we do not see your password). If you sign in with Google, the name, email
            address and profile picture on your Google account.
          </li>
          <li>
            <strong>Your business</strong>: business name, ABN, GST and other tax registrations,
            entity type, state, turnover range, vehicles and business-use percentages, and your
            other business profile answers.
          </li>
          <li>
            <strong>Your books</strong>: bills, receipts, invoices, credit notes, jobs, customers
            and suppliers (names, email addresses, ABNs, phone numbers and addresses), bank
            transactions, bank account details including BSB and account numbers for payment runs,
            journals, BAS and tax figures, assets, subscriptions, notes, tags and files you upload.
          </li>
          <li>
            <strong>Payroll</strong>, if you use it: employees’ names and contact details, pay
            rates, hours, pay slips, leave, superannuation fund details (fund, USI and member
            number) and tax file numbers. Employee TFNs are stored encrypted.
          </li>
          <li>
            <strong>Trusts and SMSFs</strong>, if you use those features: trustee, beneficiary and
            member details, which can include tax file numbers.
          </li>
          <li>
            <strong>Receipts</strong> captured in Receipt Hub: merchant, items, totals, GST, payment
            method and the last four digits of the card used. Receipt passes are stored only as a
            one-way hash.
          </li>
          <li>
            <strong>Email</strong>, if you connect Gmail: see “Gmail” below.
          </li>
          <li>
            <strong>Ask AI and advisor notes</strong>: questions you ask are sent to AI providers to
            write an answer but are not saved in your books; advisor notes you create are saved.
          </li>
          <li>
            <strong>Accountant activity</strong>: if you work in a client’s books as their
            accountant, we record the pages you view, time on each page and actions you take, and
            may email a summary to the business.
          </li>
          <li>
            <strong>Technical information</strong>: sign-in and security records, a log of changes
            made in your books, a log of requests to our receipt and data interfaces, and the IP
            address and device details that our hosting providers log. Your browser keeps your
            sign-in session, chosen organisation and display settings in local storage. We do not
            use advertising or social-media tracking.
          </li>
        </ul>
      </Section>

      <Section title="How we collect it">
        <p>
          From you; from people you add to your organisation, including your accountant; from
          services you choose to connect (Google, Xero, your bank-data provider, and point-of-sale
          systems that send us receipts); and automatically when you use the app.
        </p>
      </Section>

      <Section title="Why we use it">
        <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: '0.35rem' }}>
          <li>
            To provide the accounting service: keep and organise your records, read bills and
            receipts, suggest categories, match bank transactions, sync with Xero, and prepare BAS,
            payroll, super and other files for you to review. Looplet does not lodge anything with
            the ATO and does not pay super funds; you or your registered agent do that.
          </li>
          <li>
            To answer Ask AI questions and create advisor notes. These are general information, not
            tax, financial or legal advice.
          </li>
          <li>To keep the service secure, fix problems and keep audit records.</li>
          <li>
            To contact you about your account. We send product news only if you turn it on in
            Settings → Notifications.
          </li>
          <li>To meet our legal obligations.</li>
        </ul>
        <p>We do not sell personal information and do not use it for advertising.</p>
      </Section>

      <Section title="Gmail">
        <p>
          If you connect a Gmail account, Looplet asks Google for read-only access to that mailbox
          (the gmail.readonly permission). We use it only to bring your bills into Looplet and to
          help set up your supplier and customer lists:
        </p>
        <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: '0.35rem' }}>
          <li>
            We search for emails that look like bills or invoices, read their sender, subject, date
            and, where needed, body text, and download attachments such as PDF invoices. Each bill
            found is saved to your Looplet organisation and read by our document-reading AI provider
            to pull out the amounts.
          </li>
          <li>
            To suggest suppliers and customers, we look at who emails you. Sender names, email
            domains and a few subject lines are sent to Groq to classify them, and business names
            may be looked up with Perplexity.
          </li>
          <li>
            We never send, change or delete anything in your mailbox. We do not use Gmail data for
            advertising, do not sell it and do not use it to train AI models. People at Looplet do
            not read your email unless you ask us to, it is needed for security, or the law requires
            it.
          </li>
          <li>
            Looplet’s use and transfer of information received from Google APIs adheres to the{' '}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noreferrer"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </li>
          <li>
            You can disconnect Gmail in Settings. That stops Looplet reading the mailbox; bills
            already imported stay in your books. The stored Google access token is kept but no
            longer used (<Tbc>whether stored Gmail tokens are deleted on disconnect</Tbc>). You can
            also remove Looplet’s access from your Google Account at any time.
          </li>
        </ul>
      </Section>

      <Section title="Who we share it with">
        <p>
          We share personal information only with the people you give access to your organisation
          (team members and your accountant) and with the service providers below, which handle it
          for us to run the features described.
        </p>
        <ServiceProviderList />
        <p>
          We may also disclose information where the law requires it. Looplet does not send your
          information to the ATO.
        </p>
        <OverseasDisclosure />
      </Section>

      <Section title="How we keep it safe">
        <p>
          Each organisation’s records are kept separate by database access rules, so only people
          given access to an organisation can see its books. Employee tax file numbers entered for
          payroll, and the access tokens for Gmail and Xero, are stored encrypted. API keys and
          receipt passes are stored only as one-way hashes. No system is completely secure; if a
          data breach is likely to cause serious harm, we will tell you and the Office of the
          Australian Information Commissioner (OAIC) as the law requires.
        </p>
      </Section>

      <Section title="How long we keep it, and deletion">
        <p>
          We keep your information while your account is open. Most records you delete in the app
          are hidden rather than erased straight away. There is not yet a way to close your account
          or erase your data yourself: email <SupportEmail /> and we will delete or de-identify it,
          except what we must keep by law. Our retention periods are{' '}
          <Tbc>retention periods for account data, backups and logs after an account closes</Tbc>.
        </p>
        <p>
          Your business generally has to keep its own tax records for 5 years (
          <a
            href="https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/record-keeping-for-business/overview-of-record-keeping-rules-for-business"
            target="_blank"
            rel="noreferrer"
          >
            ATO record keeping
          </a>
          ), so download what you need before asking us to delete it.
        </p>
      </Section>

      <Section title="Access, correction and complaints">
        <p>
          You can ask to see or correct the personal information we hold about you by emailing{' '}
          <SupportEmail />. Most of it you can view and correct in the app yourself. We will respond
          within a reasonable time and tell you if we can’t give access and why.
        </p>
        <p>
          If you have a privacy complaint, email us first and we will investigate and reply. If we
          don’t respond within 30 days or you are not satisfied, you can complain to the OAIC at{' '}
          <a href="https://www.oaic.gov.au" target="_blank" rel="noreferrer">
            oaic.gov.au
          </a>{' '}
          or on 1300 363 992.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          We will post changes here with a new version date and, for significant changes, tell you
          in the app or by email.
        </p>
      </Section>
    </LegalDocument>
  );
}

export function CollectionNoticePage() {
  return (
    <LegalDocument title="Collection notice" version={LEGAL_VERSIONS.collectionNotice}>
      <p>
        This notice tells you, at the point we collect your personal information, what you need to
        know under Australian Privacy Principle 5. Our{' '}
        <Link to={LEGAL_PATHS.privacy}>privacy policy</Link> has the detail.
      </p>
      <Section title="Who is collecting it">
        <WhoWeAre />
      </Section>
      <Section title="What we collect and how">
        <p>
          Your account details, your business’s details and books, and any payroll, email, bank or
          Xero information from services you choose to connect. We collect it from you, from people
          you give access to your organisation, from those connected services, and automatically
          when you use the app.
        </p>
      </Section>
      <Section title="Why">
        <p>
          To provide the accounting service: keep your records, read bills and receipts, match
          transactions and prepare BAS, payroll and super files for you to review and lodge, answer
          Ask AI questions with general information, keep the service secure, and meet our legal
          obligations. We contact you about your account, and send product news only if you opt in.
        </p>
      </Section>
      <Section title="If you don’t provide it">
        <p>
          We need an email address to create your account. Without your business and financial
          records, the app can’t keep your books. Connecting Gmail, Xero or a bank feed is optional;
          without them you upload bills and transactions yourself.
        </p>
      </Section>
      <Section title="Laws that require or authorise it">
        <p>
          Australian tax and superannuation laws require employers to collect some employee
          information, such as tax file numbers, for payroll. Looplet stores what you enter so that
          you can meet those obligations.
        </p>
      </Section>
      <Section title="Who we disclose it to">
        <p>
          People you give access to your organisation, and the service providers that run Looplet’s
          features:
        </p>
        <ServiceProviderList />
        <OverseasDisclosure />
      </Section>
      <Section title="Access, correction and complaints">
        <p>
          Our <Link to={LEGAL_PATHS.privacy}>privacy policy</Link> explains how to see or correct
          your information and how to complain, including to the OAIC.
        </p>
      </Section>
    </LegalDocument>
  );
}

export function TermsOfServicePage() {
  return (
    <LegalDocument title="Terms of service" version={LEGAL_VERSIONS.terms}>
      <Section title="Who you are dealing with">
        <WhoWeAre />
        <p>
          These terms apply when you create an account or use Looplet Accounting. By creating an
          account you agree to them.
        </p>
      </Section>

      <Section title="What Looplet does, and doesn’t do">
        <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: '0.35rem' }}>
          <li>
            Looplet is bookkeeping software. It keeps your records, reads bills and receipts,
            suggests categories and matches, and prepares BAS, payroll, super and other files and
            figures for you to review.
          </li>
          <li>
            Looplet does not lodge anything with the ATO and does not pay or send super
            contributions to funds. You, or your registered tax or BAS agent, lodge and pay.
          </li>
          <li>
            Looplet is not a registered tax agent or BAS agent. Ask AI answers, advisor notes and
            automated suggestions are general information, not tax, financial or legal advice, and
            can be wrong. Check them, and get advice from a registered tax agent or BAS agent before
            relying on them for your circumstances.
          </li>
          <li>
            Automated readings of documents (amounts, GST, suppliers) can be wrong. You are
            responsible for checking figures before you use them in a BAS, return or payment.
          </li>
        </ul>
      </Section>

      <Section title="Your responsibilities">
        <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: '0.35rem' }}>
          <li>Give accurate information and keep your sign-in details secure.</li>
          <li>
            Only connect mailboxes, bank accounts and Xero organisations that you are authorised to
            connect, and only add people who should see your books.
          </li>
          <li>
            Have the right to give us the personal information you enter about others (for example
            employees, customers and suppliers), including telling them how it will be handled.
          </li>
          <li>Keep your own records as tax law requires, and meet your lodgement deadlines.</li>
          <li>
            Don’t misuse the service, attempt to access other organisations’ data, or break the law.
          </li>
        </ul>
      </Section>

      <Section title="Your data">
        <p>
          Your business records belong to you. You let us store and process them to provide the
          service, as described in our <Link to={LEGAL_PATHS.privacy}>privacy policy</Link>. You can
          ask us for a copy or for deletion by emailing <SupportEmail />.
        </p>
      </Section>

      <Section title="Connected services">
        <p>
          Google, Xero, bank-data providers and other services you connect have their own terms. We
          are not responsible for their services, and a connection may stop working if they change
          or withdraw access.
        </p>
      </Section>

      <Section title="Fees">
        <p>
          <Tbc>pricing, billing, refunds and free trial terms</Tbc>.
        </p>
      </Section>

      <Section title="Availability and changes">
        <p>
          We work to keep Looplet available and accurate, but it may sometimes be unavailable or
          contain errors. We may change features. We will give notice of changes to these terms in
          the app or by email.
        </p>
      </Section>

      <Section title="Australian Consumer Law">
        <p>
          Nothing in these terms excludes, restricts or modifies any right or remedy you have under
          the Australian Consumer Law that cannot lawfully be excluded. Subject to that,{' '}
          <Tbc>limitation of liability wording approved by Looplet’s lawyer</Tbc>.
        </p>
      </Section>

      <Section title="Ending your account">
        <p>
          You can stop using Looplet at any time and ask us to close your account. We may suspend or
          close an account that breaches these terms, after notice where reasonable.
        </p>
      </Section>

      <Section title="Governing law">
        <p>
          These terms are governed by the laws of <Tbc>Australian state or territory</Tbc>.
        </p>
      </Section>
    </LegalDocument>
  );
}
